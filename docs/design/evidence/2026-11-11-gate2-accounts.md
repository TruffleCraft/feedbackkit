# Gate 2, local accounts: what ran, 2026-11-11

Three kinds of evidence: the automated suites, a real browser against the real server process, and a drill from the release tarball on a clean Debian 13 LXC. The code under test is the head of the Gate 2 backend branch; the LXC ran the tarball built from commit `3b01016`.

## Automated suites

| Suite | Result |
|---|---|
| `pnpm typecheck` | clean |
| `vitest run` (Node, fake D1) | 29 files, 390 tests, includes `test/auth-gate.test.ts` (9 tests: the retired `ADMIN_TOKEN` on `/diag` and config import, Access beside accounts, scoped tokens at the app level, the standalone `/diag` next step) |
| `vitest run -c vitest.workers.config.ts` (workerd, local D1 of Miniflare) | 5 files, 84 tests, includes `test/durable/accounts.test.ts` (42 tests) |
| `vitest run -c vitest.conformance.config.ts` (the same files on SQLite) | 5 files, 84 tests |
| `pnpm test:server` (Node server tests) | 61 tests, includes `server-accounts` (host command, start without `ADMIN_TOKEN`, release layout, throttle on the real server with and without `FK_TRUSTED_PROXY_HOPS`), `server-admin-link` (the Cloudflare script against a stand-in for wrangler) and two update tests (migration 0005 through `feedbackkit-update`, rollback to schema 4, and the refusal of a release from before accounts on data at capability 4) |
| `pnpm exec playwright test e2e/accounts-real-server.spec.ts` | 3 tests in Google Chrome 157.0.8103.50 with a WebAuthn virtual authenticator, against a real `scripts/server.mjs`. The suite was run in the installed Chrome (`channel: "chrome"`), because no Playwright Chromium was installed on the machine; CI installs Chromium for `pnpm e2e` |
| `pnpm exec wrangler deploy --dry-run` | the Worker bundles with `@simplewebauthn/server`: 2198 KiB, 429 KiB gzipped |

Controls that show the tests can fail:

- `concurrent bootstrap yields exactly one owner` runs eight attempts at once on both runtimes. A check-then-insert claim in the same file lets several owners through, and a run with the arbiter and the guards removed from `completeBootstrap` made the test fail (zero winners instead of one). The restored code passes.
- A valid login is not blocked by other people's failed attempts: 40 failed token attempts from one address are throttled (`429`, `Retry-After`), then the valid token from that address and from another one answers `200`, on the real server with one trusted proxy and with none.
- The older-release refusal needs the capability: the same data started by a bundle that reports capability 3 stops with `This database needs delivery capability 4 and this release provides 3`.

## Drill on a clean Debian 13 LXC from the release tarball

Unprivileged Debian 13 LXC (VMID 531), `nesting=0`, 2 cores, 2 GB RAM, 8 GB disk, on a Proxmox VE 9.2 host. Prepared by hand: `curl`, `ca-certificates`, `xz-utils`, `openssh-client`, `openssl`, `procps`, `sudo`, Node.js v24.22.2 from the nodejs.org tarball with its checksum verified. The tarball was built from commit `3b01016` as `0.3.0-dev.1` (362 kB) and copied in; the signature path was not part of this run (it is covered by the [earlier evidence](2026-11-10-real-release-lxc.md)). The install followed `docs/SELF_HOSTING.md`: user `feedbackkit`, `/opt/feedbackkit/releases/<version>` with `current`, `/etc/feedbackkit.env` (root, mode 600) with `FK_PUBLIC_URL`, the unit from the tarball, `feedbackkit-admin` linked into `/usr/local/bin`. **No `ADMIN_TOKEN` was set.** The browser was Chrome 157 with a virtual authenticator on the operator's Mac, reaching the server through `ssh -L 18787:<lxc>:8787`, with `FK_PUBLIC_URL=http://localhost:18787` (passkeys need localhost or https). The container was destroyed afterwards.

| Step | Result |
|---|---|
| Service started without `ADMIN_TOKEN` | `active`; the journal says `No owner exists yet. Create the first owner with: feedbackkit-admin setup-link`; `/diag` schema 5, capability 4, and its next step is `sudo feedbackkit-admin setup-link` |
| `/api/auth/state`, admin API without credentials | `ownerExists: false`; `401` |
| `feedbackkit-admin setup-link`, run as root | exit 0, the link alone on stdout, not on stderr. The data files stay `feedbackkit:feedbackkit`, mode 600 (the command read the root-only environment file, then continued as the service user) |
| Enroll the first owner in Chrome | `201`, account `Robin`, role `owner`; cookie `fk_session`, `HttpOnly`, `SameSite=Lax`, `Path=/`, 30 days (no `Secure` on `http://localhost`) |
| A second `setup-link` | exit 1, `An owner already exists. Use the recovery link instead.` |
| Create a project with the session | `201` |
| Create a scoped token (write, project `drill`, 7 days) | `201`, the token shown once |
| That token from outside the browser | project list `200` with only `drill`; system page `403`; create a token `403`; after revoking it `401 FK_TOKEN_REVOKED` |
| Service restart | the session still answers `200`; sign-out, then sign-in with the passkey and no username: `200` |
| `ADMIN_TOKEN` added to the environment file, service restarted | the journal says `ADMIN_TOKEN is set but ignored: this instance has an owner`; the legacy token gets `401 FK_ADMIN_TOKEN_RETIRED`. Removed again |
| Recovery drill: clear the credentials of the authenticator (a lost device) | sign-in fails (no credential). `feedbackkit-admin recovery-link` prints a link; enrolling with it: `201`, purpose `recovery`, one passkey, a different credential ID; the same link again: `410`; sign-in with the new passkey: `200` |
| `feedbackkit-admin accounts` | `Robin owner active 1 passkey` |
| Journal after the whole run | 0 token-shaped strings; 0 files in the data directory not owned by the service user |
| `systemd-analyze security feedbackkit` | 3.7 OK (as before) |
| Reboot of the container | the service starts by itself; `ownerExists: true` |

## What this does not cover

- `feedbackkit-update` ran only in the automated tests, against a fake GitHub API and a model of the older release (the same bundle with schema 4 and capability 3, no migration 0005). Not in the LXC, and not between two real signed releases.
- `pnpm admin:link` ran against a stand-in for wrangler, never against a real Cloudflare account or a deployed D1. The D1 design was exercised on the local D1 of workerd (Miniflare), not on Cloudflare's service.
- Browsers: Chrome only. Safari, Firefox, a hardware security key and a phone passkey were not run. The `__Host-` cookie over https was tested at the header level, not in a browser.
- This run had no screens: the ceremonies were driven by calling the API from the page with `navigator.credentials`. The screens came after, and their run is in [2026-11-11-gate2-ui.md](2026-11-11-gate2-ui.md).
- A cloud VPS was not tested (the owner's decision, as before).

Co-created by Michel with NORA (AI Agent)
