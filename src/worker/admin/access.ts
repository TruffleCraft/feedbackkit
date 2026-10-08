import type { Env } from "../env.js";

// Cloudflare Access sign-in for the admin (ADR-014 follow-up). When the operator
// puts /admin* and /api/admin/* behind an Access application, Access adds a
// signed JWT to every request it lets through, in the Cf-Access-Jwt-Assertion
// header. This module checks that JWT so the gateway can trust the identity
// without a typed token.
//
// Following https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
// - the token comes from the Cf-Access-Jwt-Assertion header only, never from the
//   CF_Authorization cookie;
// - RS256 against the team JWKS at <team>/cdn-cgi/access/certs, matched by kid
//   (keys rotate every 6 weeks, so they are fetched, never hard-coded);
// - iss must equal the team domain, aud must contain the application's AUD tag.
//
// Plain WebCrypto, no dependency. verifyAccess never throws: any failure is null.

export interface AccessIdentity {
  email: string;
  sub: string;
}

interface Jwk {
  kid?: unknown;
  kty?: unknown;
  n?: unknown;
  e?: unknown;
}

// Clock skew tolerated on exp and nbf.
const SKEW_S = 60;
// How long a fetched key set is trusted before it is fetched again.
const JWKS_TTL_MS = 60 * 60 * 1000;
// An unknown kid triggers a refetch, but at most this often: otherwise a forged
// header with a random kid would make every request fetch the key set.
const REFETCH_MIN_MS = 30 * 1000;
// Access tokens are a few hundred bytes; anything far larger is not one.
const MAX_TOKEN_CHARS = 16 * 1024;

interface KeyCache {
  team: string;
  fetchedAt: number;
  keys: Map<string, Jwk>;
  imported: Map<string, CryptoKey>;
}

// Per isolate. One team domain per deployment, so one entry is enough.
let cache: KeyCache | null = null;
let inflight: Promise<KeyCache | null> | null = null;

/** Test hook: forget the cached key set. */
export function resetAccessCache(): void {
  cache = null;
  inflight = null;
}

/** "team.cloudflareaccess.com" or "https://team.cloudflareaccess.com/" → "https://team.cloudflareaccess.com". */
export function normalizeTeamDomain(raw: string | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`);
    if (u.protocol !== "https:" || u.username || u.password || (u.pathname !== "/" && u.pathname !== "")) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** The Access config from env, or null when Access sign-in is not set up. */
export function accessConfig(env: Env): { team: string; aud: string } | null {
  const team = normalizeTeamDomain(env["FK_ACCESS_TEAM_DOMAIN"] as string | undefined);
  const aud = (env["FK_ACCESS_AUD"] as string | undefined)?.trim();
  return team && aud ? { team, aud } : null;
}

function b64urlBytes(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function b64urlJson(s: string): Record<string, unknown> | null {
  const bytes = b64urlBytes(s);
  if (!bytes) return null;
  try {
    const v = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function fetchKeys(team: string): Promise<KeyCache | null> {
  try {
    const res = await fetch(`${team}/cdn-cgi/access/certs`, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const body = (await res.json()) as { keys?: unknown };
    if (!Array.isArray(body.keys)) return null;
    const keys = new Map<string, Jwk>();
    for (const k of body.keys as Jwk[]) {
      if (k && typeof k.kid === "string" && k.kty === "RSA" && typeof k.n === "string" && typeof k.e === "string") keys.set(k.kid, k);
    }
    return { team, fetchedAt: Date.now(), keys, imported: new Map() };
  } catch {
    return null;
  }
}

// One fetch at a time per isolate; concurrent callers share it.
async function loadKeys(team: string): Promise<KeyCache | null> {
  if (!inflight) {
    inflight = fetchKeys(team).then((fresh) => {
      inflight = null;
      if (fresh) cache = fresh;
      return fresh;
    });
  }
  return inflight;
}

async function keyFor(team: string, kid: string): Promise<CryptoKey | null> {
  const now = Date.now();
  let c = cache && cache.team === team ? cache : null;
  if (!c || now - c.fetchedAt > JWKS_TTL_MS) c = (await loadKeys(team)) ?? c;
  if (c && !c.keys.has(kid) && now - c.fetchedAt >= REFETCH_MIN_MS) c = (await loadKeys(team)) ?? c;
  const jwk = c?.keys.get(kid);
  if (!c || !jwk) return null;
  const done = c.imported.get(kid);
  if (done) return done;
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n as string, e: jwk.e as string, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  c.imported.set(kid, key);
  return key;
}

/**
 * The verified Access identity of this request, or null. Null when Access is not
 * configured (FK_ACCESS_TEAM_DOMAIN / FK_ACCESS_AUD unset), when the header is
 * missing, and on any validation failure. A service-token JWT carries no email
 * and also yields null: it opens Access, not the admin.
 */
export async function verifyAccess(env: Env, request: Request): Promise<AccessIdentity | null> {
  try {
    const cfg = accessConfig(env);
    if (!cfg) return null;
    const token = request.headers.get("Cf-Access-Jwt-Assertion")?.trim();
    if (!token || token.length > MAX_TOKEN_CHARS) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [h, p, s] = parts as [string, string, string];

    const header = b64urlJson(h);
    if (!header || header["alg"] !== "RS256" || typeof header["kid"] !== "string") return null;
    const payload = b64urlJson(p);
    const sig = b64urlBytes(s);
    if (!payload || !sig || sig.length === 0) return null;

    // Claims first: they are cheap and need no key fetch.
    if (payload["iss"] !== cfg.team) return null;
    const aud = payload["aud"];
    if (!(aud === cfg.aud || (Array.isArray(aud) && aud.includes(cfg.aud)))) return null;
    const now = Math.floor(Date.now() / 1000);
    const exp = payload["exp"];
    if (typeof exp !== "number" || now > exp + SKEW_S) return null;
    const nbf = payload["nbf"];
    if (nbf !== undefined && (typeof nbf !== "number" || now < nbf - SKEW_S)) return null;
    const email = payload["email"];
    const sub = payload["sub"];
    if (typeof email !== "string" || !email || typeof sub !== "string") return null;

    const key = await keyFor(cfg.team, header["kid"]);
    if (!key) return null;
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, new TextEncoder().encode(`${h}.${p}`));
    return ok ? { email, sub } : null;
  } catch {
    return null;
  }
}
