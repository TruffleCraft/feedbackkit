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

- All secrets live **only** in Worker env (`ADMIN_TOKEN` until the first owner exists, `GITHUB_PAT_<name>`,
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
- With `retentionDays`, the same cron deletes stored submissions (`feedback`
  rows) at that age, handled or not, together with their attachments: the
  attachments go first, and a row whose attachments could not all be deleted
  stays until the next run. Unhandled reports (no issue) are listed on the admin
  System page and in the admin-only `/diag?project=<key>` check 7 days ahead,
  by id, type and date only.
- **On-demand delete:** `DELETE /api/admin/assets?feedbackId=<uuid>` (admin-authed)
  removes every attachment tied to one feedback submission.

### Private deliveries

Reports delivered to a GitHub Project or stored locally link their screenshots
to `GET /admin/assets/<key>` on the gateway instead of the public R2 URL. The
route needs an admin sign-in (Cloudflare Access in a browser, or the admin
token), answers `Cache-Control: private, no-store` and a sandboxing CSP, and
only serves keys still indexed in `assets`. The objects stay in the public
bucket, so anyone who already has a public URL keeps it; the drafts never
contain one. Screenshots of a report delivered late stay at least 7 days after
the delivery (`expires_at` is extended, never shortened).

### camo residual risk

GitHub proxies and **caches** inline images through its camo service. Deleting
an object from R2 does **not** guarantee GitHub's cached copy is gone. Therefore:

1. R2 objects are served with a short `max-age` (300 s) so the origin copy
   turns over quickly.
2. **Editing the GitHub issue to remove the image URL is part of the deletion
   process** — the admin delete removes the source object; the issue edit removes
   the reference that camo re-fetches from.

## Standalone server

The standalone Node server (`scripts/server.mjs`) runs the same application as the Worker, so everything above applies. These points are specific to it. Each one has a test, listed in [claims and their proof](design/claims.md).

- **Trust boundary.** TLS and the reverse proxy are the operator's. The server builds every request URL from `FK_PUBLIC_URL` and never from the `Host` header, and answers 400 to a path that starts with `//` or `/\`. The client address comes from the socket, or from `X-Forwarded-For` read from the right through `FK_TRUSTED_PROXY_HOPS` proxies. Without that setting every client behind a proxy shares one address and one failed-login limit, and the server logs a warning once.
- **Admin credential.** Accounts with passkeys and scoped API tokens ([below](#accounts-and-sessions)). `ADMIN_TOKEN` is optional: the server starts without it, it works only until the first owner exists, and when it is set it must be at least 32 characters. Before the first owner, 20 failed attempts per client address and hour make the admin API answer 429 even to the right token. Cloudflare Access headers are discarded.
- **Environment.** The application receives `ADMIN_TOKEN`, `LLM_API_KEY`, `GITHUB_PAT_*`, `TURNSTILE_SECRET_*` and `FK_RELEASE`, not the whole process environment. A project's settings can name only `GITHUB_PAT_<name>` secrets, so they cannot point at `ADMIN_TOKEN` or another variable.
- **Attachments.** Only attachments of reports delivered as GitHub issues are served at `/attachments/<key>`, because an issue image needs a public URL. They carry `Content-Security-Policy: default-src 'none'; sandbox` and `nosniff`. Screenshots of inbox reports and Project drafts are served at `/admin/assets/<key>` and need the admin sign-in. The admin page fetches them with the `Authorization` header.
- **Deletion.** The database runs with `secure_delete=ON` and `auto_vacuum=INCREMENTAL`. After attachments or reports are deleted the server hands the freed pages back and truncates the write-ahead log, so the deleted content is in neither the database file nor the log. This covers those files only. Snapshots of the disk or the LXC, backups and copies of the data directory keep what they held, and GitHub keeps issue text and may cache images (see camo above).
- **Durability.** The database runs in WAL mode with `synchronous=NORMAL`. A crash of the process loses nothing that was confirmed. A power loss or kernel crash can lose the last few reports but does not corrupt the database.
- **Files.** The server sets `umask 077`, so the data directory and the database are readable by its user only.
- **Update check.** On a release tarball install the server makes one `GET` to the GitHub Releases API at most once a day (once an hour after a failure) so the System page can say that a newer release exists. The request carries a fixed `User-Agent` (`feedbackkit-update-check`) and an `Accept` header: no credential, cookie, installed version or host name. GitHub sees the server's IP address, as it does for any client. The browser never calls GitHub, and the admin CSP stays `connect-src 'self'`. The link to the release notes is built from the validated version, never taken from the answer. A failed or rate-limited check shows a short fixed reason on the System page and changes nothing else. `FK_UPDATE_CHECK=off` removes it, and a checkout install and Cloudflare make no such request. Test: `test/server-update-notice.test.mjs`.
- **MCP.** Off, and nobody can approve a connection yet: the consent step is not wired to the account session yet (the sign-in exists: `authenticateAccount` in `src/worker/auth/`). `FK_MCP=on` serves the OAuth endpoints anyway and approves nothing. See [Identity on the standalone server](#identity-on-the-standalone-server). Tests: `test/server-oauth.test.mjs`, `test/server-mcp-e2e.test.mjs`.
- **Move from Cloudflare.** `feedbackkit-migrate export` reads D1 and R2 with the operator's own wrangler login and writes every report and screenshot into a directory, so that directory is as sensitive as the database: keep it private and delete it after the import. The export holds no secrets, because D1 stores variable names only. The import refuses a damaged or edited export (checksums), writes in one transaction and checks counts and checksums before and after it commits. Tests: `test/server-migrate.test.mjs` and `test/server-migrate-e2e.test.mjs`.
- **Not built yet.** The sign-in, setup and account screens of Gate 2 (the account API and the host commands exist), and masking of screenshots before upload (Gate 1). See the [plan](design/autonomous-admin-plan.md).

## Admin endpoints

Admin routes (`/api/admin/*`, `/admin/assets/*`, and the `/diag?project=` deep
check) accept these credentials ([accounts and sessions](#accounts-and-sessions) describes the first two):

- **A session** of a person who signed in with a passkey, and **a scoped API token** that an owner created.

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
- **`Authorization: Bearer <ADMIN_TOKEN>`**, compared in constant time, **only until the
  first owner exists**. From then on it grants nothing and the answer says
  `FK_ADMIN_TOKEN_RETIRED`. The token is a Worker secret — never commit it, never
  put it in `NEXT_PUBLIC_*` or any client bundle. Delete the secret once the first
  owner exists.

Access sets its cookie with `SameSite=None` by default and turns it into the
JWT header at the edge, so a cross-site form post would arrive with a valid
Access JWT. For `POST`, `DELETE` and other state-changing methods the gateway
therefore counts an Access identity only when `Origin` matches the gateway
origin (or, without `Origin`, `Sec-Fetch-Site: same-origin`). Bearer requests
need no such check: browsers never attach that header on their own. The admin
API sends no CORS headers, so other sites can't read its responses either.

Before the first owner exists, every `/api/admin/*` route counts failed
`ADMIN_TOKEN` logins per client (`adm401` counter, keyed by the HMAC of the IP,
never the address). After 20 failures in an hour that client gets `429` for every
token request, including one with the right token, until the hour is over. The
account system never refuses a valid credential for that reason
([failed attempts](#failed-attempts)). A valid Access identity is not a guess and
passes regardless. `GET /api/admin/me` answers a request with no credentials
at all with a `401` that is not counted, because the admin UI calls it on every
page load. Admin responses carry `Cache-Control: no-store`.

The admin API:

| Route | Returns |
|---|---|
| `GET /api/admin/me` | who is signed in: `{v, via: "access", email}` or `{v, via: "token"}` |
| `GET /api/admin/projects` | id, public key, config version, last update, feedback counts of the last 7 days by outcome |
| `GET /api/admin/projects/:id/config` | the stored config plus `publicKey` and `configVersion`; re-importable as is via `POST /api/admin/config/import` |
| `GET /api/admin/projects/:id/feedback?outcome=&cursor=&limit=` | feedback history, newest first, 25 per page (max 100), keyset cursor |
| `GET /api/admin/projects/:id/funnel?days=30` | widget events by name and feedback by outcome in the window (1–90 days) |
| `GET /api/admin/system` | release, schema, bindings, secret presence, LLM calls today against `llm.dailyBudget`, PAT access and expiry per project, GitHub Project check, retention notice, and on a tarball install the notice for a newer release (`update`) |
| `PATCH /api/admin/feedback/:id` | disposition (`open`, `done`, `dismissed`) and note of a local or undecided report; `409 FK_NOT_LOCAL` for delivered ones |
| `DELETE /api/admin/feedback/:id` | deletes the attachments, then the row; a partial failure keeps the row (`502 FK_DELETE_INCOMPLETE`) |
| `POST /api/admin/feedback/:id/retry` | delivery retry, see [ERRORS.md](ERRORS.md) |
| `POST /api/admin/projects/:id/config/validate` | Zod issues, the delivery shape gate and the effective delivery per type; stores nothing |
| `PUT /api/admin/projects/:id/config` | publishes with `expectedVersion` (`409 FK_CONFIG_STALE` with the current config); `projectId` is locked |
| `POST /api/admin/projects/:id/test-report` | one real delivery, LLM off, `is_test`; 10 per hour and project |

Every write route goes through the same gate, so on the Access path it only
counts a same-origin request (CSRF guard above). Writes log identifiers and
results, never report content.

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
never as HTML; links and image sources must be `http(s)` URLs. Screenshots of local reports and Project drafts sit behind the admin sign-in, so the page fetches them with the `Authorization` header and shows them from `blob:` object URLs, which it releases when the list is rebuilt. The shells are served
with a per-response nonce CSP (`default-src 'none'; script-src 'self'
'nonce-…'; style-src 'nonce-…'; font-src 'self'; img-src 'self' blob: data: https:;
connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action
'self'`), `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`
and `Cache-Control: no-store` (ADR-014).

## Accounts and sessions

Local accounts (Gate 2) work the same on the standalone server and on Cloudflare: `src/worker/auth/`, migration `0005_accounts.sql`, one conformance suite on SQLite and D1. How the pieces fit, and the D1 design for the atomic owner claim, is in [design/gate2-accounts.md](design/gate2-accounts.md). Every statement below has a test (`test/durable/accounts.test.ts`, `test/auth-gate.test.ts`, `test/server-accounts.test.mjs`, `e2e/accounts-real-server.spec.ts`); [claims.md](design/claims.md) lists them.

### What it defends against

| Threat | Control |
|---|---|
| Someone reaches a fresh instance first and becomes owner | There is no public first-user route. The first owner needs a one-time link that only the host command (`feedbackkit-admin setup-link`) or `pnpm admin:link` with the operator's Cloudflare credentials can issue. Two simultaneous attempts produce one owner |
| A leaked or guessed shared admin secret | After the first owner exists `ADMIN_TOKEN` grants nothing. Scripts use scoped API tokens that an owner can revoke, and that end by themselves |
| Phishing and credential stuffing | Passkeys only: no password exists. The browser signs the origin into every assertion and the server checks it, so a passkey made for one address cannot sign in at another. User verification is required |
| A copy of the database | Session tokens, link tokens and API tokens are stored as SHA-256 only. Passkeys hold public keys. The instance secret that keys challenges and address hashes is in the database, which is no worse than the rows it protects |
| Cross-site request forgery | `SameSite=Lax` cookies, a CSRF token on every state-changing request of a session, and a same-origin check on `Origin` or `Sec-Fetch-Site`. The ceremonies check the origin too |
| Session fixation | A new random session token at every sign-in and enrollment. A session cookie that arrives with the request is deleted and replaced, never adopted |
| Replay of a captured ceremony | Challenges are signed, expire after 5 minutes and are recorded as used. A counter that goes back is refused |
| A stolen API token | Hashed at rest, shown once, read-only or write, limited to projects, 1 to 365 days, revoked on the next request. A token cannot create tokens or accounts. A token limited to projects reaches only routes that name one of them, and is refused on `/api/admin/system`, config import and project creation |
| An owner locks everyone out | The last active owner cannot be demoted or removed, and two owners who demote or remove each other at the same time leave one. The last passkey of an account cannot be removed |
| A lost device | Recovery by a host command: the link replaces the account's passkeys, ends its sessions and revokes the API tokens that account created (a stolen session could have made one that outlives it; `--keep-tokens` opts out). Recovery needs host access, or on Cloudflare the operator's own Cloudflare credentials |
| A removed person keeps access | Removing an account deletes its sessions and passkeys and revokes its tokens in one batch |

### Sessions and cookies

The cookie is `__Host-fk_session` with `Secure` when the public URL is https, and `fk_session` without `Secure` on `http://localhost`. It is `HttpOnly`, `SameSite=Lax`, `Path=/`, has no `Domain`, and lives 30 days; the server also ends a session after 7 days without use. `Lax` is deliberate: the consent page of the MCP authorization server is opened by an agent's client from another site and must see the signed-in person. Cross-site writes are stopped by the CSRF token and the origin check, not by the cookie attribute. Responses of the admin API carry `Cache-Control: no-store`. `authenticateAccount(request, env)` in `src/worker/auth/` is the one function other code uses to learn who is signed in; it reads the session cookie and nothing else.

### Secrets in transit, logs and comparisons

- A one-time link is `<origin>/admin/setup#<token>`. The token sits in the URL fragment, so no server, proxy or `Referer` header sees it. No other secret is ever put in a URL.
- Log lines carry identifiers (account ID, token ID, event name) and never a token, a cookie, a name or a link. A test scans every log line of a full run for the token prefixes.
- A secret that is compared directly (the CSRF token, the legacy `ADMIN_TOKEN`) goes through a constant-time comparison. Stored secrets are looked up by their SHA-256 and never compared in application code.

### Failed attempts

Failed sign-ins, link redemptions and API-token attempts are counted per hashed client address (30 an hour) and, when the attempt names an account, per account (10 an hour). **A valid credential is never refused because of a counter.** The server verifies first. Over a limit, a failed attempt gets `429` with `Retry-After` instead of `401`. The counters bound what a flood can write and tell a client or an upstream limiter to stop. They are not the defense against guessing, because a passkey signature and a 256-bit token cannot be guessed. Without `FK_TRUSTED_PROXY_HOPS` every client behind a proxy shares one address: failures there read as `429`, and a valid credential still works. Set it to the number of proxies in front of the server so that counters are per client. The tests run both cases on a real server.

### Operating notes

- **Passkeys need a secure context.** Browsers allow WebAuthn only on https or on `localhost`. The relying party ID is the host name of `FK_PUBLIC_URL`, and a passkey belongs to that name. Changing `FK_PUBLIC_URL` to another host orphans every passkey: use recovery links to enroll again. An IP address cannot be a relying party ID. Reach a server without TLS through `ssh -L 8787:127.0.0.1:8787 host` and `http://localhost:8787`.
- **Cloudflare:** the relying party follows the request URL or the optional `FK_PUBLIC_URL` variable. A passkey made on the `workers.dev` address does not work on a custom domain. After the first owner exists, delete the `ADMIN_TOKEN` secret: `wrangler rollback` to a release without accounts would honor it again.
- **Cloudflare Access** stays an accepted identity for the admin routes (S15). It is not an account, so it cannot create tokens, manage accounts or use the account page.
- **Backups of the data directory hold the session hashes and passkey public keys.** Restoring an old copy brings back sessions that were revoked after it was taken. Revoke or recover after a restore.

## MCP server (`/mcp`)

Optional and read-only (ADR-015). On the Worker it is off unless the operator
binds a KV namespace as `OAUTH_KV` (build variable `FK_OAUTH_KV_ID`). On the
standalone server it is off, and it stays off for operators until accounts exist
(`FK_MCP=on` serves the plumbing, see [below](#identity-on-the-standalone-server)).
Where it is off, `/mcp`, `/oauth/*` and `/.well-known/oauth-*` answer 404.

### OAuth 2.1

The gateway is its own authorization server and the resource server, both from
`@cloudflare/workers-oauth-provider`: authorization code with S256 PKCE only,
dynamic client registration and Client ID Metadata Documents, RFC 8414 and
RFC 9728 metadata, tokens bound to the resource `https://<gateway>/mcp`
(RFC 8707), rotating refresh tokens. Storage (the Worker's KV namespace, or the
table `_fk_kv` in the standalone server's SQLite file) holds tokens as hashes
and the grant props encrypted. Access tokens live one hour, refresh tokens 30 days. `/mcp`
takes nothing else: no `ADMIN_TOKEN`, no Access JWT, no cookie.

Fetching a Client ID Metadata Document is a request to a URL the client
chooses. The Worker runs with the `global_fetch_strictly_public` compatibility
flag, so such a fetch can't reach an origin inside the operator's zone; the
provider adds its own size and time limits. The standalone server turns
Client ID Metadata Documents off: Node has no such flag, so the fetch could
reach private addresses, and clients register through `/oauth/register`
instead.

### Consent

`/oauth/authorize` is the only route the application owns. It asks one function
who is signing in, `authenticateConsent()` (`src/worker/oauth/consent-identity.ts`).
On the Worker that is Cloudflare Access, and a grant needs two things (the
standalone server has no identity to give yet, see
[below](#identity-on-the-standalone-server)):

- A Cloudflare Access identity, checked with the same `verifyAccess()` as the
  admin. The operator adds `/oauth/authorize` to the admin's Access
  application, so its policy decides who may connect an agent. Without a valid
  identity the page says sign-in is required and creates nothing, not even a
  consent transaction. There is no token fallback: a consent page with a
  token field would teach people to paste the admin token into a page an app
  sent them to.
- A click on **Allow**. The form carries a single-use handle from
  `beginConsent()`, valid ten minutes and bound to the browser by a
  `__Host-` cookie with `SameSite=Lax`. The POST must also come from the
  gateway origin (the same check as the admin), and it verifies the Access
  identity again. **Cancel** sends the client back with `access_denied`.

The page shows the app name (escaped; for a registered client it is
self-asserted, and the page says so), the host the tokens go to, a warning
when that host is the user's own machine, the requested scopes as plain lines
and the signed-in email. The scopes granted are the ones the stored request
asked for that the gateway knows, `feedback:read` when it asked for none of
them; a form field can't add any. The page has no script and a nonce CSP
(`default-src 'none'; style-src 'nonce-…'; font-src 'self'; img-src data:;
form-action 'self' <redirect origin>; frame-ancestors 'none'; base-uri
'none'`) plus `X-Frame-Options: DENY`. `form-action` lists the client's
redirect origin because browsers apply it to the redirect after the post.
`Referrer-Policy` is `same-origin`, not `no-referrer` as on the admin shells:
with `no-referrer` the browser posts the form with `Origin: null`, and the
origin check refuses every Allow. `same-origin` keeps the origin on that post
and still sends no `Referer` to the client or any other site. The admin shells
are not affected, because they call the API with `fetch()`, which always sends
the page's origin.

The grant stores the Access email and subject, the client id and name, and
the scopes. The provider's user id is the URL-encoded email.

### Identity on the standalone server

Not available yet. A standalone server has no Cloudflare Access, and accounts
arrive with Gate 2, so there is nobody who can approve a connection. The consent
route is the Worker's, and it asks the same function who is signing in. The
standalone server's answer is "nobody" (`consentAuthenticator` in
`src/worker/standalone.ts`): the page says that accounts are not built, sets no
cookie, stores no transaction and creates no grant, whatever the request carries
(an Access header, a bearer token, a cookie, a form field). The account session
replaces that function when Gate 2 ships, and the signed-in account becomes the
identity of a grant, as the Access email is on the Worker.

A secret typed into the consent form (the `ADMIN_TOKEN`) was built for this and
dropped. It would hand the one secret that opens everything to a page an app sent
the operator to, and the check cannot tell the real page from a copy of it.

What exists today, and what it exposes when `FK_MCP=on` is set:

- The OAuth endpoints and `/mcp` answer. Metadata names the issuer and resource
  from `FK_PUBLIC_URL`, never from the request. A request that names another
  origin is refused.
- `/oauth/register` accepts clients and is open by design (RFC 7591). It is
  limited to 30 registrations an hour per client address, because each one
  writes to the database that holds the feedback.
- Nothing can be approved, so no token, no grant and no tool call exists.
- The server refuses to start with MCP on where a sign-in would travel in clear
  text: an http `FK_PUBLIC_URL` that is not localhost, or `HOST` open to other
  addresses with an http address.
- The start log and `/diag` (`mcp`) say whether MCP is on.

The tests give consent an identity with a stub that exists in test code only. The
production build has no way to receive one: `createMcpFetch` takes the function as
an argument and the server passes none. A test checks that the built server does
not contain the stub.

### Scopes and tools

| Scope | Tools |
|---|---|
| none | `whoami` |
| `feedback:read` | `list_projects`, `list_feedback`, `get_feedback`, `search_feedback`, `get_funnel`, `search`, `fetch` |
| `config:read` | `get_config` |

The server registers only the tools a grant's scopes allow, so a call to any
other tool fails as unknown. The queries are the admin API's
(`src/worker/admin/queries.ts`). `get_feedback` copies fields from the stored
payload by name: message, follow-up answer, extracted fields, summary, page URL
and device. The Turnstile token, the honeypot and any field added later stay
out until someone names them. The gateway stores no IP address with feedback,
so none can appear. The host context is included under `hostContext` with
`verified: false`: the embedding page sets it and the gateway never checks it.
Search uses `LIKE` with `%`, `_` and `\` escaped and a 200-character limit.
`get_config` returns secrets by name, never by value.

### Protocol revisions

`/mcp` speaks MCP revision 2026-07-28 and still answers clients of 2025-11-25
and earlier. The handler is the Agents SDK's `createMcpHandler` over MCP SDK
2.0.0, which implements the revision; the gateway adds the grant, the scope
filter and the rate limit. A conformance suite runs the same requests on workerd
and on Node (`test/durable/mcp-spec-2026-07-28.test.ts`).

- **Per-request metadata.** Every 2026-07-28 request carries
  `MCP-Protocol-Version` and `Mcp-Method` (and `Mcp-Name` on `tools/call`) as
  headers, and the version and `clientCapabilities` in `_meta`. The server checks
  the headers against the body: a mismatch or a missing header is `400` with
  `-32020`, a missing `_meta` key `400` with `-32602`, an unknown version `400`
  with `-32022` and the versions it supports, an unknown method `404` with
  `-32601`. A Base64 `Mcp-Name` is decoded before the comparison.
- **Results.** Every result has `resultType: "complete"` and the server's name in
  `_meta`. `server/discover` answers with versions, capabilities and
  instructions. `tools/list` and `server/discover` carry `ttlMs` (0 today) and
  `cacheScope: "private"`: the list depends on the grant's scopes, so a shared
  cache must never serve one grant's list to another. The tool order is fixed
  (the order written in the test), the same for every call and every grant.
- **No sessions.** No `Mcp-Session-Id` is minted or echoed, `Last-Event-ID` is
  ignored, GET, DELETE and OPTIONS answer `405`, a JSON-RPC batch of new-style
  requests is refused, and a notification gets `202`. An `Origin` that is not
  localhost is refused with `403`.
- **Older clients.** `initialize` with 2025-11-25, 2025-06-18 or 2025-03-26,
  `tools/list` without `_meta`, and `tools/call` work, with the same tools in the
  same order and the same scope filter.

Known limits, each pinned by a test so that a newer SDK shows up as a failing test:
`server/discover` and the unsupported-version error list only `2026-07-28`, although
older clients are served (the Agents SDK serves them beside the SDK handler); the
tools capability says `listChanged: true` and a `subscriptions/listen` stream is
acknowledged and held open, but the tool set of a request never changes, so nothing
follows; the `Origin` refusal uses the legacy-range code `-32000`; and an invalid
`tools/list` cursor is ignored (the list has one page). The 2026-07-28 revision
deprecates Dynamic Client Registration in favor of Client ID Metadata Documents. The
Worker offers both, and a standalone server offers registration only (see above), so
a client that insists on Client ID Metadata Documents cannot connect there.

### Untrusted content

Feedback is written by anyone who can open the widget. Every tool that returns
it says in its description, and the server says in its instructions, that the
fields are data to analyze and not instructions to follow. That lowers the risk
of prompt injection through feedback text; it does not remove it. Operators
should keep agents that read feedback away from write tools they would not
trust with a stranger's text.

### Rate limit

`/mcp` counts requests per grant (Access email plus client id) and hour in the
`counters` table (D1, or SQLite on the standalone server), keyed by an HMAC like the IP limiter, so the table holds no
email. Above 1000 requests an hour the endpoint answers `429` with
`Retry-After` until the hour is over.
