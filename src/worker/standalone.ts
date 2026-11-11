// The entry the standalone Node server bundles (scripts/build-server.mjs builds it
// to dist-server/app.mjs). It is the same Hono app as the Worker's, plus the MCP side
// of ADR-015: the OAuth provider and the MCP server, with the provider's storage in
// the server's SQLite file (scripts/server-kv.mjs).
//
// Who may approve a connection is the account system's answer (src/worker/auth/): a
// standalone server has no Cloudflare Access, so the session cookie of the passkey
// sign-in is the identity at /oauth/authorize (oauth/consent-identity.ts). A scoped
// API token works as a bearer on /mcp (mcp/api-token.ts). scripts/server.mjs sends the
// OAuth and MCP paths to createMcpFetch when MCP is on (scripts/server-mcp.mjs).
import { app } from "./app.js";
import { registerOAuthRoutes } from "./oauth/authorize.js";
import type { ConsentAuthenticator } from "./oauth/consent-identity.js";
import { OAUTH_PATHS, workerFetch } from "./oauth/provider.js";
import { hitRateLimit, hourWindow, ipKey } from "./security/ratelimit.js";
import type { Env } from "./env.js";

export { app };
export { OAUTH_PATH_RE } from "./oauth/provider.js";
export { ACCESS_TOKEN_TTL_S, REFRESH_TOKEN_TTL_S } from "./oauth/ttl.js";
registerOAuthRoutes(app);

/** Client registrations one address may make per hour: /oauth/register is open by design (RFC 7591). */
export const REGISTRATIONS_PER_HOUR = 30;

const tooMany = () =>
  new Response(JSON.stringify({ error: "temporarily_unavailable", error_description: "Too many registrations from this address. Try again later." }), {
    status: 429,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Retry-After": "3600" },
  });

/**
 * The fetch for every OAuth and MCP path of a standalone server whose public
 * origin is `origin` (FK_PUBLIC_URL). `env` carries OAUTH_KV, the SQLite adapter.
 * `authenticate` replaces the sign-in at /oauth/authorize: the server passes nothing,
 * which means the account session, and tests pass a stub of their own.
 *
 * Issuer and resource come from `origin`: a request whose URL names another
 * origin is refused, so a Host header can never move them (the server rewrites
 * every request to the public origin first; this is the second lock).
 */
export function createMcpFetch(origin: string, { authenticate }: { authenticate?: ConsentAuthenticator } = {}) {
  return async function mcpFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== origin) return new Response("Wrong origin", { status: 400 });
    // One context per request. The provider writes the grant's props onto it, so a
    // context shared between requests would hand one caller's grant to another.
    const own = { waitUntil: (p: Promise<unknown>) => ctx.waitUntil(p), passThroughOnException() {} } as unknown as ExecutionContext;
    if (request.method === "POST" && url.pathname === OAUTH_PATHS.register) {
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const hit = await hitRateLimit(env, await ipKey(env, "oauthreg", ip), hourWindow(), REGISTRATIONS_PER_HOUR);
      if (!hit.allowed) return tooMany();
    }
    return workerFetch(app, request, authenticate ? { ...env, CONSENT_AUTHENTICATOR: authenticate } : env, own, { clientIdMetadataDocuments: false });
  };
}
