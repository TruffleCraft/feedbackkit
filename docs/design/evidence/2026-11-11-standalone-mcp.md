# MCP and OAuth on the standalone server, 2026-11-11

What was run: the OAuth provider and the MCP server of ADR-015 on the standalone Node server, with the provider's storage in the SQLite file and consent through the admin token (amendment of ADR-015). Node tests through the real `@cloudflare/workers-oauth-provider` and the real MCP handler, a shared suite on workerd and on Node, the MCP SDK's own client against the unpacked release tarball, and the same client on a clean Debian 13 LXC behind https. Head of the branch `claude/standalone-mcp-oauth-b87ba9`, based on `0dc8000`.

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
| `test/server-oauth.test.mjs`: the real provider and MCP handler on Node. Registration and its limit, no outbound fetch for a URL client id, the consent page, a wrong redirect URI, unknown client, missing PKCE, a wrong resource, Allow, a wrong token, Cancel, replayed and foreign handles, a cross-origin form, the lockout (and its sharing with the admin API), the consent page limit, the token appearing nowhere, PKCE success and failure, exchange, resource mismatch, refresh, revoke, expiry of access token, refresh token and grant, tools per scope, a read call, a refused call, `whoami`, concurrency, the context, the per-grant rate limit | 28 | pass |
| `test/server-kv.test.mjs`: the KV adapter on SQLite (expiry, sweep, paging, literal prefixes, limits, a restart, an older release) | 10 | pass |
| `test/server-mcp-e2e.test.mjs`: the unpacked release tarball with Node alone. The MCP SDK client does discovery, registration, consent, tools and a refused call. The grant survives a restart. An https `FK_PUBLIC_URL` turns MCP on and a hostile `Host` header moves nothing. `FK_MCP=off` and an http address leave 404. Unsafe combinations stop the start. The start sweep removes expired rows. The `planMcp` table | 7 | pass |
| `test/durable/kv-contract.test.ts`: the same KV calls on Cloudflare KV (workerd) and on the adapter | 7 on each runtime | pass on both |
| `test/durable/mcp-oauth-flow.test.ts`: the OAuth protocol and the tools with a stand-in sign-in step, on workerd with Cloudflare KV and D1 and on Node with SQLite | 13 on each runtime | pass on both |
| Existing suites, unchanged: `vitest run` 381, workers 62 (42 before), conformance 62 (42 before), `test:server` 91 (all test files of `test/server-*.test.mjs`) | | pass |

`pnpm typecheck` passes. `pnpm check:bundle`: widget 22.8 kB gz of 23.0, admin 15.2 kB gz of 15.3, both unchanged.

The workers config gained the compatibility flag `global_fetch_strictly_public` (the production template has it) because without it the provider's start-up warning writes to a stream in the test pool and the module cannot be imported there.

## Negative controls

Each change was made to the source, the server rebuilt, the named suite run, and the change undone. "Killed" means a test failed.

| Change | Result |
|---|---|
| The admin token is not checked | killed (wrong-token and lockout cases) |
| The lockout verdict is ignored | killed |
| The provider gets the shared request context | killed (context test) |
| Expired rows are still read | killed (`test/server-kv.test.mjs`) |
| `list` ignores expiry | killed |
| Client ID Metadata Documents on | killed (a URL client id) |
| The same-origin check removed | killed |
| The origin pin removed | killed |
| The registration limit removed | killed |
| The consent page limit removed | killed |
| The grant gets both scopes whatever was asked | killed (three cases) |
| The token is logged | killed |
| The listen-address guard removed | killed |
| The http-origin guard removed | killed |
| MCP on by default for an http address | killed |
| The KV adapter not bound to the app | killed (every SDK client case) |
| The start sweep skips the KV table | killed |
| The admin token copied into the grant props | survived. The props are encrypted by the provider and `principalOf` drops fields it does not know, so nothing can observe the copy. Not a useful mutation |

## Bundle

| | v0.2.0 (signed, GitHub) | This branch |
|---|---|---|
| Tarball | 196,145 bytes | 435,251 bytes |
| `server.mjs` | | 1,714,091 bytes, 359,267 bytes gzipped, one file, Node only, no `node_modules`. The test limit of 2,000,000 holds |

The growth is the MCP SDK (650 kB), its schema library (330 kB) and the provider (230 kB).

## Clean Debian 13 LXC

Unprivileged Debian 13 LXC on a Proxmox VE 9.2 host (VMID 520), `nesting=0`, 2 cores, 2 GB RAM, 8 GB disk. Node.js v24.22.2 from the nodejs.org tarball with its checksum verified, no Git, no pnpm, no `node_modules`. Caddy 2.6.2 from the Debian package terminated https for `feedback.lxc.test` with its internal CA (`/etc/hosts` points the name at the container), `FK_TRUSTED_PROXY_HOPS=1`. The release tarball was built from this branch (`0.2.1-dev.1`, unsigned, so the signature steps of the install were not part of this run) and unpacked with the steps of `docs/SELF_HOSTING.md`. The client was the MCP SDK's, bundled into one file and run with Node alone, playing the browser for the consent page. The container was destroyed afterwards.

| Step | Result |
|---|---|
| Start with no `FK_MCP` and `FK_PUBLIC_URL=https://feedback.lxc.test` | `MCP on (issuer https://feedback.lxc.test, resource https://feedback.lxc.test/mcp)`, no warning in the journal |
| Metadata through https | issuer `https://feedback.lxc.test`, registration endpoint present, `client_id_metadata_document_supported` false, scopes `feedback:read` and `config:read` |
| Client: 401, discovery, registration | challenged and registered |
| Consent page | 200, password field, `__Host-` cookie with `Secure`, `Referrer-Policy: same-origin`, the admin token not in the page |
| A wrong admin token | 403 |
| The right admin token | 302 with code and `iss=https://feedback.lxc.test` |
| `tools/list` for `feedback:read` | `fetch`, `get_feedback`, `get_funnel`, `list_feedback`, `list_projects`, `search`, `search_feedback`, `whoami` |
| `list_projects`, `list_feedback`, `whoami` | the project, one report, identity `admin` with the right scope and gateway |
| `get_config` outside the scope | refused (`Tool get_config not found`) |
| Restart of the service | the saved grant lists the tools and the project |
| The database | `_fk_kv` holds one client, one grant, one token and one open transaction. The admin token and its base64 are not in the table. Data directory mode 700, database mode 600 |
| Rollback to the released, signed 0.2.0 on the same data | signature `Good` against the stable key, checksum OK, started on the database with the OAuth rows, `/diag` 0.2.0, `/mcp` 404. A copy of the data directory was taken first |
| Forward to the new build again | the grant from before works |
| Reboot of the container | both services start by themselves, the grant works |
| 21 wrong tokens at the consent form from one client address behind the proxy | 403 up to the 20th failure counted for that address (one had been used earlier), then 429 |
| The right token after that | 429 |
| The admin API with the right token from the same address | 429 (the same counter) |
| `systemd-analyze security` | 3.7 OK |
| The admin token in the journal | not found |

## Consent page in a real browser

The standalone server from the checkout (`FK_MCP=on`, `FK_PUBLIC_URL=http://127.0.0.1:8798`, a fictional admin token) and the Chromium-based browser pane of the desktop app. The client's redirect URI was `http://127.0.0.1:9/callback`, where nothing listens, so the final page is the browser's error page and its address shows the result.

| Step | Result |
|---|---|
| Open the authorization URL | the page renders: app name, two scope lines, the redirect host, the warning for a loopback redirect, the token field and the gateway address under it (`http://127.0.0.1:8798`), Allow and Cancel |
| Allow with the field empty | the browser stops the submit (required field), the page stays |
| Cancel with the field empty | the browser submits (`formnovalidate`), the address becomes `…/callback?error=access_denied&error_description=The+user+declined&state=abc&iss=http://127.0.0.1:8798` |
| A new authorization URL, a wrong token, Enter | the form is posted with the browser's own `Origin`, passes the same-origin check, and the page says "That is not the admin token", status 403 |
| Back, then the right token, Allow | the address becomes `…/callback?code=…&state=abc&iss=http://127.0.0.1:8798` |

## What this does not cover

- A real MCP client product: Claude Code, claude.ai, ChatGPT and Hermes were not run against it. They need a public https address. The steps for a manual check are in the pull request.
- A browser test in CI. The consent page was clicked once by hand in the Chromium of the desktop app's browser pane (see the next section), but no Playwright spec covers the standalone page. `e2e/oauth-consent.spec.ts` covers the page headers' effect on the Worker's page only.
- `feedbackkit-update` with this change. No signed release of it exists. The rollback above was done by hand with the released 0.2.0 tarball.
- Expiry on workerd (its clock cannot be moved). The adapter's expiry is tested on SQLite only.
- The documented command that ends every connection ran against a copy of the table, not on a live server.
- A cloud VPS, a public address, a real GitHub delivery, and Node 26 for the new tests (CI runs both).
- `/verify` of gstack could not run the node:test files (`.gstack/pregate.json` does not exist in the repository); the repository's own commands ran instead.

Co-created by Michel with NORA (AI Agent)
