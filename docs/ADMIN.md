# Admin guide

Open `/admin` on your gateway. The project list, project settings and delivery log use the same API on both installations.

## Project settings

| Section | What you manage |
|---|---|
| General | Origins, language, accepting/pausing feedback, rate limit, capture, privacy, retention and bot protection |
| AI & follow-ups | Provider, exact model ID, API base URL, structured output and maximum calls per day |
| Types & delivery | Types, labels, guidance, fields, choice options, required fields, issue body and GitHub destinations |
| Appearance | Automatic/light/dark theme, accent color and widget heading |
| Advanced JSON | The same draft in JSON, for automation or bulk edits |

Use **Configure** or **Add a setting** to add optional settings. Removing an optional setting restores its schema default; for retention, omission means keep records until explicit deletion. Existing type/field IDs are fixed in forms so renaming a label does not orphan stored data. Review removals before publishing. Secret inputs are environment variable **names**, never credentials.

Choose **Review changes** before **Publish**. Validation checks the full draft on the gateway and shows destinations and a diff. A changed draft must be reviewed again. If another admin saved in the meantime, publication returns a conflict instead of silently overwriting their work. Your draft stays available for comparison.

## What do the version numbers mean?

| Where you see it | Meaning | When it changes |
|---|---|---|
| **Settings revision 9** on a project | That project's configuration counter | Each successful publication/import increments it |
| **FeedbackKit `0.x.y`** on System or `/diag` | The gateway software release | Installing/upgrading a release |
| **`dev` / `stable`** | Cloudflare release channel | The gateway URL and installed build determine it |
| **Schema / wire version** in diagnostics | Database/API compatibility | A release changes the contract or schema |

Two projects can have different settings revisions while using exactly the same FeedbackKit release. Revision 11 is not newer software than revision 9. The settings revision also prevents lost updates and lets widgets refresh cached settings.

## Delivery log, not a second issue tracker

The log answers: did FeedbackKit receive the report, where did it send it, and did that delivery succeed? It does **not** claim to show the current GitHub ticket status. A successfully created issue remains a successful delivery even after it is closed in GitHub. Follow its issue/Project link for comments, current status and triage.

Delivery errors and uncertain results stay visible. **Retry** repeats a supported saved delivery. If an earlier attempt may already have created a draft, check GitHub before confirming creation again. AI failure is separate from delivery failure: feedback can still reach its destination without AI enrichment.

Only reports delivered to the **FeedbackKit inbox** have a local Open/Done/Dismissed lifecycle. The **Inbox: open** and **Inbox: handled** filters refer to those reports. Older records whose destination is unknown appear under **Needs a decision**. Delivered GitHub reports do not acquire a competing local ticket status.

Retention applies to log records, inbox reports and attachments whether handled or not. It is not an indefinite audit archive. Retention must be at least 7 days, the notice period for unhandled reports; the gateway refuses a shorter value when settings are written. When a review changes the retention, it states how many stored reports and attachments the next daily cleanup deletes, and you cannot publish before you have seen it. Deleting a FeedbackKit record or attachment does not close or delete its GitHub ticket.

## Credentials and hosting

On Cloudflare, use Worker secrets. On a server or LXC, use the protected environment file used by the service; for a foreground run use `.env`. Restart the standalone service after changing credentials. Project settings can be edited and published without restarting.

A GitHub token needs access to the configured repository or organization Project. Inbox-only operation needs none. AI needs `LLM_API_KEY`; switching the provider off keeps required-field forms available. Prefer restricted credentials for each gateway.

Co-created by Michel with NORA (AI Agent)
