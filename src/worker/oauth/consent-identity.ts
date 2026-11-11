import { verifyAccess } from "../admin/access.js";
import type { Env } from "../env.js";

// Who is signing in at /oauth/authorize (ADR-015). The consent route asks this one
// function and nothing else: a null answer means no identity, so nothing is granted.
//
// On the Worker nobody sets `env.CONSENT_AUTHENTICATOR`, so the answer is Cloudflare
// Access, as before. A standalone server sets it to its own authenticator
// (src/worker/standalone.ts). Until accounts exist (Gate 2) that authenticator has no
// identity to give, so consent refuses everyone. The account session replaces it then.
// Only code can set the binding: a process environment variable is a string.

/** The person who approved a connection. */
export interface ConsentIdentity {
  email: string;
  /** A stable id of that person at the identity provider (Access subject, account id). */
  sub: string;
}

export type ConsentAuthenticator = (request: Request, env: Env) => Promise<ConsentIdentity | null>;

export function authenticateConsent(request: Request, env: Env): Promise<ConsentIdentity | null> {
  return env.CONSENT_AUTHENTICATOR ? env.CONSENT_AUTHENTICATOR(request, env) : verifyAccess(env, request);
}

/** What the page says when no identity came: it depends on which sign-in this runtime has. */
export const SIGN_IN_REQUIRED = [
  "Sign-in required",
  "Connecting an app takes a Cloudflare Access sign-in, and this request arrived without one. The operator has to put /oauth/authorize behind the Access application of this gateway. Then start again from the app. Nothing was granted.",
] as const;

export const NO_ACCOUNTS_YET = [
  "Connecting apps is not available yet",
  "This server has no sign-in for approving a connection yet: accounts are not built. Nothing was granted.",
] as const;

export const signInRequired = (env: Env): readonly [title: string, text: string] => (env.CONSENT_AUTHENTICATOR ? NO_ACCOUNTS_YET : SIGN_IN_REQUIRED);
