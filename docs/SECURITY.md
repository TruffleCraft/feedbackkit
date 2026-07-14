# Security

**Reporting a vulnerability:** open a private security advisory on the repo, or
email the maintainer — do not file a public issue for an exploitable finding.

## Threat model

FeedbackKit's data-plane endpoints (`/api/config`, `/api/feedback`,
`/api/upload`, `/api/events`) are **public and anonymous** by design — the widget
runs on visitors' browsers with no login. The project key in the snippet is
**public** (anyone viewing the page can read it). So the security model is *not*
"keep the key secret"; it's **bound the blast radius of an anonymous endpoint**.

Explicitly in scope: an attacker who knows the public key and scripts requests
directly. What stops them from turning your feedback endpoint into an
issue-spam / LLM-cost relay:

| Control | Where |
|---|---|
| Per-IP hourly rate limit (`rateLimit.perHour`) | atomic D1 upsert, fail-open + loud log |
| LLM **daily budget cap** (`llm.dailyBudget`) — over budget → required-field mode, no LLM cost | per-project D1 counter |
| Honeypot field → silent fake-success | `/api/feedback` |
| Payload size + field caps (Zod), bounded body read | wire contract + streaming read |
| Upload: content-type by **magic bytes** (header never trusted), 2 MB cap, image-only | `storage/r2.ts` |
| `enabled` kill-switch per project | config |

**The origin allowlist (`auth.origins`) is a browser/CORS control, not hard
auth.** A browser on another site is blocked (its `Origin` can't be forged); a
non-browser client can omit `Origin` and is bounded by the controls above
instead. Same-origin requests (the gateway's own `/t/<key>` test page) are always
allowed. This is inherent to anonymous feedback — treat rate-limit + budget +
honeypot as the real spam/cost defense, and set a Cloudflare account **spend
limit** on your LLM provider.

**Feedback is never lost** (create-anyway): an LLM, D1, or tracker failure
downgrades the outcome (`accepted_incomplete` / `issue_failed` with the payload
persisted for retry / `d1-degraded`) — it never drops a submission or 500s.

**The test page (`/t/<key>`) is dry-run by default:** it renders the *would-be*
issue with no LLM call, no tracker call, and no data stored, under a strict CSP
(`default-src 'self'` + per-request nonce, all values via `textContent`). It
cannot create a real issue.

## Secrets

- All secrets live **only** in Worker env (`ADMIN_TOKEN`, `GITHUB_PAT_<name>`,
  `LLM_API_KEY`) — never in the client bundle, never in the public config
  projection (`/api/config` whitelists fields; PAT/LLM/origins/prompt internals
  never ship to the browser).
- The PAT and LLM key are never logged, echoed into an error message, or placed
  in an issue body or client response.
- `wrangler.toml` is gitignored (operator-specific IDs; ADR-004) and generated
  from build variables. Never commit it.

## Attachments & screenshots

FeedbackKit stores screenshots and image uploads in a Cloudflare R2 bucket.

- **Accepted types are decided by magic bytes, never the `Content-Type` header** —
  PNG, JPEG, WebP, GIF only (`src/worker/storage/r2.ts`). A file that claims to be
  an image but whose bytes are HTML/script is rejected with `415`.
- **Size cap:** 2 MB per object (the widget resizes screenshots first).
- **Keys are unguessable** (`<projectId>/<uuid>.<ext>`), but the bucket is public.
  An unguessable URL is *not* an access-control model — treat every uploaded
  object as world-readable to anyone who has the link.
- **Screenshots can contain anything on the user's screen** (other tabs, tokens,
  personal data). On a **public** repo, an inline attachment URL in an issue is
  permanently indexable. Operators should say so in their feedback UI copy.

## Retention & deletion (GDPR Art. 17)

- Each asset is indexed in the `assets` D1 table with an `expires_at`. Set
  `storage.retentionDays` in a project's config to auto-expire attachments;
  omit it to keep them until an explicit delete.
- A **daily cron** (`scheduled` handler) deletes expired objects from R2 and
  marks the rows deleted.
- **On-demand delete:** `DELETE /api/admin/assets?feedbackId=<uuid>` (admin-authed)
  removes every attachment tied to one feedback submission.

### camo residual risk

GitHub proxies and **caches** inline images through its camo service. Deleting
an object from R2 does **not** guarantee GitHub's cached copy is gone. Therefore:

1. R2 objects are served with a short `max-age` (300 s) so the origin copy
   turns over quickly.
2. **Editing the GitHub issue to remove the image URL is part of the deletion
   process** — the admin delete removes the source object; the issue edit removes
   the reference that camo re-fetches from.

## Admin endpoints

Admin routes (`/api/admin/*`, and the `/diag?project=` deep check) require
`Authorization: Bearer <ADMIN_TOKEN>` and use a constant-time comparison. The
token is a Worker secret — never commit it, never put it in `NEXT_PUBLIC_*` or
any client bundle. Cloudflare Access in front of the admin surface is the
recommended production posture (full admin-auth hardening lands in P2).
