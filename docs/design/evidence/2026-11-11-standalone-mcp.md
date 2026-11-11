# MCP plumbing on the standalone server, 2026-11-11

What was run: the OAuth provider and the MCP server of ADR-015 on the standalone Node server, with the provider's storage in the SQLite file and an identity seam at `/oauth/authorize`. The standalone server has no sign-in to give the seam yet (accounts are Gate 2), so MCP is off by default and nobody can approve a connection. Node tests through the real `@cloudflare/workers-oauth-provider` and the real MCP handler with a stub identity that exists in test code only, a shared suite on workerd and on Node, the MCP SDK's own client against the bundled application, and the unpacked release tarball on a clean Debian 13 LXC. Based on `0dc8000`, with `main` merged in (`ccc8456`).

An earlier version of this branch (`d70af20`) asked for the `ADMIN_TOKEN` in the consent form. The owner decided that MCP on the standalone server comes with accounts, and that version was removed. A run of it on an LXC is kept at the end, for the facts that do not depend on the identity step.

## What the code checks first

| Question | Answer |
|---|---|
| Does the provider run on Node? | Yes, with a stand-in for the workerd module `cloudflare:workers` (an empty `WorkerEntrypoint` class, an esbuild alias) and a KV adapter. It reads `Cloudflare.compatibilityFlags` and finds none, so Client ID Metadata Documents turn themselves off |
| Does `createMcpHandler` of `agents` run on Node? | Yes. Its stateless handler imports only `node:async_hooks` and the MCP SDK's web-standard transport. The bundle contains 12.7 kB of `agents` |
| What does the provider use from KV? | `get` (text and json), `put` with `expirationTtl` and `metadata`, `delete`, `list` with prefix, limit and cursor. The adapter implements exactly these, with KV's limits (key 512 bytes, metadata 1024 bytes, TTL at least 60 s) |
| Does the provider write per-request state onto the context? | Yes (`ctx.props`). The server hands the provider a fresh context for every request. With the mutation "share the context" the provider's call sequence still read the right props, so the context test checks the object instead of the outcome |
| Where could Node differ from workerd in a way that hurts? | A client id that is a URL makes the provider fetch it. workerd refuses private addresses for that fetch with `global_fetch_strictly_public`, Node has no such flag. The server turns the feature off (`clientIdMetadataDocumentEnabled: false`) |

## Tests

| Suite | Runs | Result |
|---|---|---|
| `test/server-oauth.test.mjs`: the real provider and MCP handler on Node with the stub identity. The server's own identity is nobody whatever the request carries, and nothing is stored without a sign-in. Registration and its limit, no outbound fetch for a URL client id, the consent page, a wrong redirect URI, unknown client, missing PKCE, a wrong resource, Allow, Allow without a sign-in, Cancel, replayed and foreign handles, a cross-origin form, PKCE success and failure, exchange, resource mismatch, refresh, revoke, expiry of access token, refresh token and grant, a restart on the same database, tools per scope, a read call, a refused call, `whoami`, concurrency, the context, the per-grant rate limit, and that the stub is not in the built server | 28 | pass |
| `test/server-kv.test.mjs`: the KV adapter on SQLite (expiry, sweep, paging, literal prefixes, limits, a restart, an older release) | 10 | pass |
| `test/server-mcp-e2e.test.mjs`: the MCP SDK client does discovery, registration, consent, tools and a refused call against the bundled app (stub identity). The unpacked release tarball with Node alone: MCP off by default with the reason in the start log and `/diag`, `FK_MCP=on` serves the plumbing and refuses every consent request whatever the request carries, a hostile `Host` header moves nothing, unsafe combinations stop the start, the start sweep removes expired rows, the `planMcp` table | 6 | pass |
| `test/consent-identity.test.ts`: the seam. The binding decides and never falls back to Access (with a real signed Access JWT on the request), the wording per runtime, `/diag` carries `mcp` only where the server sets it | 5 | pass |
| `test/durable/kv-contract.test.ts`: the same KV calls on Cloudflare KV (workerd) and on the adapter | 7 on each runtime | pass on both |
| `test/durable/mcp-oauth-flow.test.ts`: the OAuth protocol and the tools with a stand-in sign-in, on workerd with Cloudflare KV and D1 and on Node with SQLite | 13 on each runtime | pass on both |
| Existing suites, unchanged: `vitest run` 386 (the Worker's `test/mcp-oauth.test.ts` and `test/mcp-tools.test.ts` among them), workers 62, conformance 62, `test:server` 104 | | pass |

`pnpm typecheck` passes. `pnpm check:bundle`: widget 22.8 kB gz of 23.0, admin 15.2 kB gz of 15.3, both unchanged.

The workers config gained the compatibility flag `global_fetch_strictly_public` (the production template has it) because without it the provider's start-up warning writes to a stream in the test pool and the module cannot be imported there.

## Negative controls

Each change was made to the source, the server rebuilt, the named suite run, and the change undone. "Killed" means a test failed.

| Change | Result |
|---|---|
| The server's consent identity is somebody | killed (unit and tarball) |
| The stub's header appears in the built server | killed |
| `createMcpFetch` ignores the identity it is given | killed |
| The provider gets the shared request context | killed |
| The origin pin removed | killed |
| The registration limit removed | killed |
| Client ID Metadata Documents on | killed |
| The seam ignores the binding | killed |
| The seam falls back to Access when the binding says nobody | survived first (the test's Access header was not a valid JWT), killed after the test used a signed one |
| The Access wording is shown where accounts are missing | killed |
| Expired rows are still read | killed |
| The storage shim does not create `_fk_kv` | killed |
| MCP on by default | killed |
| The http-origin guard removed | killed |
| The listen-address guard removed | killed |
| `/diag` without the `mcp` line (server and seam test) | killed |
| The KV adapter not bound to the app | killed |
| The start sweep skips the KV table | killed |

## Bundle

| | v0.2.0 (signed, GitHub) | This branch |
|---|---|---|
| Tarball | 196,145 bytes | 443,998 bytes |
| `server.mjs` | | 1,713,537 bytes, one file, Node only, no `node_modules`. The test limit of 2,000,000 holds |

The growth is the MCP SDK (650 kB), its schema library (330 kB) and the provider (230 kB).

## Clean Debian 13 LXC, final code

Unprivileged Debian 13 LXC on a Proxmox VE 9.2 host (VMID 520), `nesting=0`, 2 cores, 2 GB RAM, 8 GB disk. Node.js v24.22.2 from the nodejs.org tarball with its checksum verified, no Git, no pnpm, no `node_modules`. The release tarball was built from this branch (`0.2.1-dev.2`, unsigned, so the signature steps of the install were not part of this run) and unpacked with the steps of `docs/SELF_HOSTING.md`. The container was destroyed afterwards.

| Step | Result |
|---|---|
| Start with the default environment | `MCP off (approving a connection needs accounts, which are not built yet)` in the journal |
| `/diag` | `mcp` carries the same line |
| `POST /mcp`, `GET /oauth/authorize`, `POST /oauth/register`, `GET /.well-known/oauth-authorization-server` | 404 each |
| `FK_MCP=on` with `FK_PUBLIC_URL=http://localhost:8787` | start line `MCP on, but no connection can be approved yet: accounts are not built (issuer …, resource …/mcp)`, `/diag` the same |
| `/mcp` without a token, metadata, registration | 401, 200 with the issuer from `FK_PUBLIC_URL` also for a hostile `Host` header, 201 |
| `/oauth/authorize` with no identity, and with a bearer admin token, the stub's header and an Access header | 403 each, the page says connecting apps is not available yet, no cookie, no handle |
| `FK_MCP=on` with `HOST=0.0.0.0` and an http address | the service does not start and says why (`… HOST=0.0.0.0 listens on other addresses, where a sign-in would cross the network in clear text …`) |
| The database | `_fk_kv` exists beside `_fk_objects` and holds the one registered client. The admin token and its base64 are not in it. Data directory mode 700, database mode 600 |
| Rollback to the released, signed 0.2.0 on the same data (a copy of the data directory was taken first) | signature `Good` against the stable key, checksum OK, started on the database with the `_fk_kv` table, `/diag` 0.2.0, `/mcp` 404 |
| Forward to the new build again | active, `mcp` line as before, the client row is still there |
| Reboot of the container | the service starts by itself and `/diag` shows the line |
| `systemd-analyze security` | 3.7 OK |

## Earlier run of the removed identity step (`d70af20`)

The same LXC setup with Caddy 2.6.2 terminating https for `feedback.lxc.test` (internal CA), `FK_TRUSTED_PROXY_HOPS=1`, and the MCP SDK client bundled into one file. At that commit the consent form asked for the `ADMIN_TOKEN`, and MCP was on for an https `FK_PUBLIC_URL`. That code is not in this branch. What carries over, because it does not depend on who signs in:

| Step | Result |
|---|---|
| The SDK client: 401, discovery, registration, consent, tools | every step worked over https. `list_projects`, `list_feedback` and `whoami` returned the data, `get_config` outside the scope was refused |
| A restart of the service and a reboot of the container | the saved grant still listed the tools and the project |
| The database | `_fk_kv` held one client, one grant, one token and one open transaction. No secret in plaintext |
| Rollback to the released 0.2.0 on the data that held the grant, then forward again | 0.2.0 started on the database, `/mcp` 404, and the grant worked again on the new build |
| Cookies | the `__Host-` cookie carried `Secure` behind https, and the page sent `Referrer-Policy: same-origin` |

The rows that tested the token field (a wrong token, the lockout shared with the admin API, the consent page in a browser) belong to the removed step and are not claimed here.

## What this does not cover

- A full OAuth flow on the LXC with the final code. It cannot run there: the production build has no identity to approve a connection, and the stub exists only in test code. The flow ran in tests with the stub, and on the LXC with the removed step (above).
- A real MCP client product: Claude Code, claude.ai, ChatGPT and Hermes. Nothing can approve them on a standalone server yet.
- A grant through the server process of this branch. `FK_MCP=on` was run on the LXC and in the tarball test, but only up to the refused consent page. The grant, token and tool calls ran in tests through the same code with the stub.
- A browser on the consent page of this branch. The page is the Worker's; the Worker's own spec is `e2e/oauth-consent.spec.ts`.
- `feedbackkit-update` with this change. No signed release of it exists. The rollback above was done by hand with the released 0.2.0 tarball.
- Expiry on workerd (its clock cannot be moved). The adapter's expiry is tested on SQLite only.
- A cloud VPS, a public address, a real GitHub delivery, and Node 26 for the new tests (CI runs both).
- `/verify` of gstack could not run the node:test files (`.gstack/pregate.json` does not exist in the repository); the repository's own commands ran instead.

Co-created by Michel with NORA (AI Agent)
