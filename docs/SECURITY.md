# Security

> Scope note: this file grows through P1.13. Today it covers the attachment
> pipeline shipped in P1.8 (R2 storage, retention, deletion). Reporting a
> vulnerability: open a private security advisory on the repo, or email the
> maintainer — do not file a public issue for an exploitable finding.

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
