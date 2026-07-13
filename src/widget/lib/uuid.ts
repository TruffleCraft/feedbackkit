// crypto.randomUUID() is SECURE-CONTEXT ONLY — undefined on plain http:// pages
// (internal tools, staging, LAN IPs). getRandomValues() is not gated, so fall
// back to a hand-rolled v4; last resort Math.random so we never throw.
export function uuid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) {
    try {
      return c.randomUUID();
    } catch {
      /* fall through */
    }
  }
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40; // version 4
  b[8] = (b[8]! & 0x3f) | 0x80; // variant
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0"));
  return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10, 16).join("")}`;
}
