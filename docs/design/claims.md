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
| A release tarball with a signed checksum, an update command and an update notice | `scope.md` only | None | planned (Step D). The user documents do not claim it |
| A release older than the data refuses to start | `docs/SELF_HOSTING.md` | `test/server-storage-hardening.test.mjs`: "the delivery capability never goes down" | verified |
| The delivery capability only rises, on both install paths | `docs/RELEASES.md`, `docs/QUICKSTART.md` | `test/server-storage-hardening.test.mjs`, `test/server-capability.test.mjs` | verified |
| There is a rollback command | none | None | planned (Step D). Going back means restoring the backup taken before the update and starting the older checkout |
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
