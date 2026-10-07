// Page URLs end up in a GitHub issue and in the LLM prompt. Query strings and
// fragments routinely carry secrets (magic-link and reset tokens, OAuth codes,
// session ids), so only origin + path are reported. Zod-free: the widget imports
// this, and the worker applies it again for older widget builds.
export function redactPageUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return raw;
    return u.origin + u.pathname;
  } catch {
    return raw; // not a URL (e.g. the test page's placeholder) — leave as is
  }
}
