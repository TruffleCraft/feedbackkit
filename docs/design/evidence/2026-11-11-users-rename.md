# Rename Accounts to Users: evidence, 2026-11-11

After review the owner asked for the list of people with access to be called **Users**, not Accounts. What changed and what did not is in [../gate2-accounts.md](../gate2-accounts.md#the-screens). This page records what ran and what was seen. The Gate 2 screens run is [2026-11-11-gate2-ui.md](2026-11-11-gate2-ui.md); it keeps the old names, because it is the record of that day.

## Environment

Google Chrome 157.0.8103.50 driven by Playwright 1.61.1 with Chromium's WebAuthn virtual authenticator, against the real standalone server (`node scripts/server.mjs`) on a fresh data directory per test, Node v26.12.0. The names are made up (Robin, Taylor).

## Results

| Run | Result |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm exec vitest run` (unit) | 31 files, 411 tests passed |
| `pnpm exec vitest run -c vitest.workers.config.ts` (workerd) | 8 files, 149 tests passed |
| `pnpm exec vitest run -c vitest.conformance.config.ts` (SQLite and D1) | 8 files, 149 tests passed |
| `pnpm build:server && pnpm test:server` | 130 tests passed |
| `pnpm check:bundle` | widget 22.8 of 23.0 kB, auth 6.4 of 9.0 kB, admin 15.3 of 15.5 kB (gzipped), the same as before the rename |
| The whole e2e suite in Chrome (desktop and Pixel 5 projects) | 156 passed, 10 skipped (the Gate 2 and MCP real-server specs skip the phone project by design) |

The e2e suite ran with the installed Chrome through a local config, because the Playwright Chromium download is not installed on this machine; the repository's `playwright.config.ts` is unchanged.

## What was seen

- The navigation of the account area reads **Your account**, **Users**, **API tokens**. The Users page is at `/admin/users`, the heading and the page title say "Users", the subtitle "1 user · 1 owner" (and "2 users · 2 owners"), the button **Invite user**. The only owner's **Make member** and **Remove** are off and the page says "... so this user cannot be demoted or removed. Make another user an owner first."
- The invite dialog says "Invite user", "Other users see this name", and for the roles "Can use the whole admin except users and API tokens" (Member) and "Can also manage users and API tokens, and remove other owners" (Owner). An empty name gives "Enter a name of 1 to 64 characters."
- **Make owner** asks "Make Taylor an owner?" with "Taylor can manage users and API tokens, and remove other owners."
- A member who opens `/admin/users` sees "Only owners can manage Users", and on `/admin/tokens` the page says "A token cannot manage users or tokens."
- `GET /admin/accounts` answers `301` with `location: /admin/users` (read with `curl -sI` on a running server and asserted in `test/auth-pages.test.ts`). In Chrome, opening `/admin/accounts` while signed in ends on `/admin/users` with the heading "Users" (`e2e/accounts-ui.spec.ts`).
- `feedbackkit-admin users` lists the people. `accounts` prints the same output, and `recovery-link --account NAME` works like `--user NAME`; both old names are asserted in `test/server-accounts.test.mjs`, `test/server-admin-link.test.mjs` and `e2e/accounts-real-server.spec.ts`. The help text names `users` and `--user`. An unknown name answers `No active user named "..."`.
- Nothing in the five shells says "Accounts" any more (`test/auth-pages.test.ts`). **Your account** is unchanged, as is the name link in the header.

## What stayed

The API (`/api/admin/accounts`), the tables, the error codes (`FK_ACCOUNT_*`), the code names and the file names of the specs keep "account". A person's own identity and the credential keep it too: **Your account**, "This account was removed" (shown to the removed person), "An account can hold 100 active tokens".

## Screenshots

[users-only-owner](users-rename/users-only-owner.png), [users-make-owner](users-rename/users-make-owner.png), [tokens-member-denied](users-rename/tokens-member-denied.png) and [phone-users](users-rename/phone-users.png) (375 px, dark).

## Not run

Firefox and Safari, a real authenticator, and the screens against a Cloudflare Worker (`wrangler dev` or a deployed one). The Worker serves the same shells from the same `app.ts`, and `/admin/users` is not a file in `dist/`, so the assets binding passes it on to the Worker like `/admin/account`; that was read from `wrangler.template.toml` and not run.

Co-created by Michel with NORA (AI Agent)
