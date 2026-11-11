# Autonomous FeedbackKit: plan and delivery steps

Status: proposed, challenged on 2026-11-10. Product boundary and open decisions: [scope.md](scope.md). Who does what and what proves it: [journeys.md](journeys.md). This page says in which reviewable steps the gaps close and how each step is accepted.

## Outcome

An operator runs the complete feedback process on any Linux host (a home Proxmox LXC, a Hetzner server, any VPS): local storage, local accounts with passkeys, optional OIDC and a local AI endpoint. Cloudflare stays as the managed option for operators who do not want to host anything. GitHub, remote AI and mail are optional. Humans and setup agents get install and configuration guides that state what was verified.

## Product structure

| Area | Target |
|---|---|
| Instance | First-run owner setup, public URL, storage and retention, shared AI and GitHub connections, health and update information |
| People | Invitation-only accounts with passkeys on both runtimes, optional OIDC, two roles (owner, member), project access, session revocation, recovery with a one-time link, scoped API tokens that replace `ADMIN_TOKEN`. No public sign-up, no mandatory mail |
| Projects and types | Any number of types, each with labels, guidance, fields and a destination. IDs stay fixed. Instance defaults can be overridden |
| Inbox and log | Local reports have a board view over open, done and dismissed. GitHub deliveries are logged, linked and retried. Their ticket state is never mirrored |
| Privacy | Images stay in the browser until the visitor confirms. Masks are burned into the pixels before upload, thumbnail and AI call. Private elements and password fields are not captured. No automatic detection is promised |

## Where the branch stands

Measured at `3f3caba` on 2026-11-10 (static review, seven specialist passes, an adversarial pass, isolated probes on Node 26).

| Area | State | Evidence |
|---|---|---|
| Standalone runtime | Works on a developer machine. Not release-ready | Two server tests pass. systemd, an LXC and a real GitHub delivery were not run. No release artifact exists |
| Settings form | Works for edits. Unsafe to ship | `pnpm check:bundle` fails (admin 28.4 kB gz, budget 15 kB). Two e2e runs fail |
| Create-only project API | Works. Incomplete | No Worker test, no error codes, no snippet in the response |
| Accounts, roles | Built on both runtimes with the screens (Gate 2 backend and screens pull requests; mock [mockups/accounts.md](mockups/accounts.md), variants C, A, A) | Passkeys, sessions, one-time links, scoped tokens on both runtimes, one conformance suite, a real-browser run of the API and of every screen ([gate2-accounts.md](gate2-accounts.md), [evidence](evidence/2026-11-11-gate2-accounts.md), [screens](evidence/2026-11-11-gate2-ui.md)) |
| OIDC | Not built | Step 6 |
| Board, masks, previews | Not built | Not started |
| Step A, runtime hardening | Implemented, in pull request #130 | Branch `feat/standalone-runtime-hardening` (six commits on top of `3f3caba`). R1 to R9 closed except R16. `pnpm test` runs the 32 durability tests on workerd and on SQLite, plus 366 unit tests. 17 Node server tests and the admin e2e specs pass. One settings e2e still fails, as it does at `3f3caba` (Step B) |
| Step D, release tarball and updates | Implemented, in pull request #132, and the admin notice (J2) after it | The tarball, `bundle.json`, `/diag` release and channel, `feedbackkit-update` with check, update and rollback, signing in the dev and promote workflows (the keys and secrets exist, the dev builds are signed), the dev and stable comparison, a key rotation rehearsal. Ran under real systemd in a clean Debian 13 LXC with fixture releases ([evidence](evidence/2026-11-10-tarball-lxc.md)) and with the real signed dev builds ([evidence](evidence/2026-11-10-real-release-lxc.md)). The first stable release, 0.2.0, went through the promote workflow ([evidence](evidence/2026-11-11-stable-release.md)). Open: an update between two stable releases |
| MCP plumbing on the standalone server (ADR-015 amendment) | Implemented, in a pull request against `main`. Off until Gate 2 | The OAuth provider and MCP server run on Node with the provider's KV in the SQLite file. `/oauth/authorize` asks one function who is signing in (`authenticateConsent`); the standalone server answers nobody, so nothing can be approved, and the account session replaces it in a small follow-up after Gate 2. Tests with a stub identity in test code only, a shared suite on workerd and Node, the MCP SDK client against the bundled app ([evidence](evidence/2026-11-11-standalone-mcp.md)). Open: the follow-up that wires accounts in, and a real MCP client product |
| Step M, move from Cloudflare | Implemented in its own pull request | `feedbackkit-migrate export` and `import` in the tarball. The real wrangler on a local D1 and R2, then the standalone server answers as the Worker did ([evidence](evidence/2026-11-11-cloudflare-move.md)). Open: a run against a remote Cloudflare account |
| Step C, documentation honesty | Implemented on the docs branch | [claims.md](claims.md) with a proof for each statement, a standalone section in `docs/SECURITY.md`, one Node wording, one inbox term (Open, Done, Dismissed), a corrected anchor and an honest status line in the README and `docs/SELF_HOSTING.md`. The rollback claim now says that no rollback command exists |
| Step B, safe settings | Implemented, in pull request #130 | Five more commits on the same branch. The admin bundle is 14.9 kB gz (budget 15 kB) and the settings e2e passes. Decisions taken while building: removing a published type archives it (`templates[].archived`, `DELIVERY_CAPABILITY` 3), published field keys are not blocked from removal (only duplicates are refused), the retention minimum is the 7-day notice, and `pnpm deploy` records the capability after the deploy |

## Findings that change the plan

Each finding is assigned to a step. IDs are stable so later reviews can refer to them.

| ID | Finding | Step |
|---|---|---|
| R1 | A request path starting with `//` replaces the canonical origin and skips the origin allowlist (reproduced) | A |
| R2 | Failed-login lockout runs before the token check and is shared behind a proxy. 21 wrong tokens lock out the right one (reproduced) | A |
| R3 | `X-Forwarded-For` is read from the left, so a client can pick its own address (reproduced) | A |
| R4 | Admin screenshots cannot load with token auth, and each refused request counts toward the lockout | A, then Gate 2 |
| R5 | A failing sweep on start ends the process. At least one of two concurrent first starts fails (10 of 10 trials). `busy_timeout` is set after WAL | A |
| R6 | `delivery_capability` is overwritten on every start. No guard against newer schema or settings | A |
| R7 | The whole process environment is visible to settings that name secrets. `llm.baseUrl` receives the AI key | A, then Step 4 |
| R8 | Deleted attachments stay in the database file. Blobs never shrink the file | A |
| R9 | Dockerfile, Compose file and the CI image job were never run and carry development dependencies. Docker is now backlog | A (removal) |
| R10 | Admin bundle over budget. Numbers seed as `1` (retention would delete after one day). Optional strings save as empty | B |
| R11 | IDs are immutable only in the browser. Review can be published after the text changed. JSON and form drafts diverge | B |
| R12 | Create route: no tests, no codes, no snippet. Fresh Cloudflare deploy cannot create local projects | B |
| R13 | Retention lacks the notice guard from the 2026-10-24 plan | B |
| R14 | Docs: Node version, rollback claim, broken anchor, `Discarded` against `Dismissed`, missing standalone threat model | C |
| R15 | Picked images upload at once and the remove button keeps the object. Private elements are not excluded. Rectangle is a frame | Gate 1 |
| R16 | Uploads without a report never expire when no retention is set. No quota | Gate 1, A |
| R18 | `/diag` on the standalone server lists Cloudflare steps as next steps (`npx wrangler secret put`, `docs/QUICKSTART.md`). Seen in the LXC run | D |
| R19 | The systemd unit leaves `/var/lib/feedbackkit` at mode 755 and `systemd-analyze security` rates it 8.3 EXPOSED. Seen in the LXC run | D. Closed in the bundle unit: mode 700, rated 3.7 OK |
| R20 | A checkout install puts 575 MB on the host and needs pnpm, the network and 53 s. Seen in the LXC run | D. Closed by the tarball: 190 kB, Node and standard tools only |
| R17 | The standalone server has no release artifact: installs build on the target, `/diag` reports `0.0.0` and `local`, releases carry only `widget.js`, there is no update command and no notice of a newer release | D |

## Steps

![Step plan and release gates](diagrams/step-plan.png)

[Open the explorable diagram](diagrams/step-plan.html).

Each step is one reviewable PR (or a small series) with its own tests and docs. The spec fields are Why, Capabilities, Constraints, Non-goals and Success signals. UI changes follow mock before build and go to the maintainer for merge.

### Step A: harden the standalone runtime

- **Why:** the first runtime layer can lock out the operator, trust the wrong origin and lose or keep data wrongly.
- **Capabilities:**
  - Build request URLs by appending to the canonical origin. Reject paths that start with `//`.
  - Take the client address at a configured trusted-hop position from the right and validate it, so one client's failed logins no longer lock out another. The lockout stays ahead of the token check: it is the only throttle on guessing, and the Worker suite pins it (a client over the limit gets 429 even with the right token). Plan text before 2026-11-10 asked to check the token first; implementation found that this would remove the throttle.
  - Guard the start sweep, set `busy_timeout` first, check migrations inside the transaction, use `synchronous=NORMAL`, `secure_delete=ON`, `auto_vacuum=INCREMENTAL`.
  - Pass an allowlist of environment variables to the application. Keep `delivery_capability` at the maximum. Refuse to serve settings that need a newer release.
  - Load admin images with the Authorization header and show them from object URLs.
  - Remove `Dockerfile`, `compose.yaml`, `.dockerignore`, the CI image job and the Docker section of the README. One Node floor (24 LTS).
- **Constraints:** same Hono app, no new runtime dependency, Worker behavior unchanged and proven by the existing suite. A stricter `patSecret` rule warns on load and rejects on write, so stored settings keep working.
- **Non-goals:** accounts, masks, new screens.
- **Success signals:** every reproduced probe of the review is a test (R1 to R3, R5, R6). One conformance suite passes on both runtimes. No Docker file remains on the branch.

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
- **Capabilities:** the three documents of this change, ADR-016 as accepted, the roadmap backlog line, a standalone section in `docs/SECURITY.md` (proxy, attachment route, deletion guarantee), corrected anchors, one term for each state, one Node version, and a claim table that links each statement about runtime, rollback and deletion to a test or a step.
- **Constraints:** documentation only. A claim without a proof is removed or marked planned.
- **Non-goals:** behavior changes.
- **Success signals:** link check passes. Every row of the claim table names its proof.

### Gate 1: masked capture and upload contract (blocks the "private by design" claim)

- **Why:** an original image that reaches the server cannot be called masked, whatever the screen shows afterwards.
- **Concept:** [privacy-masking.md](privacy-masking.md), with the [image path](diagrams/privacy-image-path.html). Accepted by the owner on 2026-11-10 (S20).
- **Capabilities:**
  - A solid mask tool, rasterized into the pixels. Mask, thumbnail, upload and AI input come from the same bytes.
  - Images stay in memory until the visitor confirms. Removing one leaves no server copy. EXIF is stripped.
  - Capture masks form values and password fields and blocks out elements marked `data-fk-private`.
  - A `privacy.profile` per project: `strict` (new projects, and any public or unreadable destination) or `standard` (private destinations only). Strict requires the widget marker, rejects uploads with metadata and turns console capture off. Uploads that no report claims expire.
- **Constraints:** mock before build. The widget budget is 23 kB gz and has 0.2 kB left, so the mask tool loads on demand or the budget is changed by decision. No promise of automatic detection.
- **Non-goals:** replay, OCR, automatic redaction.
- **Success signals:** a Chromium test decodes every request body for each input path (capture, pick, paste, drop, retry) and shows that masked regions differ from the original, with a negative control that fails without the mask. A server test rejects unmarked uploads and uploads with metadata in strict projects. A mocked GitHub answer of `private: false`, `true` and an error forces, allows and forces the profile.

### Gate 2: local accounts and recovery (blocks the "autonomous" claim)

- **Why:** without it the only credential is a shared static token that can be locked out by anyone.
- **Capabilities:** sessions with CSRF protection, bootstrap and recovery by a one-time link from a host command (S14), `ADMIN_TOKEN` no longer needed to start, scoped API tokens for scripts and agents (created by an owner, hashed at rest, shown once, revocable), `ADMIN_TOKEN` ends once the first owner exists, a D1 design for the atomic owner claim and one-time tokens, a recovery path for Cloudflare (a script run with the operator's Cloudflare credentials), Cloudflare Access kept as an optional identity on that runtime (S15), passkeys through a maintained WebAuthn library, last-owner protection, revocation, admin images through the session, a threat model in `docs/SECURITY.md`.
- **Constraints:** no hand-written protocol. Passkeys need HTTPS or localhost, and the relying party ID follows `FK_PUBLIC_URL`, which then cannot be changed in the UI. D-02, D-03, D-09 and D-10 are decided (S11, S12, S14, S15).
- **Non-goals:** roles beyond owner and member, OIDC, public sign-up.
- **Success signals:** concurrent bootstrap yields one owner. A virtual authenticator completes enrollment and sign-in. A recovery drill works on a clean instance. A valid login is never blocked by other people's failed attempts, with and without a proxy. The old `ADMIN_TOKEN` is refused after bootstrap and a scoped token works for automation. One conformance suite runs bootstrap, sign-in and recovery on SQLite and on D1.

![First owner bootstrap](diagrams/gate2-bootstrap-sequence.png)

[Open the bootstrap sequence](diagrams/gate2-bootstrap-sequence.html). The other Gate 2 flows are [sign-in](diagrams/gate2-signin-sequence.html), [recovery](diagrams/gate2-recovery-sequence.html), [scoped tokens](diagrams/gate2-token-sequence.html) and [account states](diagrams/gate2-account-lifecycle.html). Decided by the owner on 2026-11-11 ([S23](scope.md)): a member may use the whole admin except accounts and tokens until Step 4, a token limited to some projects can neither create projects nor open System, and recovery revokes the API tokens that account created (`--keep-tokens` opts out). The mock variants were approved the same day: the account area as a name link with side navigation (C), recovery folded under "Locked out?" (A), a new API token in a dialog (A). They were the design. The backend follows them and the decisions S11, S12, S14 and S15. Token lifetime, command name and cookie attributes were decided in the pull request and are written down in [gate2-accounts.md](gate2-accounts.md).

### Step D: release tarball, version and updates

- **Why:** operators should install and update a finished release, without Git, pnpm or a compiler on the server (R17).
- **Needs first:** Step A (capability guard, start sweep, conformance suite).
- **Capabilities:**
  - A CI workflow builds the bundle for every dev tag and every stable tag and attaches `feedbackkit-vX.Y.Z.tar.gz`, `SHA256SUMS` and `SHA256SUMS.sig` to the GitHub release (release strategy below).
  - The tarball holds a single-file server without `node_modules`, widget and admin assets, migrations, the systemd unit, `feedbackkit-update` and `bundle.json` with release, channel, schema version and delivery capability. The server reads these from the bundle and no longer reads `src/shared/contract.ts` at runtime.
  - `/diag` and the System page show the release from `bundle.json`.
  - `feedbackkit-update` with `--check` and `--rollback`, as described in J12. The admin shows a notice for a newer stable release (J2) with an off switch.
  - `docs/SELF_HOSTING.md` describes install and update from the tarball. The clone-and-build path moves to `CONTRIBUTING.md` as the developer path.
- **Constraints:** the target needs Node.js 24 and the standard tools curl, tar, sha256sum and ssh-keygen, nothing else. Everything the repo ships is English: release notes, command output, docs and `bundle.json`. The admin notice is English only, as the admin is (decided 2026-11-10). Nothing updates without an operator command. The update check is one plain request to the GitHub Releases API and sends nothing about the installation. One bundle serves every Linux target. The update script is POSIX shell and CI tests it on fixtures.
- **Non-goals:** a Docker image, an npm registry package, an auto-update daemon, delta updates, init systems other than systemd.
- **Success signals:** the workflow produces tarball, checksums and signature from a dev tag (a dry run before the first stable tag). A fresh LXC installs it with only Node and the standard tools. An update from one release to the next keeps the data. A corrupted tarball, a tampered checksum file, a dev-signed stable release and a bad bundle each stop the update and restore the previous state. A key rotation has been rehearsed before the first signed release. `/diag` shows release and channel.

![Planned release and update flow](diagrams/release-update-sequence.png)

[Open the explorable diagram](diagrams/release-update-sequence.html). It describes the planned flow of this step, not shipped behavior.

Release strategy for the tarball:

| Topic | Rule |
|---|---|
| Versioning | SemVer from git tags (ADR-013). While the version is `0.x`, a minor release may break, and the release notes say so |
| Channels | `stable` (`vX.Y.Z`, the GitHub release marked latest) and `dev` (`vX.Y.Z-dev.N`, marked pre-release). The default is stable. `feedbackkit-update --channel dev` opts in. No `rc` tag: a tested dev build is promoted by hand |
| Build | Every merge builds a dev tarball. Promotion rebuilds the same commit under the stable version (ADR-013). CI checks that the dev and stable bundles of one commit are byte-identical except `bundle.json`, so what was tested is what ships |
| Retention | GitHub keeps the newest three dev pre-releases (ADR-013). Stable releases stay |
| Integrity | `SHA256SUMS` is signed with the release key of its channel (S10) and checked with `ssh-keygen -Y verify`. The public key ships in every bundle and in the docs. A checksum next to the tarball detects corruption only. The signature detects tampering |
| Update notice | Uses GitHub's latest-release endpoint, which skips pre-releases (on this repo it returns `v0.1.18` while `v0.1.19-dev.1` exists). On the dev channel it also offers newer dev builds. The gateway asks, not the browser, at most once a day, and `FK_UPDATE_CHECK=off` turns it off |
| Skipping releases | `bundle.json` names the oldest release a data directory can update from. The update command walks through intermediate releases when needed |
| Rollback | The two newest releases stay on disk. Migrations only add, so one release back works on the newer schema. Beyond that the update command restores the data copy |
| Support | Only the latest stable release gets fixes. A bad stable release is pulled by marking it pre-release and publishing a fixed patch |

### Step M: move a gateway from Cloudflare to the standalone server

- **Why:** an operator who starts on Cloudflare must be able to leave without losing reports, attachments or the snippets embedded in sites (J19). Nothing in the plan covered it.
- **Needs first:** Step D (the tarball), because the tool ships in it and imports into the server's own database.
- **Capabilities:**
  - `feedbackkit-migrate export` reads the D1 database and the attachments with the operator's own wrangler login (`wrangler d1 export`, `wrangler r2 object get`) and writes a directory: `d1.sql`, the objects and a manifest with counts and checksums.
  - `feedbackkit-migrate import` loads the dump into a scratch SQLite file, brings it to the schema of the installed release with the same migrations the server runs, copies projects, reports, attachments, events and the idempotency table into the standalone database in one transaction, and checks counts and checksums before and after the commit. `--dry-run` writes nothing.
  - `docs/SELF_HOSTING.md` has a section "Move from Cloudflare" with what stays different.
- **Constraints:** read-only on the Cloudflare side. Never touch production in tests: they run against a local D1 and R2. Refuse a non-empty destination, a newer schema or capability, and a damaged export. Secrets are not in D1, so the guide names the variables to set on the new host. No credentials are asked for or stored.
- **Non-goals:** a live sync, moving back to Cloudflare, rate-limit counters, OAuth and MCP grants (the standalone server has neither), Cloudflare Access settings.
- **Success signals:** a Worker fills a local D1 and R2 with fictional data, the tool moves it, and the standalone server started on the result shows the same projects, public keys, inbox and attachments.

### Step 3: verification on a fresh host

- **Why:** a build that passes on a laptop says little about an LXC.
- **Capabilities:** run J1, J2, J12 and J14 from the release tarball on a clean Debian LXC and on a clean cloud VPS (for example at Hetzner). Outbound traffic is allowed for the download and blocked until the first report. Include an update with data and a rollback. Update the status of each journey with the evidence.
- **Success signals:** transcripts and results are linked from the journeys. Only now may README and docs say the gateway runs without Cloudflare. Tag the release after this step.
- **Status (2026-11-10):** the clone-and-build path ran on a clean Debian 13 LXC ([evidence](evidence/2026-11-10-debian-lxc.md)), and so did the tarball path with fixture releases: install, update with data, rollback, a release that does not start, a reboot ([evidence](evidence/2026-11-10-tarball-lxc.md)). The same path then ran against the real signed dev builds 0.1.19-dev.5 and 0.1.19-dev.6 from GitHub: install, update, rollback, update again ([evidence](evidence/2026-11-10-real-release-lxc.md)). A cloud VPS stays untested, by decision of the owner. J2 (the notice) is built and was run in Chrome. The first stable release, 0.2.0, went through the promote workflow and installed on a clean LXC ([evidence](evidence/2026-11-11-stable-release.md)). An update between two stable releases has not run yet.

### Steps 4 to 10, after the gates

| Step | Content | Needs first |
|---|---|---|
| 4 | Member role, project access, authorization on assets and feedback by project, instance-level AI and GitHub connections referenced by ID | Gate 2 |
| 5 | Types navigation and board view over the three states (S17) | Approved mock |
| 6 | OIDC through a maintained library, binding by `iss` and `sub` (S18) | Gate 2, upstream docs read |
| 7 | Widget preview and theme tokens (#57) | Approved mock, contrast rules |
| 8 | Signed webhook (#58) | None, optional |
| 9 | Team board embed: an iframe route that opens with a short-lived signed link, `frame-ancestors` from the project's allowed origins, a read-only board API for scoped tokens (S21) | Gate 2, Step 5, approved mock |
| 10 | Own-reports view: identity signed by the host backend, a stored reporter ID on local reports, a separate lazy-loaded bundle (S21) | Step 9, retention rules of S2 applied to the reporter ID |

## Release gates

| Gate | Condition |
|---|---|
| Autonomy | Steps A, B, D, Gate 2 and Step 3 are done. Until then no document claims independence from Cloudflare |
| Privacy | Gate 1 is done. Until then no document claims masked or private screenshots |
| Honesty | Step C is done and every claim in the claim table has a proof |

## Definition of done for every step

- The tests named in the step pass in CI. A green build is not evidence of behavior.
- Docs change in the same PR: README, `ADMIN.md`, `SELF_HOSTING.md`, `ERRORS.md`, `SECURITY.md` as affected.
- The affected journeys in [journeys.md](journeys.md) get their new status, and their `Verified` lines are repeated against the code or a live run.
- A decision that changes scope gets an ADR. A new error gets a code.
- The PR body starts with its issues (`Fixes`, `Refs` or `No issue`). Parent epics #1, #2 and #6 stay open until their acceptance criteria are met.

## Related public issues

| Work package | Existing issues | Step |
|---|---|---|
| Admin, types and first run | #55, #59, #6 | B, 5 |
| Theme and preview | #57 | 7 |
| Independent operation and docs | #60, local part of #3, #69, #72 | A, C, D, 3 |
| Privacy and screenshot reliability | PII part of #127, #128, #129 | Gate 1 |
| Optional delivery integrations | #58, webhook part of #127 | 8 |

#112 is a consumer rollout after a stable gateway. #56 and #61 improve optional setup paths and do not block local use. #1 and #2 are not sprint commitments. #94 is praise and #107 a triage log. #66 needs a check against the current version, #67 and #95 are separate marketing slices. #128 and #129 look like duplicates and need one shared reproduction first.

Reports filed in embedding-app repositories need triage per component. Carry over a neutral summary only. Do not copy account context, private attachments or unrelated requests from other apps into this public repository.

Co-created by Michel with NORA (AI Agent)
