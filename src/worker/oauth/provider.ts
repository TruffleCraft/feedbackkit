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

function providerFor(origin: string, app: Handler): OAuthProvider<Env> | null {
  if (providers.has(origin)) return providers.get(origin)!;
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
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: [...SCOPES],
      resourceMetadata: { resource: `${origin}/mcp`, resource_name: "FeedbackKit" },
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
  providers.set(origin, p);
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
export function workerFetch(app: Handler, request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
  const url = new URL(request.url);
  const isOauthPath = OAUTH_PATH_RE.test(url.pathname);
  if (!env.OAUTH_KV) return isOauthPath ? mcpDisabledResponse() : app.fetch(request, env, ctx);
  const provider = providerFor(url.origin, app);
  if (!provider) return isOauthPath ? mcpDisabledResponse(MCP_BAD_ORIGIN) : app.fetch(request, env, ctx);
  return provider.fetch(request, env, ctx);
}
