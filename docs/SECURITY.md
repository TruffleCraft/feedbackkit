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
| Per-IP hourly rate limit (`rateLimit.perHour`) | atomic D1 upsert, fail-open + loud log; the key is a keyed hash of the IP (never the address), the daily cron deletes finished rows |
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
honeypot as the real spam/cost defense, and set a **spend/credit cap on your LLM
provider account** (e.g. OpenRouter) as a hard backstop.

**Feedback is never lost** (create-anyway): an LLM, D1, or tracker failure
downgrades the outcome (`accepted_incomplete`, or `issue_failed` with the payload
persisted for retry) and tags the issue for triage (`ai-failed`, `needs-triage`,
`d1-degraded`) — it never drops a submission or 500s.

**The test page (`/t/<key>`) is dry-run by default:** it renders the *would-be*
issue with no LLM call, no tracker call, and no data stored, under a strict CSP
(`default-src 'self'` + per-request nonce, all values via `textContent`). It
cannot create a real issue.

## Secrets

- All secrets live **only** in Worker env (`ADMIN_TOKEN`, `GITHUB_PAT_<name>`,
  `LLM_API_KEY`, and the optional `FK_ACCESS_TEAM_DOMAIN` / `FK_ACCESS_AUD`) — never in the client bundle, never in the public config
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

Admin routes (`/api/admin/*`, and the `/diag?project=` deep check) accept one
of two credentials:

- **A Cloudflare Access identity.** Only when both `FK_ACCESS_TEAM_DOMAIN` and
  `FK_ACCESS_AUD` are set. The gateway reads the JWT from the
  `Cf-Access-Jwt-Assertion` header, which Access adds at the edge, and never
  from the `CF_Authorization` cookie. It checks the RS256 signature against the
  team key set at `<team>/cdn-cgi/access/certs` (cached per isolate for an
  hour, matched by `kid`, refetched for an unknown `kid` at most every 30 s),
  `iss` equal to the team domain, `aud` containing the AUD tag, and `exp` /
  `nbf` with 60 s of skew. The token needs an `email` claim, so an Access
  service token on its own does not open the admin. Any failure means "no
  identity"; the check never throws. Plain WebCrypto, no JWT dependency.
- **`Authorization: Bearer <ADMIN_TOKEN>`**, compared in constant time. The
  token is a Worker secret — never commit it, never put it in `NEXT_PUBLIC_*`
  or any client bundle. This is the way in for curl and scripts.

Access sets its cookie with `SameSite=None` by default and turns it into the
JWT header at the edge, so a cross-site form post would arrive with a valid
Access JWT. For `POST`, `DELETE` and other state-changing methods the gateway
therefore counts an Access identity only when `Origin` matches the gateway
origin (or, without `Origin`, `Sec-Fetch-Site: same-origin`). Bearer requests
need no such check: browsers never attach that header on their own. The admin
API sends no CORS headers, so other sites can't read its responses either.

Every `/api/admin/*` route counts failed token logins per client (`adm401`
counter, keyed by the HMAC of the IP, never the address). After 20 failures in
an hour that client gets `429` for every token request, including one with the
right token, until the hour is over. A valid Access identity is not a guess and
passes regardless. `GET /api/admin/me` answers a request with no credentials
at all with a `401` that is not counted, because the admin UI calls it on every
page load. Admin responses carry `Cache-Control: no-store`.

The read-only admin API (P2, step 1):

| Route | Returns |
|---|---|
| `GET /api/admin/me` | who is signed in: `{v, via: "access", email}` or `{v, via: "token"}` |
| `GET /api/admin/projects` | id, public key, config version, last update, feedback counts of the last 7 days by outcome |
| `GET /api/admin/projects/:id/config` | the stored config plus `publicKey` and `configVersion`; re-importable as is via `POST /api/admin/config/import` |
| `GET /api/admin/projects/:id/feedback?outcome=&cursor=&limit=` | feedback history, newest first, 25 per page (max 100), keyset cursor |
| `GET /api/admin/projects/:id/funnel?days=30` | widget events by name and feedback by outcome in the window (1–90 days) |
| `GET /api/admin/system` | release, schema, bindings, secret presence, LLM calls today against `llm.dailyBudget`, PAT access and expiry per project |

Feedback items contain what the user wrote (message, summary, page URL without
query) and attachment URLs. They never contain IP addresses, device info, the
host context, or secret values; the system view reports secrets as present or
missing only.

### Admin pages

`/admin`, `/admin/projects/:id` and `/admin/system` are public HTML shells
without data: no D1 read, nothing from the URL in the markup. `dist/admin.js`
first asks `GET /api/admin/me` without a token. If Access signed the visitor
in, it skips the token form, shows the email and links **Sign out** to
`/cdn-cgi/access/logout`. Otherwise it uses the token from `sessionStorage`.
Fetches go out with `credentials: "same-origin"` so Access gets its cookie; the
gateway itself never reads a cookie. API values are rendered as text only,
never as HTML; links and image sources must be `http(s)` URLs. The shells are served
with a per-response nonce CSP (`default-src 'none'; script-src 'self'
'nonce-…'; style-src 'nonce-…'; font-src 'self'; img-src 'self' data: https:;
connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action
'self'`), `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`
and `Cache-Control: no-store` (ADR-014).
