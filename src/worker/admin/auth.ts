import type { Context } from "hono";
import { WIRE_VERSION } from "../../shared/contract.js";
import { hitRateLimit, hourWindow, ipKey } from "../security/ratelimit.js";
import { verifyAccess } from "./access.js";
import { ownerExists, type Role } from "../auth/accounts.js";
import { timingSafeEqual } from "../auth/crypto.js";
import { CSRF_HEADER, csrfToken, csrfValid, sessionFromRequest } from "../auth/sessions.js";
import { TOKEN_PREFIX, lookupApiToken, type TokenAccess } from "../auth/tokens.js";
import { recordAuthFailure } from "../auth/throttle.js";
import type { Env } from "../env.js";

// Failed legacy-token logins allowed per client IP and hour before the API answers 429.
export const ADMIN_FAILED_AUTH_LIMIT = 20;

/**
 * Who is calling the admin API.
 *
 *   session    a person signed in with a passkey (an account, owner or member)
 *   api-token  a script or agent with a scoped API token an owner created
 *   access     a Cloudflare Access identity (Worker only, optional, S15)
 *   token      the legacy ADMIN_TOKEN, accepted only until the first owner exists (S11)
 */
export type AdminIdentity =
  | { via: "access"; email: string; sub: string }
  | { via: "token" }
  | { via: "session"; accountId: string; name: string; role: Role; sessionId: string; publicId: string; csrf: string }
  | { via: "api-token"; tokenId: string; accountId: string; access: TokenAccess; projects: string[] | null };

type Ctx = Context<{ Bindings: Env }>;

// The identity a request was authorized as, for handlers that need it (the
// account page, the audit lines). Keyed by the request object, so it cannot leak
// between requests.
const identities = new WeakMap<Request, AdminIdentity>();
export const identityOf = (c: Context): AdminIdentity | null => identities.get(c.req.raw) ?? null;

function tokenAuthed(c: Context): boolean {
  const token = c.env["ADMIN_TOKEN"] as string | undefined;
  if (!token) return false;
  const header = c.req.header("Authorization") ?? "";
  const m = header.match(/^Bearer\s+(.+)$/);
  return m ? timingSafeEqual(m[1]!, token) : false;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// CSRF guard for the Access path. Access sets CF_Authorization with SameSite=None
// by default and turns that cookie into the Cf-Access-Jwt-Assertion header at the
// edge, so a cross-site form POST would arrive here with a valid Access JWT. A
// state-changing request therefore only counts as an Access sign-in when the
// browser says it came from this origin. Bearer requests need no such check:
// browsers never attach that header on their own. A session cookie gets the same
// origin check plus the CSRF token (see auth/sessions.ts).
// `Origin: null` (an opaque origin, or a page served with Referrer-Policy:
// no-referrer posting a form) never matches, so pages that post forms here must
// not use no-referrer (see oauth/consent-headers.ts).
export function isSameOriginRequest(req: Request): boolean {
  if (SAFE_METHODS.has(req.method)) return true;
  const origin = req.headers.get("Origin");
  if (origin) return origin === new URL(req.url).origin;
  return req.headers.get("Sec-Fetch-Site") === "same-origin";
}

export function sameOrigin(c: Context): boolean {
  return isSameOriginRequest(c.req.raw);
}

async function accessIdentity(c: Context): Promise<AdminIdentity | null> {
  if (!sameOrigin(c)) return null;
  const a = await verifyAccess(c.env as Env, c.req.raw);
  return a ? { via: "access", ...a } : null;
}

const bearerOf = (c: Context): string | undefined => c.req.header("Authorization")?.match(/^Bearer\s+(.+)$/)?.[1];

/**
 * The identity of a request without counting anything and without the CSRF
 * check: for read-only callers such as the /diag deep check. API tokens count
 * only when they cover every project.
 */
export async function peekIdentity(c: Context): Promise<AdminIdentity | null> {
  const access = await accessIdentity(c);
  if (access) return access;
  const env = c.env as Env;
  const session = await sessionFromRequest(env, c.req.raw);
  if (session) return { via: "session", accountId: session.accountId, name: session.name, role: session.role, sessionId: session.sessionId, publicId: session.publicId, csrf: await csrfToken(session.token) };
  const bearer = bearerOf(c);
  if (bearer?.startsWith(TOKEN_PREFIX)) {
    const found = await lookupApiToken(env, bearer);
    return found.ok ? { via: "api-token", tokenId: found.token.id, accountId: found.token.accountId, access: found.token.access, projects: found.token.projects } : null;
  }
  if (tokenAuthed(c) && !(await ownerExists(env))) return { via: "token" };
  return null;
}

/**
 * True when the request carries a valid identity that may see everything: an
 * Access sign-in, a session, an API token without a project list, or (until the
 * first owner exists) the legacy ADMIN_TOKEN. No lockout and no counting:
 * callers that need them use adminGate.
 */
export async function adminAuthed(c: Context): Promise<boolean> {
  const id = await peekIdentity(c);
  return id !== null && !(id.via === "api-token" && id.projects !== null);
}

export type AdminCheck = { ok: true; identity: AdminIdentity } | { ok: false; res: Response };

/**
 * Admin auth. Order: a Cloudflare Access identity (not a guess, so no lockout
 * applies), a session cookie, an API token, and only if none of these is present
 * and no owner exists yet the legacy ADMIN_TOKEN.
 *
 * Failed attempts are counted and answered with 429 once a counter is over its
 * limit, but a valid credential is never refused because of a counter (see
 * auth/throttle.ts). The one exception is the legacy ADMIN_TOKEN before the first
 * owner exists: its failed attempts are counted per hashed client IP (`adm401`
 * scope, hourly window), and once a client has used up its failures for the hour
 * it gets 429 for every token request, even with the right token, as before.
 *
 * With `countAnonymous: false`, a request that carries no credentials at all (no
 * Authorization header, no valid session, no valid Access JWT) gets a plain 401
 * that neither counts nor reads the lockout. GET /api/admin/me uses this, because
 * the admin UI calls it on every page load.
 */
export async function adminCheck(c: Ctx, opts: { countAnonymous?: boolean } = {}): Promise<AdminCheck> {
  c.header("Cache-Control", "no-store");
  const unauthorized = (code?: string, error = "unauthorized") => c.json({ v: WIRE_VERSION, status: "error", error, ...(code ? { code } : {}) }, 401);
  const limited = (retryAfter?: number) => {
    if (retryAfter) c.header("Retry-After", String(retryAfter));
    return c.json({ v: WIRE_VERSION, status: "error", error: "rate limited", ...(retryAfter ? { code: "FK_AUTH_THROTTLED" } : {}) }, 429);
  };
  const result = (identity: AdminIdentity): AdminCheck => {
    identities.set(c.req.raw, identity);
    return { ok: true, identity };
  };
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";

  const access = await accessIdentity(c);
  if (access) return result(access);

  // A session. A state-changing request needs the CSRF token and a same-origin browser request on top.
  const session = await sessionFromRequest(c.env, c.req.raw);
  if (session) {
    if (!SAFE_METHODS.has(c.req.method)) {
      if (!isSameOriginRequest(c.req.raw)) return { ok: false, res: c.json({ v: WIRE_VERSION, status: "error", error: "cross-origin request refused", code: "FK_CSRF" }, 403) };
      if (!(await csrfValid(session.token, c.req.header(CSRF_HEADER)))) return { ok: false, res: c.json({ v: WIRE_VERSION, status: "error", error: "missing or wrong CSRF token", code: "FK_CSRF" }, 403) };
    }
    return result({ via: "session", accountId: session.accountId, name: session.name, role: session.role, sessionId: session.sessionId, publicId: session.publicId, csrf: await csrfToken(session.token) });
  }

  const bearer = bearerOf(c);
  if (bearer === undefined && opts.countAnonymous === false) return { ok: false, res: unauthorized() };

  // A scoped API token.
  if (bearer?.startsWith(TOKEN_PREFIX)) {
    const found = await lookupApiToken(c.env, bearer);
    if (found.ok) return result({ via: "api-token", tokenId: found.token.id, accountId: found.token.accountId, access: found.token.access, projects: found.token.projects });
    const failure = await recordAuthFailure(c.env, ip);
    if (failure.limited) return { ok: false, res: limited(failure.retryAfter) };
    const code = found.reason === "revoked" ? "FK_TOKEN_REVOKED" : found.reason === "expired" ? "FK_TOKEN_EXPIRED" : "FK_TOKEN_UNKNOWN";
    return { ok: false, res: unauthorized(code) };
  }

  // Once an owner exists, ADMIN_TOKEN grants nothing (S11). A request that presents one is counted as a failure.
  if (await ownerExists(c.env)) {
    if (bearer === undefined) return { ok: false, res: unauthorized() };
    const failure = await recordAuthFailure(c.env, ip);
    if (failure.limited) return { ok: false, res: limited(failure.retryAfter) };
    const retired = typeof c.env["ADMIN_TOKEN"] === "string" && c.env["ADMIN_TOKEN"] !== "" && timingSafeEqual(bearer, c.env["ADMIN_TOKEN"] as string);
    return { ok: false, res: retired ? unauthorized("FK_ADMIN_TOKEN_RETIRED", "ADMIN_TOKEN no longer grants access because this instance has an owner; sign in or use a scoped API token") : unauthorized() };
  }

  // No owner yet: the legacy ADMIN_TOKEN, with its per-address lockout.
  const key = await ipKey(c.env, "adm401", ip);
  if (await lockedOut(c.env, key)) return { ok: false, res: limited() };
  if (tokenAuthed(c)) return result({ via: "token" });
  const rl = await hitRateLimit(c.env, key, hourWindow(), ADMIN_FAILED_AUTH_LIMIT);
  return { ok: false, res: rl.allowed ? unauthorized() : limited() };
}

/**
 * What a route needs beyond "someone is signed in".
 *
 *   project  the project the route touches, or a resolver for it (for routes that
 *            name a report or an attachment). Without it a token that is limited
 *            to some projects is refused.
 *   list     the route lists projects and filters them itself with allowedProjects
 *   owner    only an owner's session (account and token management)
 *
 * A read-only token is refused on every state-changing method.
 */
export interface GateScope {
  project?: string | (() => Promise<string | null>);
  list?: boolean;
  owner?: boolean;
}

/** Project IDs an identity may see, or null for all of them. */
export const allowedProjects = (identity: AdminIdentity): string[] | null => (identity.via === "api-token" ? identity.projects : null);

const forbidden = (c: Ctx, code: string, error: string) => c.json({ v: WIRE_VERSION, status: "error", error, code }, 403);

/**
 * Gate for every /api/admin/* route. Returns null when the request may proceed,
 * otherwise the 401, 403 or 429 response to send.
 */
export async function adminGate(c: Ctx, scope: GateScope = {}): Promise<Response | null> {
  const r = await adminCheck(c);
  if (!r.ok) return r.res;
  const id = r.identity;
  if (scope.owner) {
    if (id.via !== "session") return forbidden(c, "FK_SESSION_REQUIRED", "Sign in with a passkey as an owner to do this. Tokens and the old admin credentials cannot.");
    if (id.role !== "owner") return forbidden(c, "FK_FORBIDDEN", "Only an owner can do this.");
  }
  if (id.via === "api-token") {
    if (!SAFE_METHODS.has(c.req.method) && id.access !== "write") return forbidden(c, "FK_TOKEN_SCOPE", "This token is read-only.");
    if (id.projects !== null && !scope.list) {
      const project = typeof scope.project === "function" ? await scope.project().catch(() => null) : scope.project;
      if (!project || !id.projects.includes(project)) return forbidden(c, "FK_TOKEN_SCOPE", "This token does not cover this project.");
    }
  }
  return null;
}

/** For the routes that only a signed-in person (not a token, not Access) can use: the account page. */
export async function sessionGate(c: Ctx): Promise<{ identity: Extract<AdminIdentity, { via: "session" }> } | { res: Response }> {
  const r = await adminCheck(c);
  if (!r.ok) return { res: r.res };
  if (r.identity.via !== "session") return { res: forbidden(c, "FK_SESSION_REQUIRED", "Sign in with a passkey to do this.") };
  return { identity: r.identity };
}

async function lockedOut(env: Env, key: string): Promise<boolean> {
  try {
    const row = await env.DB.prepare("SELECT window_start, count FROM counters WHERE key = ?1")
      .bind(key)
      .first<{ window_start: number; count: number }>();
    return !!row && Number(row.window_start) === hourWindow() && Number(row.count) >= ADMIN_FAILED_AUTH_LIMIT;
  } catch {
    return false; // fail open like hitRateLimit: the token check still applies
  }
}
