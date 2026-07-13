// Best-effort PII/secret redaction for console-buffer entries before they leave
// the browser. Privacy-first positioning (README): the widget must not quietly
// ship credentials or personal data captured from console noise. Pure.

const PATTERNS: Array<{ re: RegExp; to: string }> = [
  // Bearer/authorization tokens
  { re: /\b(bearer|authorization|token|api[_-]?key|secret|password|passwd|pwd)\b(["'\s:=]+)[^\s"',;)]+/gi, to: "$1$2[redacted]" },
  // JWTs (three base64url segments)
  { re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, to: "[redacted-jwt]" },
  // Emails
  { re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, to: "[redacted-email]" },
  // Long hex / base64-ish blobs (likely keys/hashes) — 24+ chars
  { re: /\b[A-Fa-f0-9]{24,}\b/g, to: "[redacted-hex]" },
  { re: /\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g, to: "[redacted-token]" },
  // Credit-card-ish 13–16 digit runs
  { re: /\b\d{13,16}\b/g, to: "[redacted-number]" },
];

export function redactPII(input: string): string {
  let out = input;
  for (const { re, to } of PATTERNS) out = out.replace(re, to);
  return out;
}
