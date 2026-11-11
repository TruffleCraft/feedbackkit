# Gate 2: local accounts and recovery, as built

Status: backend built on both runtimes, UI not built (it waits for the approved mock, see [mockups/accounts.md](mockups/accounts.md)). The plan and the decisions S11, S12, S14, S15 and S18 are in [autonomous-admin-plan.md](autonomous-admin-plan.md) and [scope.md](scope.md). This page records what the pull request decided where the plan left room, and how the pieces fit. The threat model is in [SECURITY.md](../SECURITY.md#accounts-and-sessions).

## What exists

| Piece | Where |
|---|---|
| Schema, expand-only | `migrations/0005_accounts.sql`: `accounts`, `owner_claim`, `passkeys`, `sessions`, `setup_links`, `used_challenges`, `api_tokens`. `SCHEMA_VERSION` 5, `DELIVERY_CAPABILITY` 4 |
| Account modules | `src/worker/auth/`: `accounts` (roles, last-owner rule), `enroll` (the atomic batches), `links` (one-time links), `sessions` (cookies, CSRF, `authenticateAccount`), `tokens` (API tokens), `webauthn` and `challenge` (passkeys), `throttle`, `routes`, `host` |
| Auth gate | `src/worker/admin/auth.ts`: one `adminGate(c, scope)` for every admin route, with project scoping for tokens |
| Host command | `feedbackkit-admin` in the tarball (`scripts/feedbackkit-admin`, `scripts/server-admin.mjs`) |
| Cloudflare path | `pnpm admin:link` (`scripts/admin-link.mjs`) |
| Tests | `test/durable/accounts.test.ts` on workerd with D1 and on SQLite, `test/auth-gate.test.ts`, `test/server-accounts.test.mjs`, `test/server-admin-link.test.mjs`, `e2e/accounts-real-server.spec.ts` (real Chrome, virtual authenticator) |

## Decisions the plan left to this pull request

| Topic | Decision | Why |
|---|---|---|
| Command name | `feedbackkit-admin` with `setup-link`, `recovery-link` and `accounts`. On Cloudflare `pnpm admin:link` | It sits beside `feedbackkit-update` in the tarball and says what it is for. Links are the only thing it issues |
| Link lifetime | 30 minutes for the first owner and for recovery, 7 days for an invitation. `--minutes` takes 1 to 240 for the two host links | The first two are opened right after a command on the host. An invitation goes to a person who may read it tomorrow |
| Link shape | `<origin>/admin/setup#<token>`, 256 random bits, only the SHA-256 stored | The fragment never reaches a server log, a proxy log or a `Referer` header. Nothing secret travels in a query string |
| Session cookie | `__Host-fk_session` with `Secure` when `FK_PUBLIC_URL` is https, `fk_session` without `Secure` on http (localhost). `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`, `Max-Age` 30 days. The server also ends a session after 7 days without use | `Lax` and not `Strict`: the OAuth consent page is opened by an agent's client from another site, and with `Strict` it would show the person as signed out. CSRF is covered separately (below) |
| CSRF | Every state-changing request on a session needs `X-CSRF-Token` (HMAC of the session token, handed out by `/api/admin/me` and the sign-in answers) and a same-origin `Origin` or `Sec-Fetch-Site` | The token cannot be read cross-site, the origin check is a second layer |
| Passkey policy | Discoverable credential and user verification required, attestation `none`, ES256, EdDSA and RS256 only, RP ID and origin from `FK_PUBLIC_URL` (or the request URL the server builds from it) | No username field on sign-in. A key without its PIN is not enough. The algorithm list is the same on both runtimes, because the library adds a post-quantum algorithm where the runtime supports it |
| API token | `fk_tok_` plus 256 bits, shown once, SHA-256 at rest. Access `read` (GET only) or `write`, all projects or a list. 1 to 365 days, 90 by default, never unlimited. 100 active tokens per account | A leaked token ends by itself, and revoking works on the next request |
| Member role until Step 4 | A member can use every admin route an owner can except accounts and tokens | Authorization by project is Step 4. Until then the least surprising rule is the one the single admin credential had, minus the power to hand out access |
| Access identity | Accepted for the admin routes as before. It is not an account, so it cannot create tokens, manage accounts or use the account page | Cloudflare Access is edge authentication that the operator chose (S15). Tokens and accounts need a person who can be named and removed |
| Recovery scope | Replaces the passkeys of the account and signs out its sessions. API tokens stay | A lost device is the common case, and revoking running agents without a word would break them. The accounts page lists the tokens so an owner can revoke them |
| Who recovers an owner | Only the host command (or `pnpm admin:link`). An owner can renew an invitation or issue a recovery link for a member | A signed-in owner who could issue links for other owners would turn one stolen session into every account |

## The atomic owner claim

Requirement: two browsers that redeem the first-owner link at the same moment produce exactly one owner, on SQLite and on D1, and the loser leaves nothing behind.

### SQLite (the standalone server)

`DB.batch()` in `scripts/server-storage.mjs` runs its statements inside `BEGIN IMMEDIATE ... COMMIT` without an `await` in between and rolls back on the first error. It has the same contract as D1's `batch()`. The first-owner batch is in `completeBootstrap` (`src/worker/auth/enroll.ts`).

### D1 (Cloudflare)

D1 has no interactive transaction: a Worker cannot open one, read, decide and write. Its tools are single statements, which are atomic, and `batch()`, which runs a list of statements as one transaction and aborts the list on an error. The design uses only these, so nothing depends on holding a lock across a round trip:

1. **One arbiter row with a primary key.** `owner_claim (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), account_id, claimed_at)`. A second `INSERT` raises a constraint error. The batch is aborted and rolled back as a whole, so the loser's account, passkey and session never exist.
2. **A claim stamp for the link.** The first statement of the batch records the attempt's random stamp in `setup_links.used_by`, with a condition that the link is unused and unexpired. Only one attempt can make that `UPDATE` change a row. Every later statement of the batch contains `WHERE EXISTS (SELECT 1 FROM setup_links WHERE id = ? AND used_by = ?)`, so even if a batch were not rolled back, the statements of an attempt that did not win would insert nothing.
3. **Guarded inserts.** The owner claim, the account, the passkey and the session are each `INSERT ... SELECT ... WHERE EXISTS (...)` on the row the step before wrote. A step that finds nothing to build on changes zero rows. The caller reads `meta.changes` of the last statement to learn whether the attempt won.
4. **Replay.** The first statement of every ceremony inserts the challenge nonce into `used_challenges`. A second use fails on the primary key and aborts the batch.
5. **Deterministic account ID.** The new owner's ID is derived from the link's hash, so the passkey's user handle (chosen at "begin") and the account row (written at "finish") agree without any state in between. A second account for the same link would also collide on `accounts.id`.

Two arbiters (the `owner_claim` key and the account ID) agree on the outcome. The test `concurrent bootstrap yields exactly one owner` runs eight attempts at once on both runtimes. A negative control in the same file shows that a check-then-insert claim lets several owners through, and removing the arbiters from the batch makes the real test fail.

The same pattern covers the other races: the **last-owner rule** is a single `UPDATE` or `DELETE` whose condition counts the other active owners (two owners who demote each other at the same moment get one `200` and one `409`), the **last passkey** rule is a single `DELETE` with a count, and a **recovery or invitation link** is won by the stamp.

## Challenges without a table

A WebAuthn challenge is 56 bytes: 16 random bytes, the expiry (5 minutes) and an HMAC-SHA256 over nonce, expiry, purpose (`signin`, `setup`, `passkey-add`) and subject (the link, or the account), keyed with the instance secret. The library asks for `expectedChallenge` as a function for exactly this case. Handing a challenge out writes nothing, so a flood of begin requests cannot fill the database, and nobody's challenge can be evicted. Single use comes from `used_challenges` on success only.

The instance secret is a `meta` row (`instance_secret`, 256 random bits) created on first use with `ON CONFLICT DO NOTHING`. It also keys the hashed client addresses of the rate limiter, which used to depend on `ADMIN_TOKEN`. A challenge is never signed with a fallback key: when the store cannot give the secret, the ceremony answers 503.

## Failed attempts

Counters per client address (hashed) and per account, 30 and 10 per hour. **A valid credential is never refused because of a counter.** The code verifies first. Only a failed attempt is counted, and over the limit a failed attempt is answered `429` with `Retry-After` instead of `401`. Behind a proxy that hides client addresses all clients share one address, and the worst effect is that failures there read as `429`. The legacy `ADMIN_TOKEN` keeps its older rule (a locked address is refused even with the right token) until the first owner exists, because the existing suite pins it and because that token is chosen by a person, unlike a passkey signature or a 256-bit token.

## Upgrades and rollbacks

- Migration 0005 only adds tables. The previous release keeps working on the new schema, but it would honor `ADMIN_TOKEN` again once the first owner exists and cannot read sessions. `DELIVERY_CAPABILITY` 4 closes that on the standalone server: the server writes 4 on its first start, and a release that provides less refuses to start on that data ("This database needs delivery capability 4 and this release provides 3").
- `feedbackkit-update --rollback` restores the data copy from before the update, so a rollback after the first start of this release returns to the data as it was: accounts created since are gone with it. A manual downgrade without that copy is refused by the check above.
- On Cloudflare a Worker version rolled back with `wrangler rollback` has no such check. After the first owner exists, delete the `ADMIN_TOKEN` secret, so a rollback to an older version does not bring the shared token back.

## Not built

- The screens (first-owner setup, sign-in, passkey enrollment, accounts, tokens, recovery). They need the approved mock.
- OIDC, roles beyond owner and member, authorization by project for members (Step 4 and Step 6).
- Sign-in with a passkey on a plain http address that is not localhost. Browsers refuse WebAuthn there. Put TLS in front, or reach the server through `ssh -L` and `http://localhost`.

Co-created by Michel with NORA (AI Agent)
