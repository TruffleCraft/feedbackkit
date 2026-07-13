// Anchored origin allowlist. The VOS predecessor matched with
// `origin.match(entry.replace('*','.*'))` — unanchored, dots unescaped, only the
// first `*` replaced — which let `https://x.good.dev.evil.com` through. This is
// the fix: fully escape, anchor `^…$`, and bound `*` to a single label `[^./]+`
// (no dots, no slashes) so a wildcard subdomain can't span extra labels or hosts.

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True iff `origin` is allowed by `allowlist`.
 * Entries are exact (`https://acme.dev`) or single-label wildcards
 * (`https://*.acme.dev`, `http://localhost:*`). Missing/empty origin → false.
 */
export function originAllowed(origin: string | null | undefined, allowlist: readonly string[]): boolean {
  if (!origin) return false;
  for (const entry of allowlist) {
    if (!entry.includes("*")) {
      if (entry === origin) return true;
      continue;
    }
    // escapeRegex turns `*` into `\*`; swap that for a single-label matcher, then anchor.
    const pattern = "^" + escapeRegex(entry).replace(/\\\*/g, "[^./]+") + "$";
    if (new RegExp(pattern).test(origin)) return true;
  }
  return false;
}
