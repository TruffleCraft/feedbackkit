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
