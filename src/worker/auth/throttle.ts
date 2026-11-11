import type { Env } from "../env.js";
import { hitRateLimit, hourWindow, ipKey } from "../security/ratelimit.js";
import { secondsToHourEnd } from "./crypto.js";

// Failed sign-ins, link redemptions and API-token attempts are counted per
// client address (hashed with the instance secret, never stored raw) and, when
// the attempt names an account, per account.
//
// The rule this module exists for: a VALID attempt is never refused because of a
// counter. Callers verify first. Only a failed attempt is counted, and once a
// counter is over its limit a failed attempt is answered with 429 and Retry-After
// instead of 401. So an attacker who fails 30 times from a shared address, or 10
// times against one account, cannot lock anyone out; behind a proxy that hides
// client addresses (FK_TRUSTED_PROXY_HOPS not set) every client shares one
// address, and the worst that happens is that failures there read as 429.
//
// What the counters bound: the rows a flood can write (one counter row per
// address and per account and hour), and the signal that tells a client or an
// upstream limiter to stop. Guessing is not the threat they answer: a passkey
// signature, a link token and an API token carry 128 to 256 bits that a client
// cannot guess. The legacy ADMIN_TOKEN, which a person chose, keeps its older
// rule (a locked-out address is refused even with the right token) until the first
// owner exists, in admin/auth.ts.

export const AUTH_FAIL_IP_LIMIT = 30;
export const AUTH_FAIL_ACCOUNT_LIMIT = 10;

export interface FailureResult {
  limited: boolean;
  retryAfter: number;
}

export async function recordAuthFailure(env: Env, ip: string, accountId?: string | null, now = Date.now()): Promise<FailureResult> {
  const window = hourWindow(now);
  const byIp = await hitRateLimit(env, await ipKey(env, "authfail", ip), window, AUTH_FAIL_IP_LIMIT);
  const byAccount = accountId ? await hitRateLimit(env, `authfail:acct:${accountId}`, window, AUTH_FAIL_ACCOUNT_LIMIT) : null;
  return { limited: !byIp.allowed || (byAccount !== null && !byAccount.allowed), retryAfter: secondsToHourEnd(now) };
}
