# What FeedbackKit is and what it is not

Status: proposed scope, challenged on 2026-11-10. Settled items name their source. Open items carry a recommendation and wait for the owner.

FeedbackKit completes a visitor's feedback while they are still on the page and delivers it as a structured report to a destination the operator owns. It does not manage the work that follows.

Companion documents: [journeys](journeys.md) say how each role gets through each task, the [plan](autonomous-admin-plan.md) says in which reviewable steps the gaps close.

## Challenge result

Each premise of the sprint plan was checked against the code (branch `codex/admin-self-hosting`, review of 2026-11-10), the roadmap and the earlier owner decisions in `docs/design/admin-inbox-plan.md` (branch `design/admin-inbox-mockup`).

| Premise | Verdict | Why |
|---|---|---|
| Operators need full autonomy from Cloudflare | Keep, as a second runtime with a written single-node contract | The roadmap lists the Node/SQLite runtime as backlog with a Docker checkpoint (`docs/ROADMAP.md`, Backlog). That is a changed invariant, so it needs [ADR-016](../DECISIONS.md). The first standalone layer had five blocking defects in about 110 lines, so the second runtime must pass the same tests as the Worker. |
| Local accounts with passkeys, invitations, roles and OIDC | Keep, but narrow and sequence it | Identity is a product of its own. The gateway has to know who may change settings. It does not have to be an identity provider. Break-glass token first, then sessions with bootstrap and recovery, then passkeys, then OIDC through a library. Two roles at first: owner and member. |
| A simple Kanban for local reports | Keep as a view over the three existing states | Owner decision 2026-10-24: triage lives in GitHub, the local inbox stays minimal. A fourth state breaks old readers (`queries.ts` counts every value except `open` as handled). |
| PII masking has the highest priority | Keep, as a release gate with a testable design | Upload only after the visitor confirms the final review. Masks are burned into the pixels. Thumbnail, upload and AI call receive the same masked bytes. The server cannot verify a mask, so a project can require a marker that old widgets lack. |
| Settings through real UI controls | Keep, but the form must be safe by construction | The first form seeds numbers with `1`, pulls zod into the admin bundle (28.4 kB gz against a 15 kB budget) and enforces IDs only in the browser. |
| Retention of unhandled reports | Already decided: strict, with a 7-day notice | Owner decision 2026-10-24. The rule "a shortened `retentionDays` never deletes before the notice period" is not in `retention.ts` yet. |
| Private screenshots through an authenticated route | Already decided, and the standalone server breaks it | Owner decision 2026-10-24. An `<img>` cannot send a bearer header, so inbox screenshots never load with token auth. |
| A stranger reaches a first report from the docs | Keep, with a claim-to-evidence table | Several statements are not backed by a test or a source yet (Node version, rollback behavior, deletion guarantees). |

## What FeedbackKit does

Status is `shipped` (on `main`), `branch` (on the WIP branch, not release-ready) or `planned`.

| Capability | Cloudflare | Standalone | Status |
|---|---|---|---|
| Widget with follow-up questions, screenshot, console context | yes | yes | shipped |
| Feedback types with required fields, per-type destination | yes | yes | shipped |
| Delivery to a GitHub issue or GitHub Project draft, with retry | yes | yes | shipped |
| Local inbox: open, done, dismissed, note, delete | yes | yes | shipped |
| Settings revisions, publish with conflict detection | yes | yes | shipped |
| Run on Linux, Proxmox LXC or Docker with SQLite | n/a | yes | branch |
| Settings form for types, fields, AI, appearance | yes | yes | branch |
| Create-only project API and New project dialog | yes | yes | branch |
| Local AI endpoint without a placeholder key | yes | yes | planned |
| Masked images only, uploaded after review | yes | yes | planned |
| Local accounts, passkeys, recovery | no | yes | planned |
| OIDC sign-in (Pocket ID or any provider) | no | yes | planned |
| Board view of the local inbox | yes | yes | planned |
| Widget preview and theme tokens | yes | yes | planned |
| MCP server with OAuth | yes | no | shipped (Cloudflare only) |

## What FeedbackKit does not do

| Not in the product | Reason | Revisit when |
|---|---|---|
| Session replay, click journeys, video | A separate privacy and product decision | The owner asks for it and writes the privacy position first |
| Automatic PII detection | It cannot be promised. The product offers manual masks and excludes marked elements and password fields | A detector with a measured miss rate exists |
| Mirror of GitHub status, comments or assignees | GitHub owns the ticket | Never. Link out instead |
| A second ticket tracker (comments, assignees, custom lanes, SLAs) | The inbox is not the product's edge (CEO review 2026-10-24) | A paying use case without GitHub appears |
| Public sign-up, mandatory mail provider, mandatory external identity | Autonomy is the point | Never as a requirement |
| Several replicas on one database | SQLite on one disk, one process | A second storage backend is accepted by ADR |
| MCP and OAuth on the standalone server | ADR-015 builds consent on Cloudflare Access | A separate ADR defines consent without Access |
| User-owned GitHub Projects, GitLab, Jira, Trello | No fine-grained permission for user Projects, and demand is unproven | A demand checkpoint is reached |
| TLS termination, reverse proxy, backups of the host | The operator's infrastructure | Never |
| Hosted FeedbackKit offering | Operators host it themselves | A business decision, not a code change |

## Runtime contract for the standalone server

1. One node, one process per database. SQLite in WAL mode on a persistent local disk.
2. The same Hono application and the same behavior tests as the Worker. A difference between the runtimes is a bug or an entry in the parity table of `docs/SELF_HOSTING.md`.
3. Node.js 24 LTS. The Node documentation labels `node:sqlite` in v24 "Stability: 1.2, release candidate" (nodejs.org, checked 2026-11-10). One version number appears in `engines`, CI, the Dockerfile and the docs.
4. No Docker nesting for the direct installation. Docker Compose is an additional path.
5. `/diag` reports schema, capability and whether stored settings need a newer release than the one running.
6. Secrets come from environment variables or the service's environment file. The process hands the application an allowlist of them, not its whole environment.

## Decisions

Settled decisions:

| ID | Decision | Source |
|---|---|---|
| S1 | Three deliveries per type: issue, project draft, local. GitHub owns ticket state | `admin-inbox-plan.md`, 2026-10-24 |
| S2 | Retention is strict and counts from submission, with a 7-day notice for unhandled reports | same, decision 1 |
| S3 | Screenshots of project and local deliveries are served through an authenticated route | same, decision 2 |
| S4 | No acknowledged loss: a report is confirmed only after it is stored | ROADMAP invariant 5 |
| S5 | The LLM client is OpenAI-compatible and optional | ADR-007, ROADMAP invariant 3 |
| S6 | Appearance is themed per host through tokens on a neutral base | Owner, 2026-10-07 |
| S7 | Most backend settings are managed through UI controls, with JSON as the escape hatch | Owner, 2026-11-09 |

Open decisions. Each recommendation is mine and needs the owner's answer.

| ID | Question | Recommendation |
|---|---|---|
| D-01 | Accept ADR-016, the standalone runtime? | Yes, with a conformance suite that runs the same tests on both runtimes and the single-node contract above |
| D-02 | What happens to `ADMIN_TOKEN` once accounts exist? | Keep it as a recovery credential that can be switched off after the first owner exists. Add scoped API tokens for agents later |
| D-03 | Do accounts exist on the Cloudflare runtime? | Standalone first. Cloudflare keeps Access. Check D1 constraints before promising parity |
| D-04 | How does OIDC link to a person? | By `iss` and `sub`, bound to an invitation. Email equality grants nothing |
| D-05 | Does the board need an "in progress" lane? | Not yet. Three states first. A fourth needs an expand-only schema plan and a fix in `queries.ts` |
| D-06 | Which Node floor? | 24 LTS everywhere |
| D-07 | Is masking enforced or optional per project? | Optional flag first, default on for new projects after the widget change has shipped for one release |

Co-created by Michel with NORA (AI Agent)
