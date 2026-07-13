import type { Env } from "../env.js";

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  degraded: boolean; // true if the store was unreachable (fail-open)
}

// Atomic per-IP rate limit. One statement (INSERT … ON CONFLICT … RETURNING) so
// concurrent requests can't all read the same count and pass — the VOS/SCTT
// read-then-update limiter was racy. Fail-open on a store error (feedback must
// never be lost to a limiter outage), but log loudly so it's visible.
export async function hitRateLimit(
  env: Env,
  key: string,
  windowStart: number,
  limit: number,
): Promise<RateLimitResult> {
  try {
    const row = await env.DB.prepare(
      `INSERT INTO counters (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN counters.window_start = ?2 THEN counters.count + 1 ELSE 1 END,
         window_start = ?2
       RETURNING count`,
    )
      .bind(key, windowStart)
      .first<{ count: number }>();
    const count = row?.count ?? 1;
    return { allowed: count <= limit, count, degraded: false };
  } catch (e) {
    console.warn(`[feedbackkit] rate-limit store unreachable, failing open: ${(e as Error).message}`);
    return { allowed: true, count: 0, degraded: true };
  }
}

// Current hour bucket (seconds since epoch, floored to the hour).
export function hourWindow(now = Date.now()): number {
  return Math.floor(now / 3_600_000) * 3600;
}

// Current UTC-day bucket (day number since epoch) — for the LLM daily budget cap.
export function dayWindow(now = Date.now()): number {
  return Math.floor(now / 86_400_000);
}
