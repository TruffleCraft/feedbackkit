import type { Context } from "hono";
import { WIRE_VERSION } from "../../shared/contract.js";
import { hitRateLimit, hourWindow, ipKey } from "../security/ratelimit.js";
import type { Env } from "../env.js";

// Failed admin logins allowed per client IP and hour before the API answers 429.
export const ADMIN_FAILED_AUTH_LIMIT = 20;

// Length-independent compare for the admin token (avoids leaking a match via
// early-return timing). Length itself is not treated as secret.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export function adminAuthed(c: Context): boolean {
  const token = c.env["ADMIN_TOKEN"] as string | undefined;
  if (!token) return false;
  const header = c.req.header("Authorization") ?? "";
  const m = header.match(/^Bearer\s+(.+)$/);
  return m ? safeEqual(m[1]!, token) : false;
}

/**
 * Gate for every /api/admin/* route. Returns null when the request may proceed,
 * otherwise the 401/429 response to send.
 *
 * Failed attempts are counted per hashed client IP (`adm401` scope, hourly
 * window). Once a client has used up its failures for the hour it gets 429 for
 * every admin request, even with the right token: answering 401 vs 200 after the
 * limit would leave guessing open. Successful requests are not counted.
 */
export async function adminGate(c: Context<{ Bindings: Env }>): Promise<Response | null> {
  c.header("Cache-Control", "no-store");
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const key = await ipKey(c.env, "adm401", ip);
  if (await lockedOut(c.env, key)) return c.json({ v: WIRE_VERSION, status: "error", error: "rate limited" }, 429);
  if (adminAuthed(c)) return null;
  const rl = await hitRateLimit(c.env, key, hourWindow(), ADMIN_FAILED_AUTH_LIMIT);
  if (!rl.allowed) return c.json({ v: WIRE_VERSION, status: "error", error: "rate limited" }, 429);
  return c.json({ v: WIRE_VERSION, status: "error", error: "unauthorized" }, 401);
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
