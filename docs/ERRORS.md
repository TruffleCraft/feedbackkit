# Error codes

Error responses from the gateway carry a stable `code` next to the human-readable
`error` string. Match on `code`; the `error` text may change.

```json
{ "v": 1, "status": "error", "error": "report could not be stored, please retry", "code": "FK_PERSIST_FAILED", "retryable": true }
```

## `FK_PERSIST_FAILED`

**Where:** `POST /api/feedback`, HTTP `503`, header `Retry-After: 5`, `retryable: true`.

**What happened:** the report did not reach the issue tracker (a `noIssue` type,
a missing PAT, a tracker error, or an internal error) and the gateway could not
store it in D1 either. Nothing was acknowledged, so nothing is lost on the
gateway's side, but nothing is kept there either.

**Recovery (client):** resend the same payload with the same `feedbackId` after
`Retry-After`. The bundled widget keeps the text, type, follow-up answer and the
already uploaded attachments and offers "Try again", which does exactly that.
The `feedbackId` is unique per project, so a resend never creates a second row.

**Fix (operator):** the D1 binding is failing. Check `/diag` (`schema`,
`bindings.DB`) and the Worker logs for `feedback journey write failed`.

## `FK_CONFIG_SHAPE_UNSUPPORTED`

**Where:** `POST /api/admin/config/import`, HTTP `422`, with `required` and
`available`; `pnpm seed --remote` prints the same and exits 1.

**What happened:** the config uses delivery settings (`delivery`,
`tracker.project`, or no `tracker`) that the live stable release cannot handle
yet. dev and stable share one D1, so storing it would break the project on
stable. Nothing was stored.

| `required` | Needs |
|---|---|
| 1 | `delivery` set anywhere, or no `tracker` |
| 2 | `delivery: "project"` or `tracker.project` |

**Fix:** promote a release that handles it (the promote workflow records its
level in `meta.delivery_capability`), or keep `tracker` and `noIssue` for now.
On a local `wrangler dev` database, insert the row yourself:
`INSERT INTO meta (key, value) VALUES ('delivery_capability', '1')`.

## Delivery retry (`POST /api/admin/feedback/:id/retry`)

Body: `{}` or `{ "createAnyway": true }`. A delivered report answers `200` with
`status: "delivered"` and the issue URL or the Project item.

| Code | HTTP | Meaning | What to do |
|---|---|---|---|
| `FK_RETRY_IN_PROGRESS` | 409, `Retry-After` | Another delivery of this report holds the claim (at most 2 minutes). | Wait and retry. |
| `FK_DELIVERY_UNKNOWN` with `needsCreateAnyway: true` | 409 | An earlier attempt may have created the draft, and none with this report's marker was found in the newest 500 items. | Look in the Project. If it is not there, retry with `{"createAnyway": true}`. |
| `FK_DELIVERY_UNKNOWN` | 502 | GitHub did not answer clearly this time (timeout, 5xx). | Retry; the next attempt looks for the marker first. |
| `FK_DELIVERY_FAILED` | 502, `githubStatus` | GitHub refused (401/403: token or permission, 404: project or repo not found, 422: invalid). | Fix the token or config, then retry. |
| `FK_NOT_RETRYABLE` | 409 | The report is stored locally, or predates stored drafts. | Nothing to deliver. |
| `FK_NOT_FOUND` | 404 | No report with this id. | Check the id. |

Widgets never see these codes: a report saved with a pending delivery is
answered as `issue_failed`, as before.

## Accounts, sessions and tokens

Routes under `/api/auth/*` (public) and the account, accounts and tokens routes under `/api/admin/*`. The route `/api/admin/accounts` and the codes keep their names; the admin calls the people it lists users. Design: [design/gate2-accounts.md](design/gate2-accounts.md).

| Code | HTTP | Where | Meaning and what to do |
|---|---|---|---|
| `FK_SETUP_LINK_INVALID` | 410 | setup begin and finish | The one-time link is unknown, was already used, or expired. Ask for a new one: `feedbackkit-admin setup-link` or `recovery-link` on the host, `pnpm admin:link` on Cloudflare, or an owner for an invitation |
| `FK_OWNER_EXISTS` | 409 | setup, `setup-link` | This instance already has an owner. Sign in, or ask for a recovery link |
| `FK_NO_OWNER` | 409 | `recovery-link` | There is no owner to recover. Run `setup-link` |
| `FK_PASSKEY_REJECTED` | 400 | setup finish, add passkey | The browser's answer did not verify: wrong origin or relying party, no user verification, a challenge that expired or was already used. Start the step again, on the address in `FK_PUBLIC_URL` |
| `FK_PASSKEY_EXISTS` | 409 | setup finish, add passkey | This passkey is already registered |
| `FK_SIGNIN_FAILED` | 401 | sign-in finish | The passkey is unknown or the assertion did not verify. Counted as a failed attempt |
| `FK_AUTH_THROTTLED` | 429, `Retry-After` | failed attempts | Too many failed attempts from this address or against this account in the last hour. A correct sign-in or token still works. `Retry-After` is the seconds until the hour ends |
| `FK_AUTH_UNAVAILABLE` | 503 | sign-in begin, setup begin | The storage could not give the instance secret that signs challenges. Retry |
| `FK_CSRF` | 403 | every write on a session | The `X-CSRF-Token` header is missing or wrong, or the request did not come from this origin. The page reads the token from `GET /api/admin/me` |
| `FK_SESSION_REQUIRED` | 403 | account, accounts and tokens routes | Needs a signed-in person (a passkey session). Tokens, Cloudflare Access and the legacy `ADMIN_TOKEN` cannot do this |
| `FK_FORBIDDEN` | 403 | accounts and tokens routes | Only an owner can do this |
| `FK_HOST_REQUIRED` | 403 | `POST /api/admin/accounts/:id/link` | An active owner is recovered with the host command, not from the admin |
| `FK_ADMIN_TOKEN_RETIRED` | 401 | any admin route | The `ADMIN_TOKEN` is right but this instance has an owner, so it grants nothing. Sign in, or use a scoped API token |
| `FK_TOKEN_UNKNOWN`, `FK_TOKEN_REVOKED`, `FK_TOKEN_EXPIRED` | 401 | any admin route | The API token does not exist, was revoked, or ended. Create a new one |
| `FK_TOKEN_SCOPE` | 403 | any admin route | A read-only token on a write, or a token limited to projects on a route outside them (or one that is not about a project: system, config import, project creation) |
| `FK_TOKEN_INVALID` | 400 | `POST /api/admin/tokens` | Name, access, projects (known project IDs) or lifetime (1 to 365 days) is wrong |
| `FK_TOKEN_LIMIT` | 409 | `POST /api/admin/tokens` | An account can hold 100 active tokens. Revoke one |
| `FK_TOKEN_NOT_FOUND`, `FK_ACCOUNT_NOT_FOUND`, `FK_PASSKEY_NOT_FOUND`, `FK_SESSION_NOT_FOUND` | 404 | the matching routes | No such token, user, passkey or session |
| `FK_ACCOUNT_EXISTS` | 409 | invite | A live user has this name (case does not matter) |
| `FK_ACCOUNT_STATE` | 409 | link routes, setup finish | The user is in the wrong state for this: an invitation for a user who was set up, a recovery link for one who was not, or a user who was removed |
| `FK_ROLE_INVALID`, `FK_NAME_INVALID`, `FK_BODY_INVALID` | 400 | the matching routes | Role is owner or member, a name has 1 to 64 characters without control characters, a body is a JSON object under 32 kB |
| `FK_LAST_OWNER` | 409 | role change, remove | The last active owner cannot be demoted or removed. Make someone else an owner first |
| `FK_LAST_PASSKEY` | 409 | remove passkey | An account keeps at least one passkey. Add another first |
| `FK_INTERNAL` | 500 | any account route | Something unexpected. Nothing about the cause is sent; the log has the line |

## Admin writes

| Code | HTTP | Where | Meaning |
|---|---|---|---|
| `FK_CONFIG_INVALID` | 400 | config import, validate, publish | The config failed validation (`issues` lists each JSON path), `projectId` differs from the project, a secret name is not `GITHUB_PAT_<name>`, `storage.retentionDays` is below 7, a type ID or field key is used twice, a published type is dropped or renamed (archive it instead), every type is archived, or `expectedVersion` is missing. |
| `FK_CONFIG_TOO_LARGE` | 413 | `POST /api/admin/projects` | The config is larger than 512 kB. |
| `FK_PROJECT_ID_INVALID` | 400 | `POST /api/admin/projects` | The project ID is not 1 to 64 lowercase letters, digits, hyphens or underscores. |
| `FK_PROJECT_EXISTS` | 409 | `POST /api/admin/projects` | A project with this ID exists. Create never overwrites; its settings were not changed. A successful create answers 201 with `projectId`, `publicKey`, `configVersion`, the widget `snippet` and the `testPage` URL. |
| `FK_CONFIG_STALE` | 409 | `PUT /api/admin/projects/:id/config` | Someone published since you loaded it. The answer carries the current `configVersion` and `config`; review the diff and publish again. |
| `FK_NOT_LOCAL` | 409 | `PATCH /api/admin/feedback/:id` | The report was delivered to GitHub; triage it there. |
| `FK_DELETE_INCOMPLETE` | 502 | `DELETE /api/admin/feedback/:id` | Some attachments could not be deleted (`failedKeys`). The report is kept; try again. |
