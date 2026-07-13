// Best-effort PII/secret redaction for console-buffer entries before they leave
// the browser. Privacy-first positioning (README): the widget must not quietly
// ship credentials or personal data captured from console noise. Pure.

const PATTERNS: Array<{ re: RegExp; to: string }> = [
  // Authorization schemes: "Bearer <token>", "Basic <creds>" — redact the token,
  // not just the scheme word (the earlier rule stopped at the first space).
  { re: /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, to: "$1 [redacted]" },
  // key: value / key=value for sensitive keys — needs a real separator so prose
  // like "the token is invalid" isn't clobbered; redacts the value token.
  { re: /\b(authorization|token|api[_-]?key|secret|password|passwd|pwd)(\s*[:=]\s*)("?)[^\s"',;]+/gi, to: "$1$2$3[redacted]" },
  // JWTs (three base64url segments)
  { re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, to: "[redacted-jwt]" },
  // Emails
  { re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, to: "[redacted-email]" },
  // Long hex / base64-ish blobs (likely keys/hashes)
  { re: /\b[A-Fa-f0-9]{24,}\b/g, to: "[redacted-hex]" },
  { re: /\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g, to: "[redacted-token]" },
  // 13–19 digit numeric runs (cards, long ids)
  { re: /\b\d{13,19}\b/g, to: "[redacted-number]" },
];

export function redactPII(input: string): string {
  let out = input;
  for (const { re, to } of PATTERNS) out = out.replace(re, to);
  return out;
}
