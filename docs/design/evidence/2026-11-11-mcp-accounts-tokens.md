# MCP with accounts and scoped tokens, 2026-11-11

What was run: the consent page of the OAuth provider wired to the account sessions of Gate 2, scoped API tokens as a bearer on `/mcp`, and MCP on by default for an https `FK_PUBLIC_URL`. Automated suites on workerd and on Node, the MCP SDK's own client against the bundled application, a real Chromium with a WebAuthn virtual authenticator against the real server process, and the release tarball on a clean Debian 13 LXC. Cut from `main` at `401502f` (the merge of the accounts change).

This replaces the statements in [`2026-11-11-standalone-mcp.md`](2026-11-11-standalone-mcp.md) that MCP is off by default and that nobody can approve a connection. The first three items of that file's "does not cover" list are covered here.

## What changed, in one place

| Question | Answer |
|---|---|
| Who may approve a connection | An active account with a session (`authenticateAccount`), on both runtimes. On the Worker, Cloudflare Access is still accepted first, and an account works there too, because the session helper is runtime-neutral. Any active account may approve, not only an owner |
| What identifies the grant | The account id (`userId`), with the name shown as the identity. A connection is checked against the account on every `/mcp` call, so removing the account ends it with `401` |
| API tokens on `/mcp` | `Authorization: Bearer fk_tok_…`, through the provider's `resolveExternalToken` hook. The token is looked up by its hash on every request, so a revoked, ended or orphaned token stops at once. Always read-only, whatever access the token has. A project-limited token sees only its projects in every tool |
| Limits for tokens | A failed token counts against the address (`recordAuthFailure`, 30 per hour, then `429` with `Retry-After`). A valid token has its own budget of 1000 calls an hour, keyed by the token id |
| MCP on the standalone server | On when `FK_PUBLIC_URL` is an https origin. `FK_MCP=off` turns it off, `FK_MCP=on` turns it on for a test on loopback. The start log and `/diag` say which |
| ADR | `DECISIONS.md`, ADR-015, second amendment of 2026-11-11 |

## Automated suites

| Suite | Result |
|---|---|
| `pnpm typecheck` | clean |
| `vitest run` (Node, fake D1) | 30 files, 397 tests, includes `test/consent-identity.test.ts` (7: no identity without Access, a session or a binding; the account behind a live session, with its id as `accountId`; a binding's answer taken as it is, nobody included; Access ahead of a session; the sign-in the page names; the MCP status line) |
| `vitest run -c vitest.workers.config.ts` (workerd, local D1) | 8 files, 148 tests |
| `vitest run -c vitest.conformance.config.ts` (the same files on SQLite) | 8 files, 148 tests |
| `test/durable/mcp-oauth-flow.test.ts` | 25 tests on each runtime, ten of them new: a valid token (read and write access), `whoami` for a token, revoked, ended and removed-account tokens, unknown and non-`fk_tok_` bearers, a token in the URL ignored, a project-limited token across all nine tools, the per-token limit, the failure throttle with a valid token still answering, no token in logs or counters, a grant ending with its account |
| `pnpm test:server` (Node server tests) | 130 tests; includes `server-mcp-accounts` (10 tests, real sessions and tokens in SQLite, the real consent page, the SDK client with a token bearer, an unpacked release process with a restart) and `server-mcp-e2e` (8) |
| `pnpm check:bundle` | pass |
| `pnpm exec playwright test e2e/accounts-real-server.spec.ts e2e/mcp-real-server.spec.ts` | 4 passed. Playwright's Chromium with a WebAuthn virtual authenticator against a real `scripts/server.mjs` process. `mcp-real-server.spec.ts` is new: a real passkey makes the owner, a real click on **Allow** ends the OAuth flow, a member made by invitation approves their own connection, a token created through the API reads and then stops when revoked, and removing the member ends the connection they approved |
| `pnpm materialize` with placeholder ids, then `wrangler deploy --dry-run` | the Worker bundles: 2208 KiB, 431 KiB gzipped (it was 2198 and 429 before). A bare `wrangler deploy --dry-run` without the materialized `wrangler.toml` fails to resolve `@simplewebauthn/server`; that is the missing config, not the change |

## Controls that show the tests can fail

Each change was made to the source one at a time, the suite run, and the source restored. "Killed" means a test failed.

| Change | Result |
|---|---|
| A revoked token is accepted | killed |
| An ended token is accepted | killed |
| A token of a removed account is accepted | killed |
| The project filter is off for tokens | killed |
| `search` ignores the token's projects | killed |
| A connection survives the removal of its account | killed |
| Failed tokens are not counted by the throttle | killed |
| Tokens are off in the provider | killed |
| The error for a bad token echoes the token | killed |
| The session is ignored at the consent page | killed |
| The grant is keyed by the account's name, not its id | killed |
| MCP is off for an https address by default | killed |
| The same active-account check turned off, run through the real browser spec | killed: the last step got `200` where `401` was expected |
| The per-token limit key reduced to one field (the email, then the client id) | equivalent: the other field still separates tokens, so no test can tell. Both fields constant together was killed |
| A bearer that does not start with `fk_tok_` is judged by the resolver | equivalent: the lookup guards the prefix itself |

## Drill on a clean Debian 13 LXC from the release tarball

Unprivileged Debian 13 LXC (VMID 532, destroyed afterwards), `nesting=0`, 2 cores, 2 GB RAM, 8 GB disk, on the operator's Proxmox VE host. Prepared by hand: `curl`, `ca-certificates`, `xz-utils`, `openssh-client`, `openssl`, `procps`, `sudo`, Caddy 2.6.2 from Debian, Node.js v24.22.2 from the nodejs.org tarball with its checksum verified, linked to `/usr/bin/node` for the unit. The tarball `0.3.0-dev.2` (613 kB, sha256 checked) was built from this branch and installed as in `docs/SELF_HOSTING.md`: user `feedbackkit`, `/opt/feedbackkit/releases/<version>` with `current`, `/etc/feedbackkit.env` (root, mode 600) holding `FK_PUBLIC_URL=https://fk.test` and `FK_TRUSTED_PROXY_HOPS=1`, the unit from the tarball, `feedbackkit-admin` linked into `/usr/local/bin`. No `ADMIN_TOKEN`, no `FK_MCP`. Caddy (`tls internal`) terminated https for `fk.test`.

The browser was Playwright's Chromium on the Mac with a virtual authenticator, reaching Caddy through `ssh -L 18443:<lxc>:443` and `--host-resolver-rules="MAP fk.test 127.0.0.1:18443"`, so the page saw `https://fk.test` and a real secure context (the internal CA is not trusted: `ignoreHTTPSErrors`). The calls an MCP client makes (`/mcp`) came from a Node client through the same tunnel with the gateway's `Host` and SNI and no `Origin` header, as Claude Code or LiteLLM would send them. The drill script is not in the repository. The container held no real data and was destroyed with its disk.

| Step | Result |
|---|---|
| Start with no `FK_MCP` | the journal says `MCP on (issuer https://fk.test, resource https://fk.test/mcp)`; `/diag` shows the same as `mcp`, schema 5, version `0.3.0-dev.2` |
| Discovery | `oauth-authorization-server` names the https issuer, `oauth-protected-resource/mcp` names `https://fk.test/mcp` |
| `/mcp` without a token | `401`, `WWW-Authenticate: Bearer realm="OAuth", resource_metadata="…/oauth-protected-resource/mcp"` |
| A made-up `fk_tok_…` bearer | `401`, the token not in the answer |
| Consent page without a session | `403`, "Sign-in required", the page names `https://fk.test/admin`, no **Allow** button |
| First owner through the host setup link and a passkey | `201`; cookie `__Host-fk_session`, `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/` |
| Owner approves a connection with a real click | the code is exchanged for a token; `tools/list` returns nine tools (`whoami`, `list_projects`, `list_feedback`, `get_feedback`, `search_feedback`, `get_funnel`, `get_config`, `search`, `fetch`); `whoami` names the owner |
| The same call from a page in the browser | `403`, "Invalid Origin: fk.test". The MCP SDK refuses browser origins; agents send none |
| Owner creates a scoped token (write, all projects, 7 days) | `201`; as a bearer `tools/list` answers `200`, `whoami` says `api-token`; the same token in the URL (`?access_token=`) and a call with no bearer get `401` |
| Owner invites a member, the member enrolls with a second passkey and approves their own connection | `201`, `200`, `whoami` names the member |
| `feedbackkit-admin accounts` | owner and member, one passkey each |
| Service restart | both OAuth connections, the token and the browser session still answer `200` |
| Reboot of the container | the service and Caddy start by themselves; the same four checks answer `200` |
| Revoke the token | `401` naming "revoked" from the next call; the OAuth connections stay `200` |
| Remove the member | the member's connection answers `401` "no longer active"; the owner's stays `200` |
| 40 failed `fk_tok_` bearers from one address | 12 answered `429`; the owner's OAuth connection still answered `200` |
| Journal after the whole run | 152 lines; the token, both access tokens and any `fk_tok_`/`fk_ses_` string absent |
| `FK_MCP=off` with https | the log says `MCP off (FK_MCP=off)`; `/mcp` and `/oauth/register` answer `404`; `/diag` shows `off (FK_MCP=off)` |
| `FK_PUBLIC_URL=http://fk.test` | the log says `MCP off (FK_PUBLIC_URL is not an https address; set it, or FK_MCP=on for a local test)`; `/mcp` `404`. The original file was restored and MCP came back on |
| `systemd-analyze security feedbackkit` | 3.7 OK (as before) |
| Files | 0 files in the data directory not owned by the service user; the database mode 600, the environment file root, mode 600 |
| OAuth table `_fk_kv` after the run | 3 clients, 2 grants, 2 access tokens |

A first run of the drill failed on its own mistakes and was repeated on a reset data directory: the script called `feedbackkit-admin` without `/usr/local/bin` in `PATH`, and it sent `/mcp` calls from a page, which the Origin check refuses (that refusal is now a step of the drill).

## What this does not cover

- A real MCP client product: Claude Code, claude.ai, ChatGPT, Hermes and LiteLLM. The tests use the MCP SDK's client and plain requests. For LiteLLM only its documentation was read (`docs.litellm.ai/docs/mcp`: `auth_type: bearer_token` with `auth_value` sends the token as a bearer), not a run.
- Admin screens. There is no sign-in page, account page or token form yet, so every session and token here came from the API, in a browser through `navigator.credentials`. There is also no list of OAuth connections in the admin; ending one means removing the account or waiting for the grant to run out.
- `feedbackkit-update` with a release that holds this change. No signed release of it exists, and the LXC was installed from a local dev tarball. The rollback was not rerun: after the accounts change a rollback to 0.2.0 stops at the capability check (covered by the earlier tests), which this change does not touch.
- A project-limited token and the 1000-calls-an-hour budget on the LXC. They ran in the shared suite and in `server-mcp-accounts`.
- A publicly trusted certificate. Caddy used its internal CA and the browser ignored the certificate error; the cookie and secure-context behavior is that of https.
- Browsers other than Chromium, a hardware key and a phone passkey.
- The Worker on Cloudflare. The shared suite ran on workerd with the local D1 and KV, and `wrangler deploy --dry-run` bundles the Worker, but nothing was deployed.
- Client ID Metadata Documents on a standalone server (still off: the provider's fetch cannot be kept away from private addresses on Node).
- A cloud VPS and a public address.
- `/verify` of gstack could not run the `node:test` files (`.gstack/pregate.json` does not exist in the repository); the repository's own commands ran instead.

Co-created by Michel with NORA (AI Agent)
