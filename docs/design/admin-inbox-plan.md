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
2. **Retention stays strict and visible.** Reports are deleted at `retentionDays` after submission, handled or not, exactly as the privacy promise says today. Unhandled reports get a notice on the System page and in `/diag` 7 days before deletion, so nothing disappears unseen. (Owner decision 2026-10-24.)
3. **Three deliveries per type:** `issue` (today's automatic issue), `project` (a draft issue in a private organisation GitHub Project), `local` (stored in FeedbackKit only). `noIssue: true` is read as `delivery: "local"`.
4. **GitHub Project delivery.** Each report becomes a draft issue with the rendered title and body (screenshot as R2 link), plus project fields Type, Page and Source set by FeedbackKit. Status, notes, assignment and "Convert to issue" happen in GitHub. FeedbackKit stores the project item ID and links to it. No status mirror.
5. **Minimal local inbox** for `local` deliveries only: open, done, dismissed; one note; delete (row and R2 assets); copy as Markdown for an agent. Reports delivered to GitHub show their link and no local status.
6. **Config editing in the admin** as a validated JSON editor: load the stored config, edit, validate on the server (Zod issues shown inline), show the diff to the stored version, publish (bumps `config_version` like the import). A form editor comes later.
7. **Type clarity** in the history: each row leads with a type glyph and word.
8. **Private screenshots for private deliveries.** For `project` and `local`, screenshot links in drafts and the admin point to an authenticated gateway route (`GET /admin/assets/:key`, Access or admin token) instead of the public R2 URL. Public issue repos keep today's public links. (Owner decision 2026-10-24.)

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
- Retention (`retention.ts`): delete rows older than `retentionDays` together with their assets (joined via `client_feedback_id`); list unhandled rows that will be deleted within 7 days on the System page and in `/diag`. Events keep their own age rule.
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

### Release criteria and error contract (from the DX review)

- **No acknowledged loss on any path.** Every report that is not confirmed delivered (local, failed issue, failed Project draft) is only acknowledged after D1 confirmed the write. Today the missing-PAT and tracker-failure paths answer HTTP 200 `issue_failed` even when `persistFeedback` failed (`orchestrate.ts:309-313`). If both delivery and storage fail, the gateway answers 503 with `code: "FK_PERSIST_FAILED"`, `retryable: true`, `Retry-After: 5`.
- **Widget retry keeps everything.** `failed` carries the message, type, follow-up answer and attachment keys; `retry` restores them instead of calling `resetAttempt()` with an empty form (`state.ts:75`, `index.ts:173`). The existing `feedbackId` dedup bounds repeated submits.
- **Stable error codes** on every new response, in addition to the existing `error` string: `FK_PERSIST_FAILED`, `FK_DELIVERY_FAILED`, `FK_DELIVERY_UNKNOWN`, `FK_RETRY_IN_PROGRESS`, `FK_CONFIG_STALE`, `FK_CONFIG_SHAPE_UNSUPPORTED`, `FK_CONFIG_INVALID`, `FK_NOT_LOCAL`, `FK_PROJECT_USER_OWNED`, `FK_PROJECT_ACCESS`. Each listed in `docs/ERRORS.md` with fix and recovery. Admin responses carry `feedbackId`, attempt ID and config version; never the PAT, report body or full page URL.
- **Retry without duplicates.** Before calling GitHub, the attempt writes an attempt ID into the row and into the draft body (hidden marker). A retry after an uncertain outcome first looks for a draft with that marker and links it instead of creating a second one. `promote_lock` stores a timestamp and expires after 2 minutes; while held, retry answers 409 `FK_RETRY_IN_PROGRESS`. Retry uses the stored draft and destination, not the current config.
- **DELETE order:** R2 assets first, then the row; partial failure keeps the row and reports the failed keys.
- **Config writes with optimistic concurrency.** `PUT` requires `expectedVersion`; a mismatch answers 409 `FK_CONFIG_STALE` with the current version and a fresh diff. The import keeps its current behaviour for scripts.
- **One resolution table for delivery**, shown per template in the editor before publish: template `delivery` > project `delivery` > legacy `noIssue` (→ `local`) > default (`issue` with a tracker, `local` without). `noIssue` together with any `delivery` on the same template is rejected with its JSON path. A config with `tracker.project` but no explicit `delivery` is rejected ("set delivery explicitly") so private feedback never lands as public issues by accident.
- **Project field mapping keyed by `template.type`**, not by the localised label: `tracker.project.typeOptions?: { [type]: optionName }`, default the template type. Optional `tracker.project.fields?: { type?, page?, source? }` renames the three fields. Skipped fields are stored per row (`delivery_warnings`) and shown on the row, the System page and `/diag`.
- **Access check that proves what it says:** the System page reports `fieldsReadable` and `draftWriteVerified` separately; the latter only after a real test submission. The validate step rejects user-owned projects with `FK_PROJECT_USER_OWNED`.
- **Retention for the whole report.** The age clock starts at submission. Rows and their R2 assets are deleted together at `retentionDays`, handled or not, with a 7-day advance notice for unhandled rows. A shortened `retentionDays` never deletes before that notice period has passed. The independent asset sweep (`r2.ts:86`) follows the row, except for the late-delivery minimum below.
- **Every writer obeys the compatibility gate:** the import route, the editor and `scripts/seed-config.mjs` (which writes to D1 directly). New shapes are accepted only when the stable release implements the full behaviour (delivery, retry, retention), not only parsing. Tests: old stable against new data, new stable against old data, rows inserted during the rollout.
- **Rollback contract** in `docs/RELEASES.md`: minimum safe rollback version per step, config export before switching, `noIssue` deprecation (accepted and warned, removal not before 1.0). The backfill marks historical rows conservatively (`delivery = NULL` when unsure) instead of inferring from today's templates.
- **Docs in the same PR as the behaviour:** QUICKSTART section "Deliver to a GitHub Project" (project number from the URL, PAT permission "Projects: write", the three fields, a complete importable JSON per delivery mode, a `noIssue` migration example), README link, retention semantics, RELEASES entry for schema v3, `docs/ERRORS.md`. Acceptance: a newcomer finds the Project setup in under two minutes and completes it without reading TypeScript.
- **Time to first draft ≤ 10 minutes in 5 steps:** create the Project, grant the PAT, set `delivery` and `tracker.project` in the editor, run the System check (names missing fields and options), press "Send test report" in the admin (real delivery, unlike the dry-run test page).

### Delivery state machine and identities (from the Eng review)

- **One submission identity.** Migration 0003 adds `feedback.client_feedback_id` (backfilled from `json_extract(payload,'$.feedbackId')`) with a unique index on `(project_id, client_feedback_id)`; dedup becomes project-scoped. Every write is `INSERT … ON CONFLICT DO NOTHING` followed by a read-back. A reused client ID with a different payload answers 409. Row deletion and asset deletion join on this column (assets are indexed by the client ID, rows by a server ID).
- **Order of operations:** 1) persist the submission with its resolved destination snapshot and `delivery_state = 'pending'` (no acknowledgement before this succeeded); 2) claim delivery atomically (`UPDATE … SET claim_token=?, claim_until=? WHERE id=? AND (claim_until IS NULL OR claim_until < now)` plus a changes check); 3) call GitHub with a stable delivery marker (the row ID) in the body; 4) complete with an update fenced by `claim_token`: `delivered` (store issue URL or project item ID), `failed` (definite 4xx), or `unknown` (timeout, lost response, 5xx).
- **Draft created = delivered.** A 201 on the draft call sets `delivered`; field updates afterwards only add `delivery_warnings` and are retried without recreating the draft.
- **Retry** (`POST /api/admin/feedback/:id/retry`, new code, not an existing path) works on `failed` and `unknown` rows. For `unknown` it first reconciles: issues by searching the marker in the repo, drafts by scanning Project items created after the attempt, limited to 5 pages. Found: link it. Not found: answer `FK_DELIVERY_UNKNOWN` and require an explicit "create anyway" from the operator. An expired claim allows reconciliation, never blind re-creation. Retry uses the stored destination snapshot, not the current config. The disabled Retry button in `admin/main.ts:384` becomes live.
- **Route boundary:** the crash handler in `app.ts:475-479` answers 503 `FK_PERSIST_FAILED` unless a row is confirmed; tested through Hono.
- **Public response vocabulary stays stable** for widgets already cached on host pages: `delivery_failed` and `unknown` map to the existing `issue_failed` status in the response (report saved, delivery pending); a new status is not introduced.
- **Delivery resolution, corrected:** template `delivery` > template `noIssue` (→ `local`, a template-level override that a project default never overrides) > project `delivery` > default. `noIssue: true` stays allowed next to `delivery: "project" | "local"` as a safe fallback for older workers after a rollback (an old worker then stores locally instead of opening a public issue); only `noIssue: true` + `delivery: "issue"` is rejected. With automatic type detection, a template switch on POST-1 or POST-2 may change the destination; when the candidate templates of a project have different deliveries, the more private one wins (`local` > `project` > `issue`).
- **Compatibility gate signal:** the gate stays closed until step 3 is promoted to stable and verified. The signal is a D1 `meta` row `delivery_capability = <stable version>` written by the promote workflow; every writer (import, editor PUT, `scripts/seed-config.mjs`) checks it. The getClosr switch waits until the oldest stable a rollback could land on reads `delivery`.
- **Config activation:** publish clears the isolate config cache entry for that project in the handling isolate and the editor states "active on all edge locations within 60 s". `projectId` cannot be changed in the editor; `publicKey` and `configVersion` are stripped before diff and restored on save. `expectedVersion` is enforced in the `UPDATE … WHERE config_version = ?` predicate with a changes check.
- **Widget retry snapshot:** the `failed` state carries leg (1 or 2), client feedback ID, message, type, follow-up answer, extracted fields and uploaded keys. Retry resends the same leg with the same ID and keys and a fresh Turnstile token; it does not call `resetAttempt()` and does not re-upload. The panel restores text and type into the DOM controls (`ui/panel.ts:210`). Editing the text after a failure starts a new ID. The existing test `widget.test.ts:114`, which asserts the empty form, changes.
- **Test report route:** `POST /api/admin/projects/:id/test-report`, admin-gated and rate-limited, LLM off, rows flagged `is_test` and excluded from the funnel and "new in 7 days"; it is the only evidence for `draftWriteVerified`.
- **Historical rows:** rows with `delivery = NULL` appear under "Needs a decision" in the history; the operator can mark them done, delete them, or deliver them once to the current destination. Old getClosr reports remain reachable regardless of the new mode.
- **Screenshot links are bearer links.** R2 objects are public by URL (`r2.ts:59`); a private Project does not protect them. See the owner decisions below. When attachments exist but `publicBaseUrl` is absent, the draft says "screenshot stored in FeedbackKit" with the admin link instead of silently omitting it.
- **Least privilege:** optional `tracker.project.patSecret` so the Projects permission can live on a separate token from the issue token.
- **Audit:** DELETE logs identity, feedback ID and result keys, never content. "Copy as Markdown" wraps the visitor text in a fence marked untrusted.
- **System page cost:** GitHub checks are cached in D1 for 10 minutes per project.

### Owner decisions (from the Eng review)

These change promises to users and were not auto-decided:

1. **Retention of unhandled reports. Decided: (a).** (a) Strict: delete at `retentionDays` whether handled or not, with a System notice 7 days before; the privacy promise stays exactly as today. (b) Keep unhandled until a hard cap (`unhandledMaxDays`, default twice `retentionDays`) with notice; changes the privacy promise and needs a SECURITY.md and privacy-page update. Recommendation: (a) for getClosr because its privacy page promises 30 days, with the notice; operators can opt into (b).
2. **Screenshot confidentiality. Decided: (b).** (a) Keep public bearer links and document the boundary in SECURITY.md. (b) Serve screenshots through an authenticated gateway route (Access or token) so links in drafts only open for signed-in operators. Recommendation: (b) for projects with `delivery: "project" | "local"`, (a) unchanged for public issue repos; about half a day extra.
3. **Screenshot lifetime after late delivery. Approved.** Assets of a report get `expires_at = max(submission + retentionDays, delivery + 7 days)` so a delivered link works for at least a week, within the retention choice of decision 1.

### Tests

- Vitest: `local` + D1 failure answers 503 (not `created`); strict retention deletes handled and unhandled rows at the limit and lists unhandled ones 7 days ahead; widget reducer: `retry` after `failed` restores the last text and type; retention keeps unhandled rows; contract normalisation `noIssue` → `local`, refinements, absent tracker in all six readers; project delivery success, field skip, failure → `delivery_failed` + retry; retry lock against double click; config validate/PUT version bump; cross-origin write through the Access path refused.
- Playwright with the mocked API: local disposition change, note, delete, copy Markdown; delivered row links; JSON editor validation error and publish; phone layout.

### Rollout

1. Durability and retention fix, including the widget retry that keeps the text (no contract change). Ships first, alone.
2. Contract read support + schema v3, promoted to stable.
3. Project delivery + retry + System checks.
4. Admin: local inbox, links, JSON config editor.
5. getClosr: create a private Project in `getclosr-link`, grant the PAT "Projects: write", switch its types from `noIssue` to `delivery: "project"`.

Effort (revised after the Eng review): step 1 about one day (route boundary, identity column, widget retry snapshot across `state.ts`, `index.ts` and `panel.ts`); step 2 half a day; step 3 two days (delivery state machine, reconciliation, retry route, test-report route); step 4 one day. UI PRs go to the maintainer for merge (repo rule). Tests that claim durability run against a real local D1, not the SQL fakes in `test/helpers.ts` (they never execute SQL). That needs a new dev dependency, `@cloudflare/vitest-pool-workers`, set up in step 1 for the new suites only.

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

### Phase 2: Design review

Skipped. After the rescope the scope tool returned `uiRequired: false`; the remaining UI uses the existing admin tokens (ADR-014). The restyle is out of scope.

### Phase 2.5: DX review (2026-10-24)

Voices: native (Claude subagent, input `dx d2b13617…`) completed, overall 5.9/10; outside (Codex `gpt-6-astra`) completed, verdict `findings`, P1.

```
DX DUAL VOICES — CONSENSUS TABLE:
  Dimension                           Claude  Codex  Consensus
  1. Getting started < 5 min?          No      No     CONFIRMED (20-30 min, target 10)
  2. API/CLI naming guessable?         Yes*    Yes*   CONFIRMED (*precedence undefined)
  3. Error messages actionable?        No      No     CONFIRMED (codes, recovery missing)
  4. Docs findable & complete?         No      No     CONFIRMED (no docs step)
  5. Upgrade path safe?                Mostly  No     DISAGREE -> taste: Codex wins (parse vs behaviour gate)
  6. Dev environment friction-free?    Partly  Partly CONFIRMED (no real test delivery)
```

Scorecard (native): getting started 5, config ergonomics 7, errors 6 (capped), docs 4, escape hatches 5, safety 6, observability 6, upgrade 8.

Verified by the orchestrator: `issue_failed` paths answer 200 after a swallowed persist (`orchestrate.ts:309-313`); the R2 sweep deletes by asset expiry independently (`r2.ts:86`); `scripts/seed-config.mjs` writes to D1 with its own checks.

All DX findings were accepted as obligations (section "Release criteria and error contract"); none changes the owner's direction.

### Phase 3: Eng review (2026-10-24)

Voices: native (Claude subagent, input `eng 77f07b75…`) completed, 4 critical gaps; outside (Codex `gpt-6-astra`) completed, verdict `findings`, P1.

```
ENG DUAL VOICES — CONSENSUS TABLE:
  Dimension                           Claude  Codex  Consensus
  1. Architecture sound?               Yes*    Yes*   CONFIRMED (*needs a delivery state machine)
  2. Test coverage sufficient?         No      No     CONFIRMED (fakes do not execute SQL)
  3. Performance risks addressed?      Partly  n/a    single voice (System page GitHub calls, marker scan)
  4. Security threats covered?         Partly  No     CONFIRMED (rollback to public issue; public R2 links)
  5. Error paths handled?              No      No     CONFIRMED (crash path, duplicates, unknown outcome)
  6. Deployment risk manageable?       Yes*    Yes*   CONFIRMED (*gate signal, old widgets, rollback)
```

Verified by the orchestrator: no retry route exists (`app.ts:577` stub, disabled button `admin/main.ts:384`); `resetAttempt()` clears `feedbackId` and keys (`widget/index.ts:116-126`); `widget.test.ts:114` asserts the empty form; `test/helpers.ts` fakes never execute SQL; config cache TTL is 60 s (`config.ts:21`); no Workers test pool in `package.json`.

All findings were accepted as obligations (section "Delivery state machine and identities") except three that change user-facing promises: they are listed under "Owner decisions".

Test plan written to `~/.gstack/projects/TruffleCraft-feedbackkit/` (eng-review-test-plan). No `TODOS.md` exists in this repo; deferred work stays in "Out of this plan" and becomes GitHub issues after approval, following the repo's issue workflow.

### Not in scope (all phases)

Visual restyle (own ADR), MCP write scopes, status mirror from GitHub, form-based config editor, GitLab/Jira/Trello, user-owned Projects, notifications beyond "new in 7 days", changing the import route's last-write-wins semantics, fixing older widget builds already cached on host pages.

### Approval (2026-10-24)

Owner approved the plan with decisions 1 (a), 2 (b) and 3. Next: GitHub issues for the five rollout steps, then step 1 (durability fix) in its own branch.
