<!-- /autoplan restore point: "/Users/michelschieder/Repos/feedbackkit-wt-admin-mockup/.gstack/tmp/autoplan/design-admin-inbox-mockup-autoplan-restore-20261024-171629.md" -->
# Feedback delivery to GitHub Projects, local inbox and config editor

Mockup of the first, wider concept (superseded by the hybrid decision): [`mockup-admin-inbox-2026-10-24.html`](mockup-admin-inbox-2026-10-24.html)

## Implementation plan

Decision 2026-10-24 (owner, after the CEO review): hybrid. Triage lives in a private GitHub Project; FeedbackKit owns capture, delivery, config, funnel and history. A minimal local inbox exists only for projects without GitHub.

### Problem

The admin UI at `/admin` (ADR-014) is read-only. Operators cannot act on a report and cannot change a project's config without `curl` against `POST /api/admin/config/import`.

Projects that should not open issues automatically use `noIssue: true` (getClosr on every type). Their reports sit in D1 where nobody can mark them done or turn them into an issue later. Worse, two existing defects hit exactly these reports:

- `persistFeedback` swallows D1 errors and the `noIssue` path still answers `created` (`src/worker/orchestrate.ts:301`, `:414`), so a report can be acknowledged and lost.
- The retention cron deletes feedback by submission age (`src/worker/storage/retention.ts:23`). getClosr has `retentionDays: 30`, so its unhandled reports vanish after 30 days.

### Goal

1. **No silent loss.** A report that is not delivered anywhere else is only acknowledged after D1 stored it; otherwise the gateway answers a retryable error. The widget's retry must keep the visitor's text and type: today `retry` resets the form to empty (`src/widget/core/state.ts:75`), so the `failed` state carries the last message and `retry` restores it.
2. **Retention never deletes unhandled work.** A report counts as handled when it was delivered to GitHub (issue or project item) or locally marked done or dismissed. Unhandled reports past retention stay and show up on the System page.
3. **Three deliveries per type:** `issue` (today's automatic issue), `project` (a draft issue in a private organisation GitHub Project), `local` (stored in FeedbackKit only). `noIssue: true` is read as `delivery: "local"`.
4. **GitHub Project delivery.** Each report becomes a draft issue with the rendered title and body (screenshot as R2 link), plus project fields Type, Page and Source set by FeedbackKit. Status, notes, assignment and "Convert to issue" happen in GitHub. FeedbackKit stores the project item ID and links to it. No status mirror.
5. **Minimal local inbox** for `local` deliveries only: open, done, dismissed; one note; delete (row and R2 assets); copy as Markdown for an agent. Reports delivered to GitHub show their link and no local status.
6. **Config editing in the admin** as a validated JSON editor: load the stored config, edit, validate on the server (Zod issues shown inline), show the diff to the stored version, publish (bumps `config_version` like the import). A form editor comes later.
7. **Type clarity** in the history: each row leads with a type glyph and word.

Out of this plan: the visual restyle (own ADR amending ADR-014, own PR), MCP write scopes (own security decision per ADR-015), a status mirror, a form-based config editor, GitLab/Jira/Trello.

### Delivery to a GitHub Project

- Auth: the existing per-project fine-grained PAT gains the organisation permission "Projects: read and write". REST endpoints (documented for fine-grained PATs): `POST /orgs/{org}/projectsV2/{project_number}/drafts`, `PATCH /orgs/{org}/projectsV2/{project_number}/items/{item_id}`, `GET /orgs/{org}/projectsV2/{project_number}/fields`. User-owned projects are not supported (no fine-grained permission; a classic PAT would be too broad).
- Field mapping: Type (single select, option names from the template labels), Page (text), Source (single select, fixed "FeedbackKit"). Missing fields or options are skipped with a warning in `/diag`, never a failed delivery.
- Failure: like a tracker failure today. Row persisted with `outcome = "delivery_failed"`, the rendered draft stored, retry from the admin through the existing retry path.
- Confidentiality: converting a draft to an issue may change the audience (repo permissions). The body never contains the host context marked unverified beyond what automatic issues contain today, and never the local note.
- Attention: drafts do not notify assignees until converted (GitHub docs). The admin project list shows "new in the last 7 days" per project with a link to the Project, so new reports stay visible without a notification system.

### Config contract (`src/shared/contract.ts`)

- Template `delivery?: "issue" | "project" | "local"`; project-level `delivery` default: `"issue"` when `tracker` exists (today's behaviour), else `"local"`. `noIssue: true` normalises to `"local"`.
- `tracker.project?: { org: string; number: number }`, required when any delivery is `project`.
- `tracker` optional when every delivery is `local`.
- Refinements: `issue` needs `tracker.defaultRepo`; `project` needs `tracker.project`.
- All six readers of `config.tracker` handle an absent tracker: `contract.ts`, `orchestrate.ts`, `app.ts` (`/diag`), `status.ts`, `admin/routes.ts` (system), `admin/main.ts`.
- **Compatibility across channels:** dev and stable share one D1 (ADR-013) and today's stable parser requires `tracker`. The read side ships and is promoted to stable first; the import and the editor refuse the new shapes (`delivery`, absent `tracker`, `tracker.project`) until the stable release that reads them is live. A config written by the editor is stored exactly as written (no normalisation on write), so seed files in git round-trip.

### Data model (schema v3, expand only)

`migrations/0003_delivery.sql`:
- `feedback.delivery TEXT` (`issue | project | local`), `feedback.project_item_id TEXT`, `feedback.project_url TEXT`
- `feedback.disposition TEXT NOT NULL DEFAULT 'open'` (`open | done | dismissed`, only meaningful for `local`), `feedback.note TEXT`, `feedback.handled_at INTEGER`
- `feedback.promote_lock INTEGER` (claim before a delivery retry so two clicks cannot create two items)
- index `(project_id, delivery, disposition, created_at)`
- `meta.schema_version = 3`

Backfill: rows with `issue_url` get `delivery = 'issue'` and count as handled; rows of `noIssue` templates get `delivery = 'local'`, `disposition = 'open'`.

### Worker

- `orchestrate.ts`: branch per template delivery. `local`: persist, and if persisting fails answer 503 (retryable) instead of `created`. `project`: create the draft, then persist with the item ID; on failure persist as `delivery_failed` with the draft. `issue`: unchanged.
- `persistFeedback` returns success so callers can act on it.
- Retention (`retention.ts`): delete only rows that are handled and older than `retentionDays`; count unhandled rows past retention for the System page. Events keep their own age rule.
- Admin write routes in `src/worker/admin/routes.ts`, behind `adminGate`, whose Access path already enforces `sameOrigin()` (`src/worker/admin/auth.ts:40`):
  - `PATCH /api/admin/feedback/:id` (disposition, note; `local` rows only)
  - `DELETE /api/admin/feedback/:id` (row + R2 assets via `deleteAssetsForFeedback`)
  - `POST /api/admin/feedback/:id/retry` (`issue_failed` and `delivery_failed`, claims `promote_lock`)
  - `POST /api/admin/projects/:id/config/validate` and `PUT /api/admin/projects/:id/config` (same validation and version bump as the import)
- System page: Project access check per project (fields readable, draft write allowed via a dry run against the fields endpoint), unhandled rows past retention.

### Admin frontend (current design tokens)

- Project list: add "new in 7 days" and the delivery mode with a link to the GitHub Project or repo.
- History view: type glyph + word first in each row; delivered rows link out; `local` rows get disposition buttons, note, delete and "copy as Markdown"; tabs Open / Done / All for local rows.
- Config tab: JSON editor (textarea with line numbers), server validation, diff, publish.
- Budget 15 kB gz for `dist/admin.js` stays.

### Tests

- Vitest: `local` + D1 failure answers 503 (not `created`); widget reducer: `retry` after `failed` restores the last text and type; retention keeps unhandled rows; contract normalisation `noIssue` → `local`, refinements, absent tracker in all six readers; project delivery success, field skip, failure → `delivery_failed` + retry; retry lock against double click; config validate/PUT version bump; cross-origin write through the Access path refused.
- Playwright with the mocked API: local disposition change, note, delete, copy Markdown; delivered row links; JSON editor validation error and publish; phone layout.

### Rollout

1. Durability and retention fix, including the widget retry that keeps the text (no contract change). Ships first, alone.
2. Contract read support + schema v3, promoted to stable.
3. Project delivery + retry + System checks.
4. Admin: local inbox, links, JSON config editor.
5. getClosr: create a private Project in `getclosr-link`, grant the PAT "Projects: write", switch its types from `noIssue` to `delivery: "project"`.

Effort: one PR per step; steps 1 and 2 about half a day each with an agent, steps 3 and 4 about a day each. UI PRs go to the maintainer for merge (repo rule).

## Review record

### GitHub Projects facts (input to the CEO review)

The owner asked whether a private GitHub Project (Projects v2) could replace the self-built inbox for projects without a repository. Facts from the GitHub docs (fetched 2026-10-24):

- Projects can hold **draft issues** that "exist only in your project" with title, body, assignees and custom fields; labels, repository and milestone need a conversion to an issue first. ([Adding items](https://docs.github.com/en/issues/planning-and-tracking-with-projects/managing-items-in-your-project/adding-items-to-your-project#creating-draft-issues))
- A draft issue can be **converted to an issue** in a chosen repository from the project UI. That is the "promote" step, built in. ([Converting draft issues](https://docs.github.com/en/issues/planning-and-tracking-with-projects/managing-items-in-your-project/converting-draft-issues-to-issues))
- API: GraphQL `addProjectV2DraftIssue`, `updateProjectV2ItemFieldValue` (custom text, number, date, single select such as Status or Type), `deleteProjectV2Item`; a `projects_v2_item` webhook exists. Needs a token with the `project` scope: a **classic PAT** or a **GitHub App installation token**. ([Using the API](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects))
- Fine-grained PATs have an **organization** permission "Projects" (read/write, including `POST /orgs/{org}/projectsV2/{project_number}/drafts`), but no user-level Projects permission in the fine-grained permission list. User-owned projects therefore need a classic PAT with the broad `project` scope. ([Fine-grained PAT permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens))
- Visibility can be **private**: only users granted at least read access see the project. Items from private repos stay hidden from people without repo access. ([Visibility](https://docs.github.com/en/issues/planning-and-tracking-with-projects/managing-your-project/managing-visibility-of-your-projects))
- Limits: 50,000 items per project, 50 fields; built-in workflows can auto-archive items; views as table, board and roadmap; insights charts. ([About Projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects/learning-about-projects/about-projects))

What it would replace: the triage status, notes, the promote dialog, the GitHub mirror sync and the "In GitHub" tab (a converted draft stays the same project item, so its status lives in one place). What it would not replace: the config editor, the funnel, the system page and the feedback history in D1. Open points: every triager needs a GitHub account with project access; screenshots only as links to the R2 public URL in the body; privacy-first self-hosters without GitHub get no inbox; GitLab, Jira and Trello (P4) have no equivalent here.


### Phase 1: CEO review (2026-10-24, autoplan, run design-admin-inbox-mockup-20261024-171629)

Voices: native (Claude subagent, input `ceo d49f52fa…`) completed; outside (Codex `gpt-6-astra`, exec, high effort) completed, verdict `findings`, P0.

```
CEO DUAL VOICES — CONSENSUS TABLE:
  Dimension                            Claude  Codex  Consensus
  1. Premises valid?                    No      No     CONFIRMED (no)
  2. Right problem to solve?            Partly  Partly CONFIRMED (deferred triage yes, second tracker no)
  3. Scope calibration correct?         No      No     CONFIRMED (too broad)
  4. Alternatives sufficiently explored?No      No     CONFIRMED (Projects v2 researched, not decided)
  5. Competitive/market risks covered?  No      No     CONFIRMED (inbox is not the edge)
  6. 6-month trajectory sound?          No      No     CONFIRMED (mirror sync, two work UIs)
```

Verified against the code by the orchestrator:

- REALITY: `persistFeedback` swallows D1 errors and the `noIssue` path still answers `created` (`src/worker/orchestrate.ts:301`, `:414`). An inbox-only report can be acknowledged and lost. Existing bug, independent of this plan.
- REALITY: `pruneExpiredRecords` deletes feedback by submission age (`src/worker/storage/retention.ts:23`). getClosr has `retentionDays: 30` and `noIssue` on every type, so its unhandled reports disappear after 30 days today.
- REALITY: the CSRF concern on the Access path is already handled by `sameOrigin()` (`src/worker/admin/auth.ts:40`); the plan must reuse it and add a cross-origin write test.
- REALITY: `config.tracker` is read in 6 source files (`contract.ts`, `orchestrate.ts`, `app.ts`, `status.ts`, `admin/routes.ts`, `admin/main.ts`); the plan named one.
- REALITY: dev and stable share one D1 (ADR-013) and the stable parser requires `tracker`; writing a tracker-less config from a dev build would break the project on stable.

User Challenge (both voices, never auto-decided): replace the full native inbox with
1. a durability fix for inbox-only submissions and a retention rule that never deletes unhandled reports,
2. a thin delivery adapter that writes reports as draft issues into a private organisation GitHub Project (triage, notes and "convert to issue" live in GitHub; no mirror sync),
3. a minimal local disposition (open/done, note, delete, Markdown export) only for projects without GitHub,
4. config editing as a validated JSON editor first, the form later,
5. the visual restyle as its own ADR and PR.

Both voices recommend a manual pilot first: triage ten existing reports in a private Project for 14 days.

Phases 2 (design), 2.5 (DX) and 3 (eng) are paused until the owner decides the User Challenge, because they would review an inbox design that this challenge removes.
