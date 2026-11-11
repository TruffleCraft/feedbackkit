// The gateway is its own OAuth 2.1 authorization server and the MCP resource
// server (ADR-015), both provided by @cloudflare/workers-oauth-provider: PKCE,
// dynamic client registration, RFC 8414/9728/8707 metadata, refresh rotation,
// hashed tokens in KV. The app owns one interactive route, /oauth/authorize
// (Access identity + consent, authorize.ts); the provider owns discovery,
// registration, token and revocation and protects /mcp.
//
// MCP is optional. Without the OAUTH_KV binding (no FK_OAUTH_KV_ID at build
// time) every OAuth and MCP path answers 404 and the rest of the gateway runs
// as before, so forks without a KV namespace still deploy.
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { resolveApiToken } from "../mcp/api-token.js";
import { mcpApi } from "../mcp/server.js";
import { SCOPES } from "../mcp/scopes.js";
import { ACCESS_TOKEN_TTL_S, REFRESH_TOKEN_TTL_S } from "./ttl.js";
import type { Env } from "../env.js";

export const OAUTH_PATHS = {
  authorize: "/oauth/authorize",
  token: "/oauth/token",
  register: "/oauth/register",
} as const;

/** Paths that belong to MCP or OAuth: /mcp, /oauth/*, /.well-known/oauth-*. */
export const OAUTH_PATH_RE = /^\/(mcp(\/|$)|oauth\/|\.well-known\/oauth-)/;

type Handler = { fetch: (request: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response> };

const MCP_DISABLED =
  "MCP is not enabled on this gateway. The operator binds a KV namespace as OAUTH_KV (build variable FK_OAUTH_KV_ID) to turn it on; see QUICKSTART.md, section MCP.";
const MCP_BAD_ORIGIN = "MCP needs https (or http on localhost). Connect through the gateway's https address.";

export function mcpDisabledResponse(description = MCP_DISABLED): Response {
  return new Response(JSON.stringify({ error: "not_found", error_description: description }), {
    status: 404,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// One provider per origin: the resource (and so every token's audience) is
// `${origin}/mcp`, and the issuer follows the origin of the token endpoint. A
// gateway on a custom domain and on workers.dev therefore issues tokens that
// only work on the host they were issued for.
const providers = new Map<string, OAuthProvider<Env> | null>();

export interface ProviderOptions {
  /**
   * Accept a client_id that is the URL of a Client ID Metadata Document (default
   * true). The provider then fetches that URL, which is only safe where fetch
   * refuses private addresses: workerd does with the `global_fetch_strictly_public`
   * flag, Node has no such thing. The standalone server turns it off, and clients
   * register through /oauth/register instead.
   */
  clientIdMetadataDocuments?: boolean;
  /**
   * Accept a scoped API token (auth/tokens.ts) as a bearer on /mcp, beside OAuth access tokens (default true;
   * mcp/api-token.ts, ADR-015 second amendment). A gateway without the accounts tables answers every such token 401.
   */
  apiTokens?: boolean;
}

function providerFor(origin: string, app: Handler, options: ProviderOptions): OAuthProvider<Env> | null {
  const cimd = options.clientIdMetadataDocuments ?? true;
  const tokens = options.apiTokens ?? true;
  const cacheKey = `${origin} cimd=${cimd} tokens=${tokens}`;
  if (providers.has(cacheKey)) return providers.get(cacheKey)!;
  let p: OAuthProvider<Env> | null;
  try {
    p = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: mcpApi as unknown as ConstructorParameters<typeof OAuthProvider<Env>>[0]["apiHandler"],
      defaultHandler: app as unknown as ConstructorParameters<typeof OAuthProvider<Env>>[0]["defaultHandler"],
      authorizeEndpoint: OAUTH_PATHS.authorize,
      tokenEndpoint: OAUTH_PATHS.token,
      // Dynamic registration stays as the fallback; Client ID Metadata Documents
      // are the MCP default and need global_fetch_strictly_public (wrangler).
      clientRegistrationEndpoint: OAUTH_PATHS.register,
      clientIdMetadataDocumentEnabled: cimd,
      scopesSupported: [...SCOPES],
      resourceMetadata: { resource: `${origin}/mcp`, resource_name: "FeedbackKit" },
      ...(tokens ? { resolveExternalToken: resolveApiToken(`${origin}/mcp`) } : {}),
      accessTokenTTL: ACCESS_TOKEN_TTL_S,
      refreshTokenTTL: REFRESH_TOKEN_TTL_S,
      onError: ({ code, description, status }) => {
        if (status >= 500) console.error(`[feedbackkit] oauth ${status} ${code}: ${description}`);
      },
    });
  } catch (e) {
    // The provider refuses a resource that is not https (or http on a loopback
    // host). Such an origin gets no MCP, but the rest of the gateway still works.
    console.warn(`[feedbackkit] MCP unavailable on ${origin}: ${(e as Error).message}`);
    p = null;
  }
  providers.set(cacheKey, p);
  return p;
}

/** Test hook: forget the cached providers. */
export function resetProviders(): void {
  providers.clear();
}

/**
 * The Worker's fetch. With OAUTH_KV bound, every request goes through the
 * provider, which answers OAuth and MCP paths and hands the rest to the app.
 * Without it, OAuth and MCP paths are 404 and the app serves everything else.
 */
export function workerFetch(app: Handler, request: Request, env: Env, ctx: ExecutionContext, options: ProviderOptions = {}): Response | Promise<Response> {
  const url = new URL(request.url);
  const isOauthPath = OAUTH_PATH_RE.test(url.pathname);
  if (!env.OAUTH_KV) return isOauthPath ? mcpDisabledResponse() : app.fetch(request, env, ctx);
  const provider = providerFor(url.origin, app, options);
  if (!provider) return isOauthPath ? mcpDisabledResponse(MCP_BAD_ORIGIN) : app.fetch(request, env, ctx);
  return provider.fetch(request, env, ctx);
}
