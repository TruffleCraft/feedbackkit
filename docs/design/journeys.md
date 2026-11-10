# Journeys

One page per question: who does what, what the system guarantees, what proves it. Status is measured against the WIP branch `codex/admin-self-hosting` at `3f3caba` and the review of 2026-11-10. A journey is `works` only when the evidence named here exists and passes. A mock, a build or a passing unit test does not move it.

Roles and examples are fictional. Robin runs `example.org` and operates the gateway. Sam visits the site and sends a report. Taylor is a teammate Robin invites. The setup agent is an LLM with terminal access.

Scope and non-goals are in [scope.md](scope.md). The steps that close the gaps are in [the plan](autonomous-admin-plan.md).

| ID | Journey | Status today | Gate |
|---|---|---|---|
| J1 | Install on Linux or a Proxmox LXC | partly | autonomy |
| J2 | Install with Docker Compose | partly | autonomy |
| J3 | Bootstrap the first owner | planned | autonomy |
| J4 | Create a project and receive a first report | partly | autonomy |
| J5 | Define feedback types, fields and destinations | partly | none |
| J6 | Sam sends a report with a screenshot | works, unmasked | privacy |
| J7 | Sam attaches an own image | gap | privacy |
| J8 | Robin triages the local inbox | partly | none |
| J9 | Robin follows a GitHub delivery | works on Cloudflare, unverified standalone | none |
| J10 | Taylor signs in | planned | autonomy |
| J11 | Robin is locked out and recovers | planned | autonomy |
| J12 | Upgrade and roll back | partly | autonomy |
| J13 | Reports expire | partly | privacy |
| J14 | A setup agent installs and verifies | draft | autonomy |
| J15 | Robin changes the widget look and previews it | partly | none |

## J1 Install on Linux or a Proxmox LXC

- **Goal:** Robin has a running gateway on an LXC without Docker nesting and without a Cloudflare account.
- **Steps:** install Node.js 24 LTS, clone a release tag, `pnpm install --frozen-lockfile`, `pnpm build:widget && pnpm build:server`, install the systemd unit, start it.
- **Guarantees:** the service refuses to start with a weak admin token or a bad public URL. Migrations run once. The first sweep cannot keep the service from starting. `/diag` is green only when schema and capability match.
- **Failure paths:** two starts at once on one data directory (today both fail 6 of 6 times in the probe), a failing sweep (crash loop under `Restart=on-failure`), a Node release without `node:sqlite`.
- **Evidence:** fresh LXC with outbound traffic blocked, installation from the README to a green `/diag`, then reboot and restart tests. A conformance suite runs on both runtimes.
- **Today:** the happy path works on a Mac with Node 26. Docker, systemd and a real LXC were not run. The docs say "Node 24+", `engines` says `>=22.13`, CI runs 22 and 24.

## J2 Install with Docker Compose

- **Goal:** same result with `docker compose up -d --build`.
- **Steps:** copy `.env.example`, set `ADMIN_TOKEN` and `FK_PUBLIC_URL`, start, open `/admin`.
- **Guarantees:** the data volume survives rebuilds. The health check follows `PORT`. The image holds runtime files only, and the runtime user cannot rewrite the code.
- **Failure paths:** a custom `PORT` marks the container unhealthy, a bind-mounted data directory with wrong ownership, a reverse proxy that collapses all visitors to one address.
- **Evidence:** CI builds the image and polls `/diag` (exists). Add a restart-with-data test and a non-default port.
- **Today:** the CI job exists. The image copies about 540 MB of development dependencies. The health check hardcodes port 8787.

## J3 Bootstrap the first owner

- **Goal:** the first person to reach a fresh instance can become owner only if they control the installation.
- **Steps:** the operator proves control (the configured recovery credential), registers a passkey, the instance records exactly one owner.
- **Guarantees:** two simultaneous attempts produce one owner. No public first-user route exists. The last owner cannot be removed or demoted.
- **Failure paths:** a second browser races the first, the passkey ceremony fails halfway, the public URL changes after enrollment (passkeys bind to it).
- **Evidence:** integration tests with concurrent requests, a Playwright virtual authenticator, a threat model section in `docs/SECURITY.md`.
- **Today:** not built. The only credential is the static `ADMIN_TOKEN`.

## J4 Create a project and receive a first report

- **Goal:** from a signed-in admin to a first report in the inbox.
- **Steps:** New project (ID, origin, language), copy the snippet, paste it into the site, send a test report, open the inbox.
- **Guarantees:** creating never overwrites. The response contains the snippet. Errors carry codes from `docs/ERRORS.md`.
- **Failure paths:** duplicate ID (409, exists), origin typo, Cloudflare gateway without delivery capability (the create call is refused with 422 on a fresh deploy, found by reading the code, not yet reproduced).
- **Evidence:** unit tests for the create route on the Worker runtime, an e2e for the dialog (success, 409, invalid origin, network failure).
- **Today:** the dialog and route work on the standalone server. The route has no Worker-side test and no error codes. The response omits the snippet that `AGENT_SETUP.md` tells agents to install.

## J5 Define feedback types, fields and destinations

- **Goal:** Robin adds Bug and Feature request, each with its own questions, required fields and destination.
- **Steps:** open Settings, add a type, add fields, pick a destination (inbox, issue, project), review the diff, publish.
- **Guarantees:** type and field IDs are unique and never change once published, enforced by the server. Removing a type archives it. Numbers and enums never start with a destructive value. A publish needs a review of exactly the text that is published.
- **Failure paths:** two admins publish at once (409 exists), a reload mid-edit, JSON edits while the form is open.
- **Evidence:** server tests for duplicate and renamed IDs, e2e for reorder, remove, JSON round trip and stale save.
- **Today:** the form exists. IDs are locked only in the browser. A review can be published after the text changed during the request. Closing the JSON panel can drop edits.

## J6 Sam sends a report with a screenshot

- **Goal:** Sam describes a problem, answers one follow-up, sends. The report reaches its destination and nothing sensitive leaves the page unmasked.
- **Steps:** open the widget, type, review the captured screenshot and mask areas, answer the follow-up, confirm.
- **Guarantees:** the report is confirmed only after it is stored. The screenshot Sam reviewed is the screenshot uploaded and the one the AI sees. Marked private elements and password fields are not captured.
- **Failure paths:** AI error (the report goes out unenriched), storage error (retryable 503), tracker error (kept, retry in admin), network loss (the text survives a retry).
- **Evidence:** exists for loss paths. New: a Chromium test that decodes the request bodies and shows masked pixels differ from the original, plus a negative control.
- **Today:** loss handling works. There is no mask tool (the rectangle is a frame), no exclusion of private elements, and the AI receives whatever the capture produced.

## J7 Sam attaches an own image

- **Goal:** Sam adds a photo or screenshot of their own and masks parts of it before anything is sent.
- **Steps:** pick an image, see it locally, mask areas, remove it if wanted, send with the report.
- **Guarantees:** the image stays in the browser until the final confirmation. Removing it leaves no server copy. EXIF data is stripped.
- **Failure paths:** a huge or malformed file, a tab closed before sending, an old widget that uploads on pick.
- **Evidence:** the same byte-level test for every input path (capture, manual pick, paste, drop, retry), and a server test that rejects unmarked uploads for projects that require masking.
- **Today:** a picked image uploads at once. The remove button drops the key, not the stored object. A project without a retention period never expires uploads that no report claims.

## J8 Robin triages the local inbox

- **Goal:** Robin works through local reports and keeps GitHub reports in GitHub.
- **Steps:** open the inbox, look at a report and its screenshot, mark it open, done or dismissed, add a note, optionally copy it for an agent.
- **Guarantees:** only local reports have a local state. A board view shows the same three states. Screenshots load for a signed-in admin and for nobody else. Opening a list never counts as a failed login.
- **Failure paths:** screenshots behind token auth, a state value an older reader does not know.
- **Evidence:** e2e in a real browser with token auth and with a session, a test that a new state value is rejected until readers handle it.
- **Today:** list, states, notes and delete work. With a bearer token the screenshot `<img>` cannot authenticate, and each refused request counts toward the login lockout.

## J9 Robin follows a GitHub delivery

- **Goal:** Robin sees whether a report arrived, where it went and whether delivery worked, and retries when it did not.
- **Steps:** open the delivery log, follow the link to GitHub, retry a failed or uncertain delivery.
- **Guarantees:** the log never claims the current GitHub status. An uncertain result is shown as uncertain. A retry does not create a duplicate.
- **Failure paths:** token without Projects permission, a field that does not exist, a delivery that may have succeeded.
- **Evidence:** exists on the Worker with mocked GitHub. New: one real, authorized test delivery per runtime, with the destination checked by hand.
- **Today:** the delivery model is on `main`. The standalone server has not delivered to a real GitHub destination.

## J10 Taylor signs in

- **Goal:** Taylor joins by invitation and signs in with a passkey or the operator's identity provider.
- **Steps:** Robin invites Taylor to a project, Taylor opens the link, registers a passkey or signs in through OIDC, lands in the project.
- **Guarantees:** invitations are single use and expire. OIDC identities bind by `iss` and `sub`. Sessions can be revoked. Taylor sees only the invited projects.
- **Failure paths:** reused or expired invitation, an identity provider that returns an unverified email, a deleted passkey.
- **Evidence:** tests for state, nonce and PKCE, for cross-project denial and for revocation. Libraries for WebAuthn and OIDC, no hand-written protocol.
- **Today:** not built. Every credential holder is a full admin.

## J11 Robin is locked out and recovers

- **Goal:** Robin regains access without a vendor and without opening the instance to others.
- **Steps:** run a recovery command on the host, receive a one-time link, set up a new passkey, old sessions are revoked.
- **Guarantees:** recovery needs host access. A valid login is never blocked by the failed-login counter of other people.
- **Failure paths:** all passkeys lost, the identity provider is down, a flood of wrong tokens from other visitors.
- **Evidence:** a test with and without a reverse proxy that 25 wrong tokens do not block the right one. A recovery drill on a clean instance.
- **Today:** 21 wrong tokens from one address make the correct token return 429 (reproduced). Behind a proxy that address is shared by everyone.

## J12 Upgrade and roll back

- **Goal:** Robin updates safely and can go back.
- **Steps:** stop the service, copy the data directory, check out the new tag, rebuild, start, check `/diag`. To go back: stop, restore the copy, check out the old tag.
- **Guarantees:** migrations only add. `/diag` goes red when stored settings need a newer release. A rollback does not lower the recorded delivery capability.
- **Failure paths:** an old release on a newer schema, a copy taken while the process writes, an interrupted migration.
- **Evidence:** an upgrade and rollback test on a data directory with real rows, and a documented, tested backup that includes the write-ahead log.
- **Today:** the standalone server overwrites the capability on every start. `docs/RELEASES.md` promises the opposite for the Cloudflare path.

## J13 Reports expire

- **Goal:** data disappears when the privacy promise says it does, and nothing disappears by accident.
- **Steps:** Robin sets a retention period, unhandled reports are listed 7 days before deletion, the sweep deletes rows and attachments together.
- **Guarantees:** strict deletion with notice (decided 2026-10-24). Shortening the period never deletes before the notice has run. The review step shows how many reports a change would delete. Deleted attachments do not stay readable in the database file.
- **Failure paths:** a form that seeds one day, a clock that jumps forward, a sweep that fails on start.
- **Evidence:** tests for the notice guard and the count, a test on the file that a deleted blob's bytes are gone, a startup test with a failing sweep.
- **Today:** deletion is strict and retroactive. The form can seed one day. Freed pages keep their content until reused.

## J14 A setup agent installs and verifies

- **Goal:** an agent leaves a working, verified installation and a clear handoff.
- **Steps:** read the agent guide, choose the runtime, install, create the project, send one authorized test report, report evidence.
- **Guarantees:** the guide names what it could not verify. Secrets never appear in output. The create response contains the snippet.
- **Failure paths:** a local AI endpoint that needs no key but the gateway insists on one, an agent that claims a planned feature.
- **Evidence:** an agent run on a clean host with a transcript, each claim in the guide linked to a test or a step.
- **Today:** the guide is a draft. It describes a placeholder key for local AI and a snippet the API does not return.

## J15 Robin changes the widget look and previews it

- **Goal:** theme, accent and heading change without code, and the preview matches the real widget.
- **Steps:** open Appearance, change tokens, see a live preview with every state, publish.
- **Guarantees:** contrast is checked. Unknown tokens are rejected. Derived colors follow the accent.
- **Failure paths:** an accent with poor contrast, a host that sets its own theme.
- **Evidence:** a widget test that reads the applied tokens, a contrast check, a preview that uses the widget's own bundle.
- **Today:** theme, accent and heading exist. Only the accent variable is set, so the soft and text variants stay violet. No widget test reads them.

Co-created by Michel with NORA (AI Agent)
