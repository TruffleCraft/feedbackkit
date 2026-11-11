import { verifyAccess } from "../admin/access.js";
import { authenticateAccount } from "../auth/index.js";
import type { Env } from "../env.js";

// Who is signing in at /oauth/authorize (ADR-015). The consent route asks this one
// function and nothing else: a null answer means no identity, so nothing is granted.
//
// Two identities count, on both runtimes:
//   - a Cloudflare Access sign-in (the Worker, optional, S15), and
//   - an account's session cookie (the passkey sign-in of the admin, Gate 2).
// A standalone server has no Access, so there it is the account session. Any active
// account may approve a connection, member or owner, because a connection reads what
// the admin API shows them. The grant remembers the account (`accountId`), so
// removing the account ends the connection (mcp/server.ts).
//
// `env.CONSENT_AUTHENTICATOR` replaces all of it. Nothing sets it in production: it is a
// function, so no environment variable can supply it, and only test code passes one.

/** The person who approved a connection. */
export interface ConsentIdentity {
  /** Access email, or the account's name. */
  email: string;
  /** A stable id of that person (Access subject, account id). */
  sub: string;
  /** Set when an account approved: the grant then ends with the account. */
  accountId?: string;
}

export type ConsentAuthenticator = (request: Request, env: Env) => Promise<ConsentIdentity | null>;

export async function authenticateConsent(request: Request, env: Env): Promise<ConsentIdentity | null> {
  if (env.CONSENT_AUTHENTICATOR) return env.CONSENT_AUTHENTICATOR(request, env);
  const access = await verifyAccess(env, request);
  if (access) return access;
  const account = await authenticateAccount(request, env).catch(() => null);
  return account ? { email: account.name, sub: account.accountId, accountId: account.accountId } : null;
}

/** What the page says when no identity came. It names the sign-in this gateway has. */
export function signInRequired(env: Env, origin: string): readonly [title: string, text: string] {
  const access = Boolean(env["FK_ACCESS_TEAM_DOMAIN"] && env["FK_ACCESS_AUD"]);
  return [
    "Sign-in required",
    `Connecting an app takes a sign-in, and this request arrived without one. Sign in at ${origin}/admin${access ? " (with a passkey, or through Cloudflare Access)" : " with your passkey"}, then start again from the app. Nothing was granted.`,
  ];
}
