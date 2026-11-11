// WebCrypto helpers shared by every part of the account system. Only crypto.subtle
// and crypto.getRandomValues, so the same code runs on Node 24 and in workerd.

const ENC = new TextEncoder();

export function bytesToB64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlToBytes(text: string): Uint8Array<ArrayBuffer> {
  const pad = text.length % 4 === 0 ? "" : "=".repeat(4 - (text.length % 4));
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** `bytes` random bytes as base64url. */
export function randomB64url(bytes: number): string {
  return bytesToB64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", ENC.encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacSha256(key: Uint8Array | string, message: Uint8Array | string): Promise<Uint8Array> {
  const keyBytes = typeof key === "string" ? ENC.encode(key) : key;
  const msgBytes = typeof message === "string" ? ENC.encode(message) : message;
  const k = await crypto.subtle.importKey("raw", keyBytes as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, msgBytes as BufferSource));
}

/**
 * Compares two strings without leaving early on the first difference. The length
 * is not treated as secret. Every secret that is compared directly (the CSRF
 * token, the legacy admin token) goes through here; stored secrets (session
 * tokens, API tokens, one-time links) are looked up by their SHA-256 instead, so
 * the database compares hashes of values the caller cannot choose bit by bit.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

/** Seconds a client should wait: until the current hour window ends. */
export function secondsToHourEnd(now = Date.now()): number {
  return Math.max(1, Math.ceil((Math.floor(now / 3_600_000) * 3_600_000 + 3_600_000 - now) / 1000));
}
