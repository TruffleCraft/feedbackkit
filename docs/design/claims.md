# Claims and their proof

Every statement the documentation makes about the runtimes, updates, rollback, deletion and security of the standalone server, and what backs it. A statement without a proof is removed from the user documents or marked as planned. Status is `verified` (a test or a run covers it), `partly` (the logic is tested, the real environment is not), `convention` (a rule the repository follows by review, no test) or `planned` (not built, the user documents must not claim it).

Measured at the head of the branch `feat/standalone-runtime-hardening` on 2026-11-10. Test files are under `test/` and `e2e/`. The plan is in [autonomous-admin-plan.md](autonomous-admin-plan.md), the journeys in [journeys.md](journeys.md).

## Runtime

| Claim | Made in | Proof | Status |
|---|---|---|---|
| One Hono application serves both runtimes | `docs/ARCHITECTURE.md`, `README.md` | The 42 tests in `test/durable/` run on workerd with the real D1 and R2 (`vitest.workers.config.ts`) and on Node with the SQLite storage (`vitest.conformance.config.ts`). `pnpm test` runs both | verified for what those tests cover |
| The server installation needs no Cloudflare account | `README.md`, `docs/SELF_HOSTING.md` | `test/server-storage.test.mjs` starts the real server with Node only. A clean Debian 13 LXC ran it from a checkout with no Cloudflare account ([evidence](evidence/2026-11-10-debian-lxc.md)) | verified on a Debian 13 LXC. A cloud VPS was not tested (owner's decision) |
| GitHub issue and Project delivery work on the standalone server | `docs/SELF_HOSTING.md` | `test/durable/delivery.test.ts` runs the delivery logic on SQLite against a mocked GitHub | partly: no real GitHub delivery was run from the standalone server (J9, Step 3) |
| The standalone server carries the OAuth provider and the MCP server with the Worker's tools and read-only scopes, off by default, and nobody can approve a connection on it yet | `docs/SELF_HOSTING.md`, `README.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md` | `test/server-oauth.test.mjs` runs the real provider and MCP handler on Node with a stub identity that exists in test code only: registration, consent, PKCE, exchange, refresh, revoke, expiry, resource, tools per scope, a read call, a refused call. `test/server-mcp-e2e.test.mjs`: the MCP SDK client does the whole flow against the bundled app (stub identity), and the unpacked release tarball with Node alone is off by default, refuses every consent request with `FK_MCP=on` and says so in the start log and `/diag`. A clean Debian 13 LXC ran an earlier version of this change, whose identity step is no longer in the code ([evidence](evidence/2026-11-11-standalone-mcp.md)) | verified for the plumbing. Not run: a real MCP client product, because no identity exists to approve it |
| Where MCP is off, every `/mcp`, `/oauth/*` and `/.well-known/oauth-*` path answers 404 and names the reason | `docs/SELF_HOSTING.md` | `test/server-mcp-e2e.test.mjs`, `test/server-storage.test.mjs` | verified |
| The consent route asks one function who is signing in, Cloudflare Access on the Worker and nobody on a standalone server | `docs/SECURITY.md`, `docs/DECISIONS.md` | `test/consent-identity.test.ts` (the binding decides, no fall back to Access), `test/mcp-oauth.test.ts` (the Worker's Access flow, unchanged), `test/server-oauth.test.mjs` (the server's own answer is nobody whatever the request carries, nothing stored) | verified |
| The stub identity is not in the production build | `docs/SECURITY.md` | `test/server-oauth.test.mjs` reads `dist-server/app.mjs`; `test/server-mcp-e2e.test.mjs` shows the unpacked release refusing a request that carries the stub's header | verified |
| MCP is refused at start where a sign-in would cross a network in clear text | `docs/SELF_HOSTING.md`, `docs/SECURITY.md` | `test/server-mcp-e2e.test.mjs` (unsafe combinations, the `planMcp` table) | verified for the configuration it can see. A proxy that serves plain http is not visible to the server |
| Issuer and resource come from `FK_PUBLIC_URL`, never from the request | `docs/SECURITY.md`, `docs/DECISIONS.md` | `test/server-mcp-e2e.test.mjs` (a hostile `Host` header against a running server), `test/server-oauth.test.mjs` | verified |
| The consent handle works once and only in the browser that opened the page | `docs/SECURITY.md` | `test/server-oauth.test.mjs` (replay, another browser's cookie, no cookie, a made-up handle, a cross-origin form) | verified |
| The provider's storage is a table in the SQLite file made by the storage shim, expiry is honored and swept, and an older release ignores it | `docs/SELF_HOSTING.md`, `docs/DECISIONS.md` | `test/server-kv.test.mjs`. `test/durable/kv-contract.test.ts` runs the same calls on Cloudflare KV (workerd) and on the adapter. The released 0.2.0 started on a database that held OAuth rows ([evidence](evidence/2026-11-11-standalone-mcp.md)) | verified |
| One suite shows the Worker and the standalone server behave the same for the OAuth protocol and the tools | `docs/DECISIONS.md` | `test/durable/mcp-oauth-flow.test.ts` runs on workerd with Cloudflare KV and on Node with SQLite. The sign-in step differs by design and has its own tests (`test/mcp-oauth.test.ts`, `test/consent-identity.test.ts`, `test/server-oauth.test.mjs`) | verified |
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
| A gateway moves from Cloudflare (D1 and R2) into the standalone server with its projects, public keys, settings revisions, reports, inbox state, attachments and delivery capability, and the import checks what it wrote | `docs/SELF_HOSTING.md` ("Move from Cloudflare") | `test/server-migrate.test.mjs` (refusals, schema upgrade, dry run, integrity checks, the tarball command) and `test/server-migrate-e2e.test.mjs` (the real wrangler on a local D1 and R2, then the standalone server answers as the Worker did). A run in [the evidence](evidence/2026-11-11-cloudflare-move.md) | verified for a local D1 and R2. A remote export was not run (J19) |
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
