import { ExternalTokenError } from "@cloudflare/workers-oauth-provider";
import { lookupApiToken, TOKEN_PREFIX } from "../auth/tokens.js";
import { recordAuthFailure } from "../auth/throttle.js";
import type { Env } from "../env.js";
import { SCOPES, type AuthProps } from "./scopes.js";

// Scoped API tokens as a bearer on /mcp (ADR-015, second amendment).
//
// An owner creates a token in the admin (auth/tokens.ts): `fk_tok_` plus 256 random bits,
// stored as a SHA-256, read or write, for all projects or a list, 1 to 365 days, revocable.
// A gateway such as LiteLLM connects with `bearer_token` and has no OAuth flow to run. The
// provider's `resolveExternalToken` is the standard hook for that: it runs only for a
// bearer that is not one of the provider's own tokens, and its answer replaces the token
// check. Everything after it is the same as for an OAuth grant: the provider calls the MCP
// handler with the props below, the handler registers only the tools the scopes allow,
// and the per-grant rate limit counts per token.
//
// What this is not: the MCP authorization flow. The MCP specification asks clients to
// use tokens their authorization server issued through OAuth. This token is issued by
// this gateway itself, bound to this resource (the audience below), and never forwarded
// to another service, so it is not the token passthrough the specification forbids, but
// it is a deliberate side door and the docs say so.
//
// A token reads, whatever its access: the MCP tools are read-only, so a write token gets
// the same two scopes as a read token. A token with a project list sees only those
// projects (mcp/tools.ts filters). The token is never put in a URL, a log line or an error:
// it is read from the Authorization header by the provider, looked up by hash and dropped.

const clientAddress = (request: Request) => request.headers.get("CF-Connecting-IP") ?? "unknown";

/** The `resolveExternalToken` callback for the gateway whose MCP resource is `resource`. */
export function resolveApiToken(resource: string) {
  return async ({ token, request, env }: { token: string; request: Request; env: Env }): Promise<{ props: AuthProps; audience: string } | null> => {
    // Only our own kind of token is ours to judge; anything else is an unknown bearer and gets the plain 401.
    if (!token.startsWith(TOKEN_PREFIX)) return null;
    let found;
    try {
      found = await lookupApiToken(env, token);
    } catch {
      return null; // the accounts tables are missing (migration 0005 not applied): no token is valid
    }
    if (!found.ok) {
      // A failed attempt is counted per client address. Over the limit it is answered 429 instead of 401. A valid token is never refused for a counter.
      const failure = await recordAuthFailure(env, clientAddress(request));
      if (failure.limited) {
        throw new ExternalTokenError("temporarily_unavailable", { description: "Too many failed attempts from this address. Try again later.", statusCode: 429, headers: { "Retry-After": String(failure.retryAfter) } });
      }
      const why = { revoked: "This token was revoked.", expired: "This token has expired.", account: "The account behind this token is no longer active.", unknown: "This token is not valid." }[found.reason];
      throw new ExternalTokenError("invalid_token", { description: why, statusCode: 401 });
    }
    const t = found.token;
    return {
      audience: resource,
      props: {
        email: `token ${t.name}`,
        sub: t.accountId,
        clientId: `token:${t.id}`,
        clientName: t.name,
        scopes: [...SCOPES],
        accountId: t.accountId,
        via: "token",
        projects: t.projects,
        expiresAt: t.expiresAt,
      },
    };
  };
}
