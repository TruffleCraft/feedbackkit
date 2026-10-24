<!-- /autoplan restore point: "/Users/michelschieder/Repos/feedbackkit-wt-admin-mockup/.gstack/tmp/autoplan/design-admin-inbox-mockup-autoplan-restore-20261024-171629.md" -->
# Admin inbox, delivery modes and config editor

Mockup: [`mockup-admin-inbox-2026-10-24.html`](mockup-admin-inbox-2026-10-24.html)

## Implementation plan

### Problem

The admin UI at `/admin` (ADR-014) is read-only. Operators can see projects, the feedback history, the funnel and the system page, but they cannot act on a report and cannot change a project's config without `curl` against `POST /api/admin/config/import`.

This hurts most on projects that are not coupled to Git. getClosr sets `noIssue: true` on every template because its reports should not open issues automatically, so its reports exist only in D1 and the read-only history. Nobody can mark them done, dismiss them, note what was decided, or turn a good one into an issue later. NORA and SCTT have the same need on a smaller scale. The tracker block in `FeedbackConfig` is also mandatory today (`tracker.kind: "github"`, `defaultRepo`, `patSecret`), so a project without any repository has to carry a fake tracker.

### Goal

1. A triage inbox per project where every report can be worked: status (open, in progress, resolved, dismissed), an internal note, type correction, delete, copy as Markdown for an agent.
2. Three delivery modes per project, with a per-type override:
   - **Inbox only**: no GitHub connection at all. The tracker block becomes optional.
   - **Inbox first**: GitHub connected. Reports wait in the inbox, the operator promotes single reports to an issue through an editable draft.
   - **Automatic**: today's behaviour, every report opens an issue.
   Per-type `delivery` replaces `noIssue` (read as `delivery: "inbox"` for backward compatibility).
3. A config editor in the admin: a form for delivery, GitHub repo and secret name with a live connection check, origins, capture switches, LLM provider, model, budget and rate limit, the type table with per-type delivery; plus a JSON import/export mode that round-trips through `FeedbackConfig`. Publishing bumps `config_version` exactly like the import does today.
4. Sync rule so there is no double work and no stale items: once a report has an issue, GitHub owns its status. FeedbackKit mirrors it read-only (open/closed in GitHub), the inbox "Open" tab lists only reports without an issue, a separate "In GitHub" tab lists linked ones. Mirror refresh happens lazily when the inbox loads (visible linked items, through the project's PAT) and nightly in the existing `0 3 * * *` cron. An issue that disappears (deleted, transferred out of reach) drops the report back into the inbox with a notice. Resolved and dismissed reports are deleted after a configurable retention together with their R2 assets.
5. Type clarity: every row leads with a type glyph plus word; the detail shows the type as a select with its source (detected by AI, chosen by the visitor, changed by the operator), locked once an issue exists.
6. Visual direction: taste-skill app style "Framed sheet" (IBM Plex Sans, teal accent `#1b6c80`, tinted L-frame and white sheet). The brand mark keeps the FeedbackKit violet.

### Alternative to evaluate: a private GitHub Project as the inbox

The owner asked whether a private GitHub Project (Projects v2) could replace the self-built inbox for projects without a repository. Facts from the GitHub docs (fetched 2026-10-24):

- Projects can hold **draft issues** that "exist only in your project" with title, body, assignees and custom fields; labels, repository and milestone need a conversion to an issue first. ([Adding items](https://docs.github.com/en/issues/planning-and-tracking-with-projects/managing-items-in-your-project/adding-items-to-your-project#creating-draft-issues))
- A draft issue can be **converted to an issue** in a chosen repository from the project UI. That is the "promote" step, built in. ([Converting draft issues](https://docs.github.com/en/issues/planning-and-tracking-with-projects/managing-items-in-your-project/converting-draft-issues-to-issues))
- API: GraphQL `addProjectV2DraftIssue`, `updateProjectV2ItemFieldValue` (custom text, number, date, single select such as Status or Type), `deleteProjectV2Item`; a `projects_v2_item` webhook exists. Needs a token with the `project` scope: a **classic PAT** or a **GitHub App installation token**. ([Using the API](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects))
- Fine-grained PATs have an **organization** permission "Projects" (read/write, including `POST /orgs/{org}/projectsV2/{project_number}/drafts`), but no user-level Projects permission in the fine-grained permission list. User-owned projects therefore need a classic PAT with the broad `project` scope. ([Fine-grained PAT permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens))
- Visibility can be **private**: only users granted at least read access see the project. Items from private repos stay hidden from people without repo access. ([Visibility](https://docs.github.com/en/issues/planning-and-tracking-with-projects/managing-your-project/managing-visibility-of-your-projects))
- Limits: 50,000 items per project, 50 fields; built-in workflows can auto-archive items; views as table, board and roadmap; insights charts. ([About Projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects/learning-about-projects/about-projects))

What it would replace: the triage status, notes, the promote dialog, the GitHub mirror sync and the "In GitHub" tab (a converted draft stays the same project item, so its status lives in one place). What it would not replace: the config editor, the funnel, the system page and the feedback history in D1. Open points: every triager needs a GitHub account with project access; screenshots only as links to the R2 public URL in the body; privacy-first self-hosters without GitHub get no inbox; GitLab, Jira and Trello (P4) have no equivalent here.

### Data model (schema v3, expand only)

`migrations/0003_triage.sql`:
- `feedback.triage_status TEXT NOT NULL DEFAULT 'open'` (`open | in_progress | resolved | dismissed`)
- `feedback.triage_note TEXT`
- `feedback.type_source TEXT` (`ai | visitor | admin`)
- `feedback.issue_state TEXT` (`open | closed | gone`), `feedback.issue_checked_at INTEGER`
- `feedback.resolved_at INTEGER`
- index `(project_id, triage_status, created_at)`
- `meta.schema_version = 3`

Rows that already have `issue_url` start with `triage_status = 'in_progress'` and `issue_state = NULL` until the first mirror refresh.

### Config contract (`src/shared/contract.ts`)

- `tracker` becomes optional.
- New project-level `delivery: "inbox" | "auto"` (default `"auto"` when a tracker exists, so existing configs behave as before; `"inbox"` without tracker).
- New template-level `delivery?: "inbox" | "auto"`; `noIssue: true` is normalised to `delivery: "inbox"` during parse.
- Refinement: `delivery: "auto"` anywhere requires `tracker`.
- New `retention.resolvedDays?: number`.

### Worker

- `orchestrate.ts`: decide per template whether to call the tracker (`delivery === "auto"` and tracker present) or to persist as inbox item. Persist the rendered draft for every inbox item so promote needs no LLM call (`issue_draft` exists since schema v2).
- New write routes in `src/worker/admin/routes.ts`, all behind `adminGate`, CSRF-safe (bearer header or Access JWT, no cookies auth for writes):
  - `PATCH /api/admin/feedback/:id` (status, note, type)
  - `DELETE /api/admin/feedback/:id` (row + R2 assets through `deleteAssetsForFeedback`)
  - `POST /api/admin/feedback/:id/promote` (title, labels, body overrides; creates the issue from the stored draft; idempotent: a second call returns the existing issue)
  - `POST /api/admin/feedback/:id/retry` (issue_failed rows)
  - `PUT /api/admin/projects/:id/config` (same validation and version bump as the import; the import route stays)
  - `GET /api/admin/projects/:id/github-check` (PAT present, repo access, expiry; reuses `checkRepoAccess`)
- Mirror refresh: `src/worker/providers/github.ts` gets `getIssueStates(repo, numbers, pat)` (one GraphQL query per batch of up to 50); used by the inbox list route and the cron.
- Cron (`src/worker/index.ts` `scheduled`): refresh linked items not checked in 24 h, delete resolved/dismissed rows past retention.
- MCP: add `feedback:write` scope with `update_feedback` and `promote_feedback` tools mirroring the routes (later, behind its own scope).

### Admin frontend

- `src/worker/admin/pages.ts`: new shell and CSS from the mockup (framed sheet, project switcher in the sidebar, views as tabs). Keep the nonce CSP; IBM Plex is served from the gateway like Urbanist today (no Google Fonts at runtime).
- `src/admin/main.ts`: inbox (list + detail, status tabs with counts computed from the view, type filter, search), promote dialog, config form + JSON mode, keep funnel, snippet, projects and system views. Everything from the API still goes through `textContent`.
- Budget stays 15 kB gz for `dist/admin.js`; if the editor pushes past it, split the config editor into a second chunk.

### Tests

- Vitest: contract normalisation (`noIssue` → `delivery`), refinement errors, orchestrate per delivery mode, promote idempotency, retry, mirror refresh mapping (open, closed, 404 → gone), retention cron, config PUT version bump and validation errors.
- Playwright (`e2e/admin-*.spec.ts` with the mocked API in `admin-fixtures.ts`): triage status change, type correction, promote dialog, connect-GitHub path for inbox-only projects, config form publish, JSON round-trip, phone layout.

### Rollout

1. Schema v3 + contract + orchestrate (no UI change; getClosr keeps working because `noIssue` maps to inbox).
2. Write API + mirror refresh + cron.
3. Admin frontend.
4. Switch getClosr from `noIssue` on every template to `delivery: "inbox"`; consider SCTT and NORA.

Effort estimate: 2 to 3 days with an agent, split into three PRs along the rollout steps. Each PR with UI goes to the maintainer for merge (repo rule).

## Review record

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
