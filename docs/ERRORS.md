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
