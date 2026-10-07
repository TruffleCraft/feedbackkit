import { originAllowed } from "./origin.js";

// Optional Cloudflare Turnstile gate on POST /api/feedback (per project). The
// widget sends a fresh token with every POST; we redeem it at Siteverify and
// require success, our action and a hostname on the project's origin allowlist.
// Fails closed: no token, a Siteverify error or a mismatch rejects the POST.

export const TURNSTILE_ACTION = "feedback";
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export type VerifyFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface TurnstileCheck {
  secret: string | undefined;
  token: string | undefined;
  remoteIp: string | undefined;
  origins: string[];
  fetchImpl?: VerifyFetch;
}

export async function verifyTurnstile(c: TurnstileCheck): Promise<boolean> {
  const { secret, token } = c;
  if (!secret || typeof token !== "string" || token.length === 0 || token.length > 2048) return false;
  const body = new URLSearchParams({ secret, response: token });
  if (c.remoteIp && c.remoteIp !== "unknown") body.set("remoteip", c.remoteIp);
  let result: { success?: boolean; action?: string; hostname?: string };
  try {
    const r = await (c.fetchImpl ?? fetch)(SITEVERIFY, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return false;
    result = (await r.json()) as typeof result;
  } catch {
    return false;
  }
  if (result.success !== true || result.action !== TURNSTILE_ACTION || typeof result.hostname !== "string") return false;
  // Siteverify reports the bare hostname (no scheme, no port) of the page that
  // solved the challenge; it must belong to an allowlisted origin of THIS project.
  const host = result.hostname;
  return originAllowed(`https://${host}`, c.origins) || originAllowed(`http://${host}`, c.origins) || c.origins.some((o) => exactHost(o) === host);
}

function exactHost(origin: string): string | null {
  if (origin.includes("*")) return null;
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
}
