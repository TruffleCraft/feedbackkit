import { generateCookie } from "hono/cookie";
import type { Env } from "../env.js";
import type { Role } from "./accounts.js";
import { bytesToB64url, hmacSha256, randomB64url, sha256Hex, timingSafeEqual } from "./crypto.js";

// Sessions. The browser holds a random 256-bit token in a cookie; the database
// holds only its SHA-256, so a copy of the database signs nobody in. A new token
// is minted at every sign-in and enrollment and never taken from the request, so
// a session cannot be fixed in advance. Cookie attributes:
//
//   HttpOnly           script cannot read it
//   Secure + __Host-   when the public URL is https: the browser refuses it from
//                      any other origin and any path or domain override
//   SameSite=Lax       not sent on cross-site subrequests, but sent when someone
//                      follows a link to the admin or to the OAuth consent page
//                      (SameSite=Strict would show the consent page signed out)
//   Path=/, no Domain  one origin, no subdomain sharing
//   Max-Age            the absolute lifetime
//
// On plain http (localhost only, since passkeys need a secure context or
// localhost) the cookie is named fk_session without Secure: browsers differ on
// Secure cookies for http://localhost and the name prefix needs Secure.
//
// A state-changing request on a session also needs the CSRF token in the
// X-CSRF-Token header (see csrfToken) and a same-origin Origin or
// Sec-Fetch-Site, so a cross-site page that can make the browser send the
// cookie still cannot make a write.

export const SESSION_ABSOLUTE_MS = 30 * 86_400_000;
export const SESSION_IDLE_MS = 7 * 86_400_000;
const TOUCH_AFTER_MS = 10 * 60_000;
export const CSRF_HEADER = "X-CSRF-Token";
const TOKEN_PREFIX = "fk_ses_";

const SESSION_COOKIE = "fk_session";

export function sessionCookieName(request: Request): string {
  return new URL(request.url).protocol === "https:" ? `__Host-${SESSION_COOKIE}` : SESSION_COOKIE;
}

export function readSessionToken(request: Request): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  const name = sessionCookieName(request);
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      return value.startsWith(TOKEN_PREFIX) && value.length < 128 ? value : null;
    }
  }
  return null;
}

// Attribute assembly and the __Host- rules (Secure, Path=/, no Domain) are Hono's cookie helper, not code of ours.
export function sessionCookie(request: Request, token: string, maxAgeSeconds: number): string {
  const secure = new URL(request.url).protocol === "https:";
  return generateCookie(SESSION_COOKIE, token, { path: "/", httpOnly: true, secure, sameSite: "Lax", maxAge: maxAgeSeconds, ...(secure ? { prefix: "host" as const } : {}) });
}

/** Max-Age=0 with the same attributes: the browser drops the cookie. */
export function clearedSessionCookie(request: Request): string {
  return sessionCookie(request, "", 0);
}

/** HMAC of the session token. Only the holder of the cookie can compute it, and the server can recompute it on every request. */
export async function csrfToken(sessionToken: string): Promise<string> {
  return bytesToB64url(await hmacSha256(sessionToken, "fk-csrf-v1"));
}

export async function csrfValid(sessionToken: string, presented: string | null | undefined): Promise<boolean> {
  if (!presented) return false;
  return timingSafeEqual(await csrfToken(sessionToken), presented);
}

export interface NewSession {
  token: string;
  hash: string;
  publicId: string;
  expiresAt: number;
}

export async function mintSession(now = Date.now()): Promise<NewSession> {
  const token = TOKEN_PREFIX + randomB64url(32);
  return { token, hash: await sha256Hex(token), publicId: crypto.randomUUID(), expiresAt: now + SESSION_ABSOLUTE_MS };
}

const shortAgent = (ua: string | null): string | null => (ua ? ua.replace(/[\u0000-\u001f]/g, "").slice(0, 120) : null);

/**
 * The statement that stores a new session, guarded so that it inserts only while
 * `guardSql` holds. The guard's placeholders start at ?7 and take `guardParams`.
 */
export function insertSessionStatement(env: Env, s: NewSession, accountId: string, now: number, userAgent: string | null, guardSql: string, guardParams: unknown[]): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO sessions (id, public_id, account_id, created_at, last_seen_at, expires_at, user_agent)
     SELECT ?1, ?2, ?3, ?4, ?4, ?5, ?6 WHERE ${guardSql}`,
  ).bind(s.hash, s.publicId, accountId, now, s.expiresAt, shortAgent(userAgent), ...guardParams);
}

export interface SessionInfo {
  sessionId: string; // the hash: the database key
  publicId: string;
  accountId: string;
  name: string;
  role: Role;
  token: string;
}

/** The live session behind a request's cookie, or null. Reads only; see touchSession. */
export async function sessionFromRequest(env: Env, request: Request, now = Date.now()): Promise<SessionInfo | null> {
  const token = readSessionToken(request);
  if (!token) return null;
  let row: { id: string; public_id: string; account_id: string; name: string; role: Role; last_seen_at: number } | null;
  try {
    row = await env.DB.prepare(
      `SELECT s.id, s.public_id, s.account_id, s.last_seen_at, a.name, a.role
       FROM sessions s JOIN accounts a ON a.id = s.account_id
       WHERE s.id = ?1 AND s.expires_at > ?2 AND s.last_seen_at > ?3 AND a.state = 'active'`,
    )
      .bind(await sha256Hex(token), now, now - SESSION_IDLE_MS)
      .first();
  } catch {
    return null;
  }
  if (!row) return null;
  if (now - Number(row.last_seen_at) > TOUCH_AFTER_MS) {
    // Sliding idle timeout, written at most every ten minutes. A failed write never fails the request.
    await env.DB.batch([
      env.DB.prepare("UPDATE sessions SET last_seen_at = ?1 WHERE id = ?2").bind(now, row.id),
      env.DB.prepare("UPDATE accounts SET last_seen_at = ?1 WHERE id = ?2").bind(now, row.account_id),
    ]).catch(() => {});
  }
  return { sessionId: row.id, publicId: row.public_id, accountId: row.account_id, name: row.name, role: row.role, token };
}

export async function revokeSession(env: Env, sessionId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM sessions WHERE id = ?1").bind(sessionId).run();
}

export async function listSessions(env: Env, accountId: string, now = Date.now()) {
  const rows = await env.DB.prepare("SELECT id, public_id, created_at, last_seen_at, expires_at, user_agent FROM sessions WHERE account_id = ?1 AND expires_at > ?2 AND last_seen_at > ?3 ORDER BY last_seen_at DESC")
    .bind(accountId, now, now - SESSION_IDLE_MS)
    .all<{ id: string; public_id: string; created_at: number; last_seen_at: number; expires_at: number; user_agent: string | null }>();
  return (rows.results ?? []).map((r) => ({ sessionId: r.id, publicId: r.public_id, createdAt: Number(r.created_at), lastSeenAt: Number(r.last_seen_at), expiresAt: Number(r.expires_at), userAgent: r.user_agent }));
}

/**
 * The signed-in account behind a request, or null. This is the helper for code
 * outside the admin API that needs to know who is signed in, for example the
 * consent step of the MCP authorization server. It reads the session cookie and
 * nothing else: no bearer token, no Access identity, no CSRF check. A state-changing
 * step (the Allow button) must bring its own CSRF protection, for example the
 * single-use handle of the consent form, or check `csrfValid` itself.
 */
export async function authenticateAccount(request: Request, env: Env): Promise<{ accountId: string; role: Role } | null> {
  const s = await sessionFromRequest(env, request);
  return s ? { accountId: s.accountId, role: s.role } : null;
}
