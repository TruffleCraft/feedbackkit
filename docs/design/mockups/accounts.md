# Accounts, sign-in and API tokens (Gate 2)

Status: waiting for approval. Gate 2 replaces `ADMIN_TOKEN` with accounts (S11, S12, S14, S15 in [scope.md](../scope.md), flows in the [Gate 2 diagrams](../diagrams/gate2-bootstrap-sequence.html)). Open [accounts.html](accounts.html) in a browser. It shows every screen and state on desktop and on a phone, with a light and a dark switch. The dialogs, the menu and the copy buttons in the frames work, so click through them. All data is invented.

PNG contact sheets, one per section and theme. Names follow `accounts-<section>-<light|dark>.png`, and each sheet holds the desktop and the phone frames of that section:

| Choice | Sheets |
|---|---|
| Account area | `accounts-nav-a-*`, `accounts-nav-b-*`, `accounts-nav-c-*` |
| Sign-in recovery | `accounts-signin-a-*`, `accounts-signin-b-*`, and the states in `accounts-signin-states-*` |
| Setup, invitation, recovery | `accounts-setup-*` and `accounts-setup-states-*` |
| Your account, Accounts | `accounts-account-*`, `accounts-accounts-*` (drawn in variant C) |
| New API token | `accounts-tokens-a-*`, `accounts-tokens-b-*` |

## What exists today

- The admin pages are static shells that the Worker and the standalone server render from `src/worker/admin/pages.ts`. The header holds the brand, the Projects and System tabs, an identity (`who`, the Access email), Sign out and the theme button. The mock copies the real stylesheet and sprite from that file and adds only the rules listed below.
- Sign-in is one card that asks for the admin token, with a hint about Cloudflare Access underneath. `/api/admin/me` answers `via: "access"` or `via: "token"`.
- The admin script is 15,520 bytes gzipped against a budget of 15,616 (ADR-014), measured with the esbuild settings of `scripts/build-widget.mjs`. 96 bytes are left.
- Existing patterns the mock reuses: `dialog` (New project), the Settings layout with a side navigation, `.tabs`, the `.hrow` card rows of the inbox, `.badge`, `.t` tags, `.term` blocks, `.note`, `.help.err`, `.chips`.

## Screens

| Route | Who | What |
|---|---|---|
| `/admin/sign-in` | everyone | One button, sign in with a passkey. Recovery commands. The state of an instance without an owner |
| `/admin/setup#token` | link holder | Create a passkey for the first owner, an invitation or a recovery |
| `/admin/account` | every account | Passkeys (add, remove) and sessions (revoke, sign out) |
| `/admin/accounts` | owners | List, invite, new link, change role, remove |
| `/admin/tokens` | owners | List, create, show once, revoke |

A member who opens `/admin/accounts` or `/admin/tokens` sees a short page saying that only owners can manage them. The mock draws it.

## References

What I read, and what the mock takes from it.

- Passkey management, [web.dev](https://web.dev/articles/passkey-management): show the name, created and last-used dates and whether a passkey syncs, offer more than one passkey, warn before the last one is removed, put creation on the management page. Adopted all four. Provider logos, rename and the Signal API are left out: logos would be invented graphics, and the Signal API is a server-side extra the backend phase can add.
- Passkey interface, [Google](https://developers.google.com/identity/passkeys/ux/user-interface-design): wants a short explanation before creation and the canonical passkey icon on the sign-in button. The explanation is in the setup card. The icon is left out, because the admin has no icon of its own for it and a text button is enough. The page says nothing about error wording or naming.
- [GitHub passkeys](https://docs.github.com/en/authentication/authenticating-with-a-passkey/managing-your-passkeys): a list with a Synced label, Add a passkey, delete behind a confirmation. Adopted. The label becomes a Synced or Device-bound tag.
- [GitHub sessions](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/viewing-and-managing-your-sessions): a list of sessions with Revoke on each. Adopted, with a Sign out on the current one.
- [GitHub fine-grained tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens): name, expiration, repository access and permissions, with a default of 30 days. Adopted: name, access, projects, expiry. GitHub allows tokens that never expire. The mock does not.
- [Gitea tokens](https://docs.gitea.com/development/api-usage): scopes of read or write, and a token that appears once and cannot be viewed again. Adopted.
- [Tailscale auth keys](https://tailscale.com/kb/1085/auth-keys): an expiry of 1 to 90 days, and a warning that reusable keys are dangerous if stolen. Adopted as a short, bounded lifetime. The mock offers 30, 90 and 365 days, default 90.
- [Vaultwarden users page](https://github.com/dani-garcia/vaultwarden/blob/main/src/static/templates/admin/users.hbs): an Invited badge and a Resend invite action for pending users. Adopted as the Invited state and the New link action.
- [GOV.UK error messages](https://design-system.service.gov.uk/components/error-message/): say what went wrong and how to fix it, plain words, no "invalid", "please", "sorry" or "oops". Every message below follows it. I found no GOV.UK wording for expired links, so those messages follow the same rules.

Passkey autofill (conditional UI) is not used. It needs a text field to attach to, and this sign-in has no username. A button starts the prompt, and the browser lists the passkeys of the site.

## Component check

The admin is plain DOM (ADR-014) and the account pages need a dialog, a menu, a disclosure, radio groups and a select. The browser has all of them:

- `<dialog>` with `showModal()` is Baseline widely available since March 2022. It makes the page behind it inert, closes on Escape and focuses the first focusable element ([MDN](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/dialog)). The confirmation dialogs set `autofocus` on Cancel, so Enter right after opening does not confirm. I checked this in Chrome: Cancel has focus in the remove and revoke dialogs, the name field in the invite dialog.
- The `popover` attribute (variant A only) is Baseline 2025, newly available. Chrome 114, Firefox 125 and Safari 17 ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Popover_API), version numbers from [browser-compat-data](https://github.com/mdn/browser-compat-data/blob/main/api/HTMLElement.json)). On iOS before 18.3 a tap outside does not close it.
- `<details>` for the folded recovery text, `<fieldset>` with radios, `<select>`, `<input readonly>` with `navigator.clipboard.writeText` (secure contexts, widely available since 2020, [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/writeText)).
- The WebAuthn JSON helpers `PublicKeyCredential.parseCreationOptionsFromJSON`, `parseRequestOptionsFromJSON` and `toJSON`: Chrome and Edge 129, Firefox 119, Safari 18.4 ([browser-compat-data](https://github.com/mdn/browser-compat-data/blob/main/api/PublicKeyCredential.json)). Baseline 2025, newly available ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/PublicKeyCredential/parseCreationOptionsFromJSON_static)). WebAuthn needs a secure context ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API)). The unsupported-browser message names these versions. Older browsers would need a conversion fallback of about 15 lines. It is not drawn.
- Web Awesome 3 ([docs](https://webawesome.com/docs/)) has `<wa-dialog>`, which wraps a native `<dialog>` and loads a JavaScript module ([docs](https://webawesome.com/docs/components/dialog/)). The admin loads no component runtime, so it is not used. I did not open Web Awesome's copy button or dropdown pages, because the native elements above cover both.

## Choices and variants

Three choices have a real alternative. Each variant is drawn in full. The rest of the screens follow from them.

### Where the account area lives

| Variant | Header | Sign out | New stylesheet rules |
|---|---|---|---|
| A. Account menu, separate pages | Your name is a button that opens a menu: Your account, Accounts and API tokens (owners), Sign out | In the menu | 9 rules, 1,172 bytes (512 gzipped) |
| B. Access tab, tabs inside | A third tab, Access, for owners. Accounts and API tokens are tabs inside it. The name links to Your account | In the header on desktop, on Your account on a phone | 5 rules, 575 bytes (330 gzipped) |
| C. Name link, side navigation | Unchanged, with the name as a link | In the header | 4 rules, 310 bytes (220 gzipped). The Settings layout is reused |

Header fit, measured in Chrome with the real header CSS: at 375 px variants A and C end 12 px inside the edge, which is the page gutter. At 320 px both still fit. Variant B with Sign out leaves the theme button 3 px from the edge at 375 px and 52 px past the edge at 320 px, so its phone frames move Sign out onto Your account.

Rules that all variants need (list rows, option groups, the copy box) are 23 rules, 1,597 bytes, 644 gzipped. They go into the shells of the account pages only. The existing admin pages do not load them.

### Sign-in recovery

| Variant | What shows | New stylesheet rules |
|---|---|---|
| A. Folded under Locked out? | A card with one action, and a row under it that opens the commands | 3 rules, 213 bytes (166 gzipped) |
| B. Commands always visible | The card holds the recovery commands | None |

### Showing a new token once

| Variant | Create | After Create |
|---|---|---|
| A. Dialog | A native dialog, like New project | The same dialog shows the token with Copy and a warning. Closing it is final |
| B. Inline | A card above the list | A banner with the token replaces the card, and stays until the next navigation |

## Recommendation

- Account area: C. The header keeps its shape, so nothing changes at 375 px or at 320 px. The Settings layout is already built and tested. Step 4 (project access) and Step 6 (linked identities) add one entry each.
- Sign-in: A. Most visits are a sign-in, and the commands are one click away. B is better only if operators lock themselves out often.
- New token: A. A dialog hands focus to the first field, makes the page inert and stays open until it is closed. In B a reload or a tab click loses the only copy of the token.

The cheapest build is C for the account area, A for sign-in and A for tokens. None of the three needs a script of its own beyond `auth.js`.

## Decisions drawn in the mock

- Rows, not tables, for accounts, tokens, passkeys and sessions. The existing `.tbl` scrolls sideways on a phone and would hide the actions. The rows use the card style of the inbox rows (`.hrow`).
- A passkey has a name, chosen once when it is created. Its row shows Synced or Device-bound, the created date and the last-used date. There is no rename. The last passkey of an account cannot be removed, and the page says why next to the disabled button.
- Revoking a session needs no confirmation, because signing in again undoes it. Removing a passkey, an account, an API token and changing a role do.
- The last owner cannot be demoted or removed. The buttons are disabled and a line under the row says why, because a tooltip does not work on a phone.
- An invitation and a recovery link are shown once, in a dialog, with a copy button. The server keeps only a hash, so the dialog says the link cannot be shown again.
- The link token sits after the `#`, so the server and proxy logs never receive it. `auth.js` reads it and removes it from the address bar with `history.replaceState`.
- API tokens: name, Read or Write, all projects or some, expiry of 30, 90 (default) or 365 days. No token without an expiry. A token never manages accounts or tokens, and the page says so.
- Recovery replaces the old passkeys, revokes the sessions of that account and revokes the API tokens it created (owner decision, 2026-11-11: recovery is also the path after a lost or exposed credential). The page says so before the passkey is created, and says how many tokens ended afterwards.
- A failed attempt never produces the word "locked". The throttle message says no account is locked and a valid passkey is never blocked.
- Examples come from the product's fictional set: Robin, Sam, Taylor, `example.org`.

## Build notes for the UI phase

- The account pages are static shells like the existing ones, with the same nonce CSP, served at the routes above. Their copy sits in the shell. `dist/auth.js` toggles `hidden` states and fills the lists with `textContent`. It loads only on these pages, so the admin script keeps its budget.
- The admin script needs one change: where it shows the token form today, it should go to `/admin/sign-in` once an owner exists. That is a few dozen bytes of the 96 left. If it does not fit, the shell can do the redirect.
- `auth.js` calls the browser's WebAuthn API directly, with `parseCreationOptionsFromJSON`, `parseRequestOptionsFromJSON` and `toJSON`. No browser library. A throw-away sketch of the logic of all five pages (sign-in, setup, passkeys and sessions, accounts, tokens, plus copy buttons and dialogs, with no error handling beyond choosing a message) builds to 5,217 bytes minified and 2,086 gzipped with the settings of `scripts/build-widget.mjs`. Real code needs error handling and tests, so expect more. It is not committed.
- The sign-in and setup cards show the insecure-context message when `window.isSecureContext` is false, and the unsupported message when the JSON helpers are missing. Both disable the button. The insecure message offers an SSH port forward, which gives `http://localhost:8787`.
- The 429 message takes its minutes from `Retry-After`, rounded up.
- The session and invitation lifetimes that appear in the frames (7 days for an invitation, expiry dates on tokens) are example data. The backend phase decides them, and the copy reads the real value from the server.
- The token prefix in the list (`fk_tok_3a9c…`) needs the backend to store the first characters of a token. If it does not, drop that line.
- The command names come from the brief: `feedbackkit-admin setup-link`, `feedbackkit-admin recovery-link` and `pnpm admin:link`. The exact flags of `pnpm admin:link` are the backend phase's call. `--recovery` is a placeholder.

## Accessibility and phone

- Every frame was measured in Chrome: 85 frames, none wider than its viewport (375 px for phones). The side padding is the existing 16 px. In the phone frames every button, link, tab, menu item, summary and form control is at least 44 px high, except the checkboxes and radios, which are 20 px and sit inside a 44 px label row. A first measurement found the name link and the Locked out? summary too small, and the rules above fix both.
- Focus order follows the document: header (brand, tabs, account, Sign out, theme), then the page. A modal dialog makes the page behind it inert, through the browser. Errors use `role="alert"`, waiting and notices use `role="status"`, and the waiting button has `aria-busy`. Radio groups sit in a `fieldset` with a `legend`. A disabled Remove points at its reason with `aria-describedby`. The current page has `aria-current="page"`. The popover button reports its expanded state through the browser.
- The admin stylesheet has no transitions or animations, and the account pages add none, so there is nothing to switch off for `prefers-reduced-motion`.
- Contrast, computed from the real tokens (WCAG 2.2, text 4.5:1, borders and focus rings 3:1). The tinted backgrounds are flattened over the card.

| Pair | Light | Dark |
|---|---|---|
| Body text on card | 17.40 | 16.26 |
| Secondary text on card | 7.73 | 6.37 |
| Help text on card | 4.83 | 4.80 |
| Help text on the page ground | 4.47, below 4.5 | 5.13 |
| Link text on card | 7.10 | 8.81 |
| Badge and active pill text | 6.12 | 7.30 |
| White on the primary button | 5.70 | 5.70 |
| Error text on card | 6.57 | 8.57 |
| Notice, danger on danger-soft | 5.65 | 6.69 |
| Terminal text on the terminal block | 13.72 | 14.87 |
| Selected option, body text on accent-soft | 14.98 | 13.47 |
| Focus ring on card | 5.70 | 2.85, below 3 |
| Input and button border on card | 1.48, below 3 | 1.79, below 3 |

Four cells fall short, in three pairs. All three are tokens of the existing admin, and the account pages inherit them: muted text on the page ground in light (the page subtitles), the focus ring in dark, and the input border in both themes. The mock does not change tokens. A follow-up could use `--ink-2` for subtitles, `--accent-text` for the focus ring in dark and a darker `--line-2` for form controls.

## Copy

The text the UI phase uses verbatim. The `accounts.html` frames use the same strings.

### Sign-in

| Element | Text |
|---|---|
| Heading | Sign in |
| Intro | Use a passkey saved on this device, in your password manager or on a security key. |
| Button | Sign in with a passkey |
| Button while waiting | Waiting for your passkey… |
| Help | Your device asks you to confirm with a fingerprint, your face, a PIN or a security key. |
| Recovery summary (A) | Locked out? Recover access on the server. |
| Recovery heading (B) | Locked out? |
| Recovery text | Anyone with access to the server can issue a recovery link. Run this on the server: |
| Command | `feedbackkit-admin recovery-link` |
| Recovery text, Cloudflare | On Cloudflare, run this from your checkout, signed in to your own Cloudflare account: |
| Command | `pnpm admin:link --recovery` |
| Recovery note | The link works once and replaces your old passkeys. |
| Cancelled | Sign-in was cancelled. Select Sign in with a passkey to try again. |
| No passkey found | No passkey for this site was found on this device. Try the device or password manager where you created it. If you lost it, recover access on the server. |
| Not accepted | This passkey was not accepted. Try another passkey, or recover access on the server. |
| Too many attempts | Too many failed attempts from your network. Try again in 12 minutes. No account is locked, and a valid passkey is never blocked. |
| Server did not answer | The server did not answer. Check that it is running, then try again. |
| Session ended | Your session ended. Sign in again. |
| Insecure context | Passkeys need a secure connection. Open this page over HTTPS, or at `http://localhost`. Operators can put a TLS proxy in front of the server, or forward the port with SSH and open `http://localhost:8787`: |
| Command | `ssh -L 8787:127.0.0.1:8787 user@server` |
| No passkey support | This browser cannot use passkeys. Update it, or switch to Chrome 129, Edge 129, Firefox 119 or Safari 18.4 or newer. |
| No owner yet, heading | Set up the first owner |
| No owner yet, text | This gateway has no accounts yet. Run this on the server, then open the link it prints: |
| Command | `feedbackkit-admin setup-link` |
| No owner yet, note | On Cloudflare, run `pnpm admin:link` from your checkout. The link works once and expires. |
| Token form heading | Sign in with the admin token |
| Token form text | Paste the admin token from the server environment. It stops working when the first owner exists. |

### Setup, invitation and recovery

| Element | Text |
|---|---|
| First owner, heading | Set up the first owner |
| First owner, text | You opened a setup link from the server. Choose your name and create a passkey. This account becomes the owner of this gateway. |
| Name label | Your name |
| Name help | Other accounts see this name. No email address is needed. |
| Invitation, heading | Join FeedbackKit |
| Invitation, text | Robin invited you as a member. Create a passkey to finish the account for Taylor. |
| Recovery, heading | Recover access |
| Recovery, text | Create a new passkey for Robin. |
| Recovery, warning | **Your old passkeys and sessions will be replaced.** Every browser signed in as Robin is signed out, and the API tokens you created are revoked. Create new ones afterwards. |
| Recovery, done | Passkey created. You are signed in as Robin, owner. 2 API tokens you created were revoked. Create new ones under API tokens. (The number comes from `tokensRevoked` in the answer; with none: nothing is shown.) |
| Button | Create passkey (recovery: Create new passkey) |
| Help | Your device asks you to confirm. The passkey stays with you. The server keeps only its public half. |
| Cancelled | Passkey creation was cancelled and nothing was saved. Select Create passkey to try again. |
| Could not save | The passkey could not be saved. Try again. The link keeps working until you finish or it expires. |
| Done, heading | Passkey created |
| Done, text | You are signed in as Robin, owner. |
| Done, note | Add a second passkey in Your account, so that losing this one does not lock you out. |
| Done, button | Open the admin |
| Link unusable, heading | This link no longer works |
| Link unusable, text | Setup, invitation and recovery links work once and expire. This one was used, has expired or is not valid. |
| Next step, setup | Run `feedbackkit-admin setup-link` on the server for a new link. |
| Next step, invitation | Ask an owner for a new invitation. |
| Next step, recovery | Run `feedbackkit-admin recovery-link` on the server for a new link. |
| Link unusable, button | Go to sign in |
| Owner exists, heading | This gateway already has an owner |
| Owner exists, text | Setup links only work before the first owner exists. Sign in with your passkey instead. |
| No link, heading | Open the setup link |
| No link, text | This page needs a one-time link from the server. Run this on the server and open the link it prints: |

### Your account

| Element | Text |
|---|---|
| Heading, subtitle | Your account, Robin · owner |
| Passkeys heading, button | Passkeys, Add a passkey |
| Passkeys help | Passkeys sign you in. Keep at least two, on different devices or on a security key. |
| Row | MacBook Air, Synced, Created 3 Nov 2026 · Last used today, Remove |
| One passkey, notice | You have one passkey. Add a second, for example on a security key, so that losing this one does not lock you out. |
| One passkey, reason | This is your only passkey, so it cannot be removed. Add another one first. |
| Add dialog | Add a passkey. Name. Helps you tell passkeys apart, for example Laptop or Security key. Your device asks you to confirm. Create passkey, Cancel |
| Remove dialog | Remove MacBook Air? You can no longer sign in with this passkey. Delete it from your password manager or device as well. Remove passkey, Cancel |
| Sessions heading, button | Sessions, Revoke all other sessions |
| Sessions help | A session is a browser where you are signed in. |
| Row, this browser | This browser, This session, Chrome on macOS · Signed in 10 Nov 2026 · Active now, Sign out |
| Row, other | Firefox on Linux, Signed in 4 Nov 2026 · Last active 8 Nov 2026, Revoke |

### Accounts

| Element | Text |
|---|---|
| Heading, subtitle, button | Accounts, 3 accounts · 2 owners, Invite someone |
| Filter | Show removed |
| Row | Robin (you), Owner, Active, 2 passkeys · Last seen just now, Make member, Remove |
| Invited row | Taylor, Member, Invited, No passkey yet · Invitation expires 18 Nov 2026, New link, Remove |
| Removed row | Morgan, Member, Removed, Removed 2 Nov 2026 · Signed out everywhere |
| Only owner | Robin is the only owner, so this account cannot be demoted or removed. Make another account an owner first. |
| Invite dialog | Invite someone. You send the invitation link yourself. The server sends nothing. Name. Other accounts see this name. No email address is needed. Role: Member (Can use the whole admin except accounts and API tokens. Project access arrives in a later release.) or Owner (Can also manage accounts and API tokens, and remove other owners.). Create invitation, Cancel |
| Link dialog | Invitation for Taylor. Send this link to Taylor. It works once and expires on 18 Nov 2026. Copy link. The server keeps no copy of this link, so it cannot be shown again. If it gets lost, create a new link. Done |
| New link dialog | New link for Taylor. Send this link to Taylor. It works once and expires on 18 Nov 2026. The earlier link stops working. |
| Remove dialog | Remove Taylor? Taylor is signed out everywhere and loses their passkeys. API tokens Taylor created stop working. Reports and settings stay as they are. Remove Taylor, Cancel |
| Role dialog | Make Sam a member? Sam can no longer manage accounts or API tokens. Sam stays signed in. Make member, Cancel |
| Member opens the page | Only owners can manage Accounts. You do not have access to this page. Ask an owner if you need something changed. |

### API tokens

| Element | Text |
|---|---|
| Heading, subtitle, button | API tokens, For scripts and agents. A token cannot manage accounts or tokens., Create token |
| Row | Setup agent, Write, All projects, Active, `fk_tok_3a9c…` · Created by Robin 4 Nov 2026 · Expires 2 Feb 2027 · Last used 3 days ago, Revoke |
| Other states | Revoked 5 Nov 2026. Expired 1 Nov 2026. |
| Empty | No API tokens yet. Create one when a script or an agent needs access. They use a token instead of the old admin token. |
| Create dialog | Create an API token. Name (What will use it, for example Setup agent.). Access: Read (Read reports, projects and settings.), Write (Everything Read can do, plus change settings and triage, retry or delete reports. Never accounts or tokens.). Projects: All projects, Only these projects (A token limited to some projects cannot create projects or open System.) with a checkbox per project. Expires: In 30 days, In 90 days, In 365 days (Create a new token before this one expires. An expired token is refused.). Create token, Cancel |
| Shown once | Copy your token. This is the only time you see it. Store it in your password manager or in the secret store of the script or agent. Copy token. If you lose it, create a new token and revoke this one. Done |
| Revoke dialog | Revoke Setup agent? Anything that uses this token is refused right away. This cannot be undone. Revoke token, Cancel |
| Member opens the page | Only owners can manage API tokens. You do not have access to this page. Ask an owner if you need something changed. |

### Header

| Element | Text |
|---|---|
| Account button or link | Robin |
| Menu (A) | Robin, Owner. Your account, Accounts, API tokens. Sign out |
| Side navigation (C) | Your account, Accounts, API tokens |
| Tabs (B) | Access with Accounts, API tokens |

## Decided

Answered by the owner on 2026-11-11 ("Ja, wie empfohlen"), relayed by the review session. The copy above follows them. Recorded as S23 in `scope.md` of the backend pull request.

- **Member access.** Until Step 4, a member can use the whole admin except accounts and tokens. The invitation dialog says so.
- **Token limits.** A token limited to some projects cannot create projects or open System. The create dialog says so.
- **Recovery and API tokens.** Recovery revokes the API tokens that account created, because recovery is also the path after a lost or exposed credential. The owner creates new tokens afterwards. The host command has `--keep-tokens` to opt out.

The variants were approved the same day: the account area as a name link with side navigation (C), recovery folded under "Locked out?" (A), a new API token in a dialog (A).

## What this does not cover

- No real WebAuthn run: the frames are static HTML and nothing calls the browser's passkey API. The UI phase tests it with a virtual authenticator.
- Chrome only. Safari and Firefox rendering was not checked, including the `:has()` selector that highlights the selected option.
- No screen reader was run. The semantics above come from the markup.
- The wording was checked against the style rules and by reading it aloud, not by a user.

Co-created by Michel with NORA (AI Agent)
