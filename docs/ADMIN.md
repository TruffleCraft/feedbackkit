# Admin guide

Open `/admin` on your gateway. The project list, project settings and delivery log use the same API on both installations.

## Project settings

| Section | What you manage |
|---|---|
| General | Origins, language, accepting/pausing feedback, rate limit, capture, privacy, retention and bot protection |
| AI & follow-ups | Provider, exact model ID, API base URL, structured output and maximum calls per day |
| Types & delivery | Types, labels, guidance, fields, choice options, required fields, issue body and GitHub destinations. A type ID and a field key are unique, and a published type ID never changes: **Archive** hides a type from visitors and from the AI while its reports keep their label and destination (`"archived": true`), and the gateway refuses settings that drop or rename a published type |
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
| **0.x.y available**, **Up to date** or **Check failed** in the Release row of System | Whether a newer release exists. Release tarball installs only; Cloudflare and checkouts show the channel instead | The gateway asks GitHub at most once a day. `FK_UPDATE_CHECK=off` turns it off |
| **Schema / wire version** in diagnostics | Database/API compatibility | A release changes the contract or schema |

Two projects can have different settings revisions while using exactly the same FeedbackKit release. Revision 11 is not newer software than revision 9. The settings revision also prevents lost updates and lets widgets refresh cached settings.

## Delivery log, not a second issue tracker

The log answers: did FeedbackKit receive the report, where did it send it, and did that delivery succeed? It does **not** claim to show the current GitHub ticket status. A successfully created issue remains a successful delivery even after it is closed in GitHub. Follow its issue/Project link for comments, current status and triage.

Delivery errors and uncertain results stay visible. **Retry** repeats a supported saved delivery. If an earlier attempt may already have created a draft, check GitHub before confirming creation again. AI failure is separate from delivery failure: feedback can still reach its destination without AI enrichment.

Only reports delivered to the **FeedbackKit inbox** have a local Open/Done/Dismissed lifecycle. The **Inbox: open** and **Inbox: handled** filters refer to those reports. Older records whose destination is unknown appear under **Needs a decision**. Delivered GitHub reports do not acquire a competing local ticket status.

Retention applies to log records, inbox reports and attachments whether handled or not. It is not an indefinite audit archive. Retention must be at least 7 days, the notice period for unhandled reports; the gateway refuses a shorter value when settings are written. When a review changes the retention, it states how many stored reports and attachments the next daily cleanup deletes, and you cannot publish before you have seen it. Deleting a FeedbackKit record or attachment does not close or delete its GitHub ticket.

## Accounts and tokens

People sign in with passkeys. An **owner** can invite members and other owners, renew a link, change roles, remove accounts and create **API tokens**; a **member** can use every other admin route (authorization by project comes with Step 4). Scripts and agents use an API token, never a person's session: it is shown once, is read-only or can write, covers all projects or a list, and ends after 1 to 365 days (90 by default). A token cannot create tokens or accounts, and a token limited to projects cannot open the system page, import settings or create projects. Revoking a token or removing an account takes effect on the next request.

The last owner cannot be demoted or removed, and an account always keeps one passkey. If every passkey is lost, an operator with host access issues a recovery link (`feedbackkit-admin recovery-link`, or `pnpm admin:link --recovery` on Cloudflare): it replaces the account's passkeys, signs out its sessions and revokes the API tokens that account created (recovery is also the path after a lost or exposed credential; `--keep-tokens` opts out). Create new tokens afterwards. How to set it up: [SELF_HOSTING.md](SELF_HOSTING.md#accounts-and-recovery) and [QUICKSTART.md](QUICKSTART.md#accounts). The API errors are in [ERRORS.md](ERRORS.md#accounts-sessions-and-tokens). The screens are **Your account** (your passkeys and sessions; the name in the header opens it), **Accounts** and **API tokens**, with the sign-in and setup pages beside them.

## Agents

On Cloudflare an agent can read projects, feedback and the funnel through the gateway's MCP server, without the admin token in its hands. Whoever approves a connection signs in through Cloudflare Access first, and the agent gets read-only scopes ([setup](QUICKSTART.md#mcp-for-agents)). A server installation cannot approve connections yet, because the consent step does not use the accounts yet ([MCP for agents](SELF_HOSTING.md#mcp-for-agents)).

## Credentials and hosting

On Cloudflare, use Worker secrets. On a server or LXC, use the protected environment file used by the service; for a foreground run use `.env`. Restart the standalone service after changing credentials. Project settings can be edited and published without restarting.

A GitHub token needs access to the configured repository or organization Project. Inbox-only operation needs none. AI needs `LLM_API_KEY`; switching the provider off keeps required-field forms available. Prefer restricted credentials for each gateway.

Co-created by Michel with NORA (AI Agent)
