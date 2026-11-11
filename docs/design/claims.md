# Claims and their proof

Every statement the documentation makes about the runtimes, updates, rollback, deletion and security of the standalone server, and what backs it. A statement without a proof is removed from the user documents or marked as planned. Status is `verified` (a test or a run covers it), `partly` (the logic is tested, the real environment is not), `convention` (a rule the repository follows by review, no test) or `planned` (not built, the user documents must not claim it).

Measured at the head of the branch `feat/standalone-runtime-hardening` on 2026-11-10. Test files are under `test/` and `e2e/`. The plan is in [autonomous-admin-plan.md](autonomous-admin-plan.md), the journeys in [journeys.md](journeys.md).

## Runtime

| Claim | Made in | Proof | Status |
|---|---|---|---|
| One Hono application serves both runtimes | `docs/ARCHITECTURE.md`, `README.md` | The 42 tests in `test/durable/` run on workerd with the real D1 and R2 (`vitest.workers.config.ts`) and on Node with the SQLite storage (`vitest.conformance.config.ts`). `pnpm test` runs both | verified for what those tests cover |
| The server installation needs no Cloudflare account | `README.md`, `docs/SELF_HOSTING.md` | `test/server-storage.test.mjs` starts the real server with Node only. A clean Debian 13 LXC ran it from a checkout with no Cloudflare account ([evidence](evidence/2026-11-10-debian-lxc.md)) | verified on a Debian 13 LXC. A cloud VPS was not tested (owner's decision) |
| GitHub issue and Project delivery work on the standalone server | `docs/SELF_HOSTING.md` | `test/durable/delivery.test.ts` runs the delivery logic on SQLite against a mocked GitHub | partly: no real GitHub delivery was run from the standalone server (J9, Step 3) |
| OAuth and MCP are not served by the standalone server | `docs/SELF_HOSTING.md` | `test/server-storage.test.mjs` asserts 404 on `/mcp` | verified |
| Node.js 24 or newer | `README.md`, `docs/SELF_HOSTING.md`, `package.json` `engines` | The `standalone` CI job runs `pnpm test:server` on Node 24 and on Node 26 | verified |
| Run one process per database | `docs/SELF_HOSTING.md` | Opening one database from two processes at the same instant is safe (`test/server-storage-hardening.test.mjs`). Nothing stops a second long-running process | convention |
| Run as a systemd service | `docs/SELF_HOSTING.md`, `deploy/feedbackkit.service` | The unit, with its hardening, ran in an unprivileged Debian 13 LXC without nesting, survived `kill -9` and a reboot ([evidence](evidence/2026-11-10-debian-lxc.md)) | verified on a Debian 13 LXC. Exposure score 8.3 (R19) |

## Install, update and rollback

| Claim | Made in | Proof | Status |
|---|---|---|---|
| Install from a checkout with pnpm | `README.md`, `docs/SELF_HOSTING.md` | CI builds both bundles and runs the server tests. The same steps ran on a clean Debian 13 LXC ([evidence](evidence/2026-11-10-debian-lxc.md)) | verified on a Debian 13 LXC. Not a cloud VPS (owner's decision) |
| The server builds as a release tarball that installs with Node and standard tools only | `docs/RELEASES.md`, `docs/SELF_HOSTING.md` | `test/server-bundle.test.mjs` (byte-identical builds, unpacks and runs with Node alone). The install steps ran in a clean Debian 13 LXC, with fixture releases ([evidence](evidence/2026-11-10-tarball-lxc.md)) with the real dev build 0.1.19-dev.5 from GitHub ([evidence](evidence/2026-11-10-real-release-lxc.md)) and with the real stable release 0.2.0, including a reboot ([evidence](evidence/2026-11-11-stable-release.md)) | verified with fixture releases, a real dev build and the real stable release |
| A signed release exists | `docs/RELEASES.md` | The dev builds 0.1.19-dev.5 and 0.1.19-dev.6 carry a `SHA256SUMS.sig` that `ssh-keygen -Y verify` accepts against `release-keys/dev.pub`. The stable key and a changed file are refused ([evidence](evidence/2026-11-10-real-release-lxc.md)). The stable release 0.2.0 verifies against `release-keys/stable.pub`, the dev key refuses it, and the promote run compared its tarball with the tested dev tarball ([evidence](evidence/2026-11-11-stable-release.md)) | verified for both channels |
| The System page tells a tarball install that a newer release exists, asks GitHub at most once a day, sends nothing about the installation and can be switched off | `docs/SELF_HOSTING.md`, `docs/SECURITY.md`, `docs/RELEASES.md` | `test/server-update-notice.test.mjs` (version comparison, release pick per channel, the switch, every failure state, the request without installation data, the daily cache, the real server against a fake GitHub), `test/admin-api.test.ts`, `e2e/admin.spec.ts`. A run in Chrome on desktop and phone, light and dark, and one check against the real GitHub API (J2) | verified. The notice has not yet shown a real signed release, because none exists |
| A gateway moves from Cloudflare (D1 and R2) into the standalone server with its projects, public keys, settings revisions, reports, inbox state, attachments and delivery capability, and the import checks what it wrote | `docs/SELF_HOSTING.md` ("Move from Cloudflare") | None yet | planned (J19) |
| A release older than the data refuses to start | `docs/SELF_HOSTING.md` | `test/server-storage-hardening.test.mjs`: "the delivery capability never goes down" | verified |
| The delivery capability only rises, on both install paths | `docs/RELEASES.md`, `docs/QUICKSTART.md` | `test/server-storage-hardening.test.mjs`, `test/server-capability.test.mjs` | verified |
| `feedbackkit-update` updates and rolls back, and a failed update restores the old release and its data | `docs/RELEASES.md`, `docs/SELF_HOSTING.md` | `test/server-update.test.mjs` against a fake GitHub API and a fake `systemctl` that runs the real bundle. The same cases ran under real systemd ([evidence](evidence/2026-11-10-tarball-lxc.md)). Check, update, rollback and update again also ran against the real signed dev builds on GitHub ([evidence](evidence/2026-11-10-real-release-lxc.md)) | verified with fixture releases and real dev builds. On the stable channel only `--check` ran, because no newer stable release exists yet |
| A tampered checksum file, a corrupted tarball, a stable release signed with the dev key, a bundle that names another release and a tarball with extra entries each stop the update | `docs/RELEASES.md` | `test/server-update.test.mjs`. Removing the signature or checksum check makes the matching tests fail | verified |
| A key rotation works: a release signed with the old key brings the new key list | `docs/RELEASES.md` | `test/server-update.test.mjs` ("a key rotation") | verified as a rehearsal. No real key has been rotated |
| The stable tarball of a commit equals its tested dev tarball except the files that name the release | `docs/RELEASES.md` | `test/server-release-tools.test.mjs` tests the comparison. The promote workflow step that runs it was not run on GitHub | partly |
| A checkout install has a rollback command | none | None | convention: there is none, going back means restoring the backup |
| Migrations only add, so one release back keeps working on the newer schema | `docs/RELEASES.md` | Reviewed by hand, no test | convention |

## Deletion and retention

| Claim | Made in | Proof | Status |
|---|---|---|---|
| Retention is strict: handled and unhandled reports go at `retentionDays`, with their attachments | `docs/SECURITY.md`, `docs/ADMIN.md` | `test/durable/retention.test.ts`, on both runtimes | verified |
| A retention below 7 days is refused when settings are written | `docs/ADMIN.md` | `test/durable/admin-writes.test.ts` | verified |
| The review states what a retention change deletes | `docs/ADMIN.md` | `test/durable/admin-writes.test.ts` (the counts), `e2e/settings.spec.ts` (the review text) | verified |
| A deleted attachment leaves no trace in the database file or the write-ahead log | `docs/SECURITY.md` | `test/server-storage-hardening.test.mjs`: "a deleted attachment leaves the database file and the write-ahead log" | verified for the database files. Snapshots, backups and GitHub's image cache are outside it |
| Deleting a record does not delete the GitHub ticket | `docs/ADMIN.md`, `README.md` | Design rule (S1). The delete route touches only the gateway's own rows and attachments (`test/durable/admin-writes.test.ts`) | verified |
| A report that was confirmed to the visitor survives a crash of the process | `docs/SECURITY.md` | `test/durable/persist.test.ts` (stored before it is acknowledged) | partly: a power loss or kernel crash can lose the last few reports, because the database runs with `synchronous=NORMAL` |
| Images are masked before they leave the browser | none | None | planned (Gate 1). The user documents do not claim it |

## Security of the standalone server

| Claim | Made in | Proof | Status |
|---|---|---|---|
| A request path cannot replace the public origin | `docs/SECURITY.md` | `test/server-http.test.mjs` | verified |
| A client cannot choose its own address, and the failed-login limit is per client | `docs/SECURITY.md`, `docs/SELF_HOSTING.md` | `test/server-http.test.mjs`. The lockout itself: `test/admin-api.test.ts` | verified |
| The application sees only an allowlist of environment variables | `docs/SECURITY.md` | `test/server-env.test.mjs` | verified |
| Settings can name only `GITHUB_PAT_<name>` secrets | `docs/SECURITY.md` | `test/secret-names.test.ts` | verified |
| Private screenshots need the admin sign-in | `docs/SECURITY.md` | `test/server-storage.test.mjs` (401 without the token, 404 on the public route), `e2e/admin.spec.ts` (loads with the token) | verified |
| Published type IDs cannot be dropped, archived types are hidden from visitors | `docs/ADMIN.md` | `test/template-ids.test.ts`, `test/durable/admin-writes.test.ts` | verified |
| Accounts, passkeys, OIDC and scoped API tokens | none | None | planned (Gate 2). `ADMIN_TOKEN` is the only credential |

Co-created by Michel with NORA (AI Agent)
