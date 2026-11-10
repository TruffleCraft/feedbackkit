# Autonomous FeedbackKit: plan and delivery steps

Status: proposed, challenged on 2026-11-10. Product boundary and open decisions: [scope.md](scope.md). Who does what and what proves it: [journeys.md](journeys.md). This page says in which reviewable steps the gaps close and how each step is accepted.

## Outcome

An operator runs the complete feedback process on a Linux server or Proxmox LXC: local storage, local accounts with passkeys, optional OIDC and a local AI endpoint. Cloudflare, GitHub, remote AI and mail are optional. Humans and setup agents get install and configuration guides that state what was verified.

## Product structure

| Area | Target |
|---|---|
| Instance | First-run owner setup, public URL, storage and retention, shared AI and GitHub connections, health and update information |
| People | Invitation-only accounts with passkeys, optional OIDC, two roles (owner, member), project access, session revocation, recovery on the host. No public sign-up, no mandatory mail |
| Projects and types | Any number of types, each with labels, guidance, fields and a destination. IDs stay fixed. Instance defaults can be overridden |
| Inbox and log | Local reports have a board view over open, done and dismissed. GitHub deliveries are logged, linked and retried. Their ticket state is never mirrored |
| Privacy | Images stay in the browser until the visitor confirms. Masks are burned into the pixels before upload, thumbnail and AI call. Private elements and password fields are not captured. No automatic detection is promised |

## Where the branch stands

Measured at `3f3caba` on 2026-11-10 (static review, seven specialist passes, an adversarial pass, isolated probes on Node 26).

| Area | State | Evidence |
|---|---|---|
| Standalone runtime | Works on a developer machine. Not release-ready | Two server tests pass. Docker, systemd, LXC and a real GitHub delivery were not run |
| Settings form | Works for edits. Unsafe to ship | `pnpm check:bundle` fails (admin 28.4 kB gz, budget 15 kB). Two e2e runs fail |
| Create-only project API | Works. Incomplete | No Worker test, no error codes, no snippet in the response |
| Accounts, OIDC, roles | Not built | The only credential is `ADMIN_TOKEN` |
| Board, masks, previews | Not built | Not started |

## Findings that change the plan

Each finding is assigned to a step. IDs are stable so later reviews can refer to them.

| ID | Finding | Step |
|---|---|---|
| R1 | A request path starting with `//` replaces the canonical origin and skips the origin allowlist (reproduced) | A |
| R2 | Failed-login lockout runs before the token check and is shared behind a proxy. 21 wrong tokens lock out the right one (reproduced) | A |
| R3 | `X-Forwarded-For` is read from the left, so a client can pick its own address (reproduced) | A |
| R4 | Admin screenshots cannot load with token auth, and each refused request counts toward the lockout | A, then Gate 2 |
| R5 | A failing sweep on start ends the process. Concurrent first starts fail. `busy_timeout` is set after WAL | A |
| R6 | `delivery_capability` is overwritten on every start. No guard against newer schema or settings | A |
| R7 | The whole process environment is visible to settings that name secrets. `llm.baseUrl` receives the AI key | A, then Step 4 |
| R8 | Deleted attachments stay in the database file. Blobs never shrink the file | A |
| R9 | Docker image carries development dependencies, code is writable, health check ignores `PORT` | A |
| R10 | Admin bundle over budget. Numbers seed as `1` (retention would delete after one day). Optional strings save as empty | B |
| R11 | IDs are immutable only in the browser. Review can be published after the text changed. JSON and form drafts diverge | B |
| R12 | Create route: no tests, no codes, no snippet. Fresh Cloudflare deploy cannot create local projects | B |
| R13 | Retention lacks the notice guard from the 2026-10-24 plan | B |
| R14 | Docs: Node version, rollback claim, broken anchor, `Discarded` against `Dismissed`, missing standalone threat model | C |
| R15 | Picked images upload at once and the remove button keeps the object. Private elements are not excluded. Rectangle is a frame | Gate 1 |
| R16 | Uploads without a report never expire when no retention is set. No quota | Gate 1, A |

## Steps

Each step is one reviewable PR (or a small series) with its own tests and docs. The spec fields are Why, Capabilities, Constraints, Non-goals and Success signals. UI changes follow mock before build and go to the maintainer for merge.

### Step A: harden the standalone runtime

- **Why:** the first runtime layer can lock out the operator, trust the wrong origin and lose or keep data wrongly.
- **Capabilities:**
  - Build request URLs by appending to the canonical origin. Reject paths that start with `//`.
  - Check the token first. Count only wrong credentials. Take the client address at a configured trusted-hop position from the right and validate it.
  - Guard the start sweep, set `busy_timeout` first, check migrations inside the transaction, use `synchronous=NORMAL`, `secure_delete=ON`, `auto_vacuum=INCREMENTAL`.
  - Pass an allowlist of environment variables to the application. Keep `delivery_capability` at the maximum. Refuse to serve settings that need a newer release.
  - Load admin images with the Authorization header and show them from object URLs.
  - Ship runtime files only in the image, read-only for the runtime user, health check on `PORT`. One Node floor (24 LTS).
- **Constraints:** same Hono app, no new runtime dependency, Worker behavior unchanged and proven by the existing suite. A stricter `patSecret` rule warns on load and rejects on write, so stored settings keep working.
- **Non-goals:** accounts, masks, new screens.
- **Success signals:** every reproduced probe of the review is a test (R1 to R3, R5, R6). One conformance suite passes on both runtimes. The Docker image builds smaller and passes the health check on a custom port.

### Step B: settings that are safe by construction

- **Why:** the form changes production settings, so it must not be able to destroy an operator's data.
- **Capabilities:**
  - Drive the form from a generated schema descriptor, not from zod in the browser. `pnpm check:bundle` passes without raising the budget.
  - Never seed numbers or enums with a destructive value. Empty required fields stay empty until filled. An emptied optional field is removed.
  - The review step lists the effect of a retention change in reports and attachments, and the server refuses a retention that would delete before its notice period.
  - The server enforces unique type and field IDs and keeps published IDs. Removing a type archives it.
  - A review covers exactly the text that is published. One draft feeds form and JSON. Locked IDs refresh after publish.
  - The create API returns the snippet, uses error codes, is documented in `docs/ERRORS.md` and tested on the Worker runtime. A fresh Cloudflare deploy records delivery capability.
  - Correct the e2e expectation that requires `undefined` keys.
- **Constraints:** form and JSON stay equal in power. Keep the escape hatch.
- **Non-goals:** new navigation, board, accounts.
- **Success signals:** `pnpm typecheck`, `pnpm test`, `pnpm check:bundle`, `pnpm e2e` and `pnpm test:server` are green. e2e covers add-setting, reorder, remove, JSON round trip, stale save and the New project dialog.

### Step C: scope and documentation honesty

- **Why:** the repo must say what it does, and every claim must have a proof.
- **Capabilities:** the three documents of this change, ADR-016 as proposed, the roadmap backlog line, a standalone section in `docs/SECURITY.md` (proxy, attachment route, deletion guarantee), corrected anchors, one term for each state, one Node version, and a claim table that links each statement about runtime, rollback and deletion to a test or a step.
- **Constraints:** documentation only. A claim without a proof is removed or marked planned.
- **Non-goals:** behavior changes.
- **Success signals:** link check passes. Every row of the claim table names its proof.

### Gate 1: masked capture and upload contract (blocks the "private by design" claim)

- **Why:** an original image that reaches the server cannot be called masked, whatever the screen shows afterwards.
- **Capabilities:**
  - A solid mask tool, rasterized into the pixels. Mask, thumbnail, upload and AI input come from the same bytes.
  - Images stay in memory until the visitor confirms. Removing one leaves no server copy. EXIF is stripped.
  - Capture skips elements marked private and password fields.
  - A project can require a widget marker on uploads. Uploads that no report claims expire.
- **Constraints:** mock before build. The widget budget is 23 kB gz and has 0.2 kB left, so the mask tool loads on demand or the budget is changed by decision. No promise of automatic detection.
- **Non-goals:** replay, OCR, automatic redaction.
- **Success signals:** a Chromium test decodes every request body for each input path (capture, pick, paste, drop, retry) and shows that masked regions differ from the original, with a negative control that fails without the mask. A server test rejects unmarked uploads for projects that require the marker.

### Gate 2: local accounts and recovery (blocks the "autonomous" claim)

- **Why:** without it the only credential is a shared static token that can be locked out by anyone.
- **Capabilities:** sessions with CSRF protection, bootstrap proved by the recovery credential, one-time recovery link from a host command, passkeys through a maintained WebAuthn library, last-owner protection, revocation, admin images through the session, `ADMIN_TOKEN` as `full`, `recovery` or `off`, a threat model in `docs/SECURITY.md`.
- **Constraints:** no hand-written protocol. Passkeys need HTTPS or localhost, and the relying party ID follows `FK_PUBLIC_URL`, which then cannot be changed in the UI. Decide D-02 and D-03 first.
- **Non-goals:** roles beyond owner and member, OIDC, public sign-up.
- **Success signals:** concurrent bootstrap yields one owner. A virtual authenticator completes enrollment and sign-in. A recovery drill works on a clean instance. A valid login is never blocked by other people's failed attempts, with and without a proxy.

### Step 3: verification on a fresh host

- **Why:** a build that passes on a laptop says little about an LXC.
- **Capabilities:** run J1, J2, J12 and J14 on a clean LXC and a clean Docker host with outbound traffic blocked until the first report, including upgrade with data and rollback. Update the status of each journey with the evidence.
- **Success signals:** transcripts and results are linked from the journeys. Only now may README and docs say the gateway runs without Cloudflare. Tag the release after this step.

### Steps 4 to 8, after the gates

| Step | Content | Needs first |
|---|---|---|
| 4 | Member role, project access, authorization on assets and feedback by project, instance-level AI and GitHub connections referenced by ID, scoped API tokens for agents | Gate 2, D-02 |
| 5 | Types navigation and board view over the three states | Approved mock, D-05 |
| 6 | OIDC through a maintained library, binding by `iss` and `sub` | Gate 2, D-04, upstream docs read |
| 7 | Widget preview and theme tokens (#57) | Approved mock, contrast rules |
| 8 | Signed webhook (#58) | None, optional |

## Release gates

| Gate | Condition |
|---|---|
| Autonomy | Steps A, B, Gate 2 and Step 3 are done. Until then no document claims independence from Cloudflare |
| Privacy | Gate 1 is done. Until then no document claims masked or private screenshots |
| Honesty | Step C is done and every claim in the claim table has a proof |

## Definition of done for every step

- The tests named in the step pass in CI. A green build is not evidence of behavior.
- Docs change in the same PR: README, `ADMIN.md`, `SELF_HOSTING.md`, `ERRORS.md`, `SECURITY.md` as affected.
- The affected journeys in [journeys.md](journeys.md) get their new status and an evidence link.
- A decision that changes scope gets an ADR. A new error gets a code.
- The PR body starts with its issues (`Fixes`, `Refs` or `No issue`). Parent epics #1, #2 and #6 stay open until their acceptance criteria are met.

## Related public issues

| Work package | Existing issues | Step |
|---|---|---|
| Admin, types and first run | #55, #59, #6 | B, 5 |
| Theme and preview | #57 | 7 |
| Independent operation and docs | #60, local part of #3, #69, #72 | A, C, 3 |
| Privacy and screenshot reliability | PII part of #127, #128, #129 | Gate 1 |
| Optional delivery integrations | #58, webhook part of #127 | 8 |

#112 is a consumer rollout after a stable gateway. #56 and #61 improve optional setup paths and do not block local use. #1 and #2 are not sprint commitments. #94 is praise and #107 a triage log. #66 needs a check against the current version, #67 and #95 are separate marketing slices. #128 and #129 look like duplicates and need one shared reproduction first.

Reports filed in embedding-app repositories need triage per component. Carry over a neutral summary only. Do not copy account context, private attachments or unrelated requests from other apps into this public repository.

Co-created by Michel with NORA (AI Agent)
