import type { Context } from "hono";
import { WIRE_VERSION } from "../../shared/contract.js";
import { hitRateLimit, hourWindow, ipKey } from "../security/ratelimit.js";
import { verifyAccess } from "./access.js";
import type { Env } from "../env.js";

// Failed admin logins allowed per client IP and hour before the API answers 429.
export const ADMIN_FAILED_AUTH_LIMIT = 20;

/** Who is calling the admin API: a Cloudflare Access user or a holder of ADMIN_TOKEN. */
export type AdminIdentity = { via: "access"; email: string; sub: string } | { via: "token" };

type Ctx = Context<{ Bindings: Env }>;

// Length-independent compare for the admin token (avoids leaking a match via
// early-return timing). Length itself is not treated as secret.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function tokenAuthed(c: Context): boolean {
  const token = c.env["ADMIN_TOKEN"] as string | undefined;
  if (!token) return false;
  const header = c.req.header("Authorization") ?? "";
  const m = header.match(/^Bearer\s+(.+)$/);
  return m ? safeEqual(m[1]!, token) : false;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// CSRF guard for the Access path. Access sets CF_Authorization with SameSite=None
// by default and turns that cookie into the Cf-Access-Jwt-Assertion header at the
// edge, so a cross-site form POST would arrive here with a valid Access JWT. A
// state-changing request therefore only counts as an Access sign-in when the
// browser says it came from this origin. Bearer requests need no such check:
// browsers never attach that header on their own.
export function sameOrigin(c: Context): boolean {
  if (SAFE_METHODS.has(c.req.method)) return true;
  const origin = c.req.header("Origin");
  if (origin) return origin === new URL(c.req.url).origin;
  return c.req.header("Sec-Fetch-Site") === "same-origin";
}

async function accessIdentity(c: Context): Promise<AdminIdentity | null> {
  if (!sameOrigin(c)) return null;
  const a = await verifyAccess(c.env as Env, c.req.raw);
  return a ? { via: "access", ...a } : null;
}

/**
 * True when the request carries a valid Access identity or the Bearer
 * ADMIN_TOKEN. No lockout and no counting: callers that need them use adminGate.
 */
export async function adminAuthed(c: Context): Promise<boolean> {
  return (await accessIdentity(c)) !== null || tokenAuthed(c);
}

export type AdminCheck = { ok: true; identity: AdminIdentity } | { ok: false; res: Response };

/**
 * Admin auth with the failed-attempt lockout. A valid Access identity passes
 * first: it is not a guess, so the per-IP lockout does not apply to it.
 *
 * Failed token attempts are counted per hashed client IP (`adm401` scope, hourly
 * window). Once a client has used up its failures for the hour it gets 429 for
 * every token request, even with the right token: answering 401 vs 200 after the
 * limit would leave guessing open. Successful requests are not counted.
 *
 * With `countAnonymous: false`, a request that carries no credentials at all (no
 * Authorization header, no valid Access JWT) gets a plain 401 that neither counts
 * nor reads the lockout. GET /api/admin/me uses this, because the admin UI calls
 * it on every page load.
 */
export async function adminCheck(c: Ctx, opts: { countAnonymous?: boolean } = {}): Promise<AdminCheck> {
  c.header("Cache-Control", "no-store");
  const unauthorized = () => c.json({ v: WIRE_VERSION, status: "error", error: "unauthorized" }, 401);
  const limited = () => c.json({ v: WIRE_VERSION, status: "error", error: "rate limited" }, 429);

  const access = await accessIdentity(c);
  if (access) return { ok: true, identity: access };
  if (opts.countAnonymous === false && c.req.header("Authorization") === undefined) return { ok: false, res: unauthorized() };

  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const key = await ipKey(c.env, "adm401", ip);
  if (await lockedOut(c.env, key)) return { ok: false, res: limited() };
  if (tokenAuthed(c)) return { ok: true, identity: { via: "token" } };
  const rl = await hitRateLimit(c.env, key, hourWindow(), ADMIN_FAILED_AUTH_LIMIT);
  return { ok: false, res: rl.allowed ? unauthorized() : limited() };
}

/**
 * Gate for every /api/admin/* route. Returns null when the request may proceed,
 * otherwise the 401/429 response to send.
 */
export async function adminGate(c: Ctx): Promise<Response | null> {
  const r = await adminCheck(c);
  return r.ok ? null : r.res;
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
