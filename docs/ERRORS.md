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
