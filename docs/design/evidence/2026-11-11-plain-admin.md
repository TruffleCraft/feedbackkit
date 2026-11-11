# Plain admin layout, evidence

Run on 2026-11-11 against the build of this branch, in Google Chrome 157 driven by Playwright. All data is invented. The design is variant B of [the mock](../mockups/admin-plain.md); the decision is in [ADR-014](../../DECISIONS.md).

## Checks

| Check | Result |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm test` | 411 passed (Node), 149 passed (workerd), 149 passed (conformance) |
| `pnpm test:server` | 130 passed |
| Playwright, all specs, both projects (1280 px desktop and Pixel 5) | 158 passed, 12 skipped by design (tests that only make sense at one viewport) |
| `pnpm check:bundle` | widget 22.8 of 23.0 kB, auth 6.7 of 9.0 kB, admin 16,725 bytes of 17,152 (budget raised from 15,872, see the PR) |

## Every changed button, clicked once

The Admin rows use the e2e fixtures with the API mocked per request. The Accounts rows run against the real standalone server with a virtual passkey. "Request" lists the API calls the click sent, "What appeared" is read from the page afterwards. A page that lists the projects also shows the sidebar's `GET /api/admin/projects`: the sidebar and the page share one answer.

| Area | Button or control | Request | What appeared |
|---|---|---|---|
| Admin, desktop 1280 px | Sign in with a wrong token | GET /api/admin/projects | That token didn't match. |
| Admin, desktop 1280 px | Sign in with the right token | GET /api/admin/projects | 3 projects listed, sidebar shows 3 projects |
| Admin, desktop 1280 px | New project | none | dialog open: true |
| Admin, desktop 1280 px | Create project with an invalid origin | none | Use an http(s) origin without credentials, a path, query or fragment. |
| Admin, desktop 1280 px | Cancel (new project) | none | dialog open: false |
| Admin, desktop 1280 px | Create project | POST /api/admin/projects<br>GET /api/admin/projects<br>GET /api/admin/projects/demo-site/config | opened /admin/projects/demo-site#setup |
| Admin, desktop 1280 px | Project row (harborline) | GET /api/admin/projects<br>GET /api/admin/projects/harborline/config<br>GET /api/admin/projects/harborline/feedback<br>GET /api/admin/projects/harborline/funnel?days=30 | Reports page, 7 reports, first one open in the pane |
| Admin, desktop 1280 px | Sidebar: Setup | none | panel-setup visible: true, address #setup |
| Admin, desktop 1280 px | Sidebar: Types | none | panel-types visible: true, address #types |
| Admin, desktop 1280 px | Sidebar: Settings | none | panel-config visible: true, address #config |
| Admin, desktop 1280 px | Sidebar: Reports | none | panel-history visible: true, address #history |
| Admin, desktop 1280 px | Filter: Issue failed | GET /api/admin/projects/harborline/feedback?outcome=issue_failed | 2 in the list |
| Admin, desktop 1280 px | Filter: Saved, no issue | GET /api/admin/projects/harborline/feedback?outcome=created | 1 in the list |
| Admin, desktop 1280 px | Filter: All reports | GET /api/admin/projects/harborline/feedback | 7 in the list |
| Admin, desktop 1280 px | Load 25 more | GET /api/admin/projects/harborline/feedback?cursor=… | 9 in the list |
| Admin, desktop 1280 px | Funnel: Details | none | open: true; Opened 412 · 100% |
| Admin, desktop 1280 px | Report row (second report) | none | address #history/srv-2; pane title: Calendar skips Sunday when a stay runs into the next month |
| Admin, desktop 1280 px | Retry delivery | POST /api/admin/feedback/srv-1/retry | first row now: Saved, no issue |
| Admin, desktop 1280 px | Add note | none | note box visible: true |
| Admin, desktop 1280 px | Save note | PATCH /api/admin/feedback/loc-1 | note shown: Thank the visitor |
| Admin, desktop 1280 px | Copy as Markdown | none | status: Copied as Markdown.; clipboard starts: ### Praise  - Type: praise - Received: 2 |
| Admin, desktop 1280 px | Mark as done | PATCH /api/admin/feedback/loc-1 | row status: Inbox: done |
| Admin, desktop 1280 px | Reopen | PATCH /api/admin/feedback/loc-1 | left the Inbox: handled list (0 rows with that title) |
| Admin, desktop 1280 px | Dismiss | PATCH /api/admin/feedback/loc-1 | still in the Inbox: open list: 0 rows |
| Admin, desktop 1280 px | Delete report… | DELETE /api/admin/feedback/loc-1 | rows with that title: 0 |
| Admin, desktop 1280 px | Copy snippet | none | message: Copied; clipboard: <script src="http://localhost:8797/w… |
| Admin, desktop 1280 px | Send test report | POST /api/admin/projects/harborline/test-report<br>GET /api/admin/projects/harborline/feedback | Delivered: Issues. Open |
| Admin, desktop 1280 px | Settings: AI & follow-ups | none | tab pressed: true |
| Admin, desktop 1280 px | Settings: General | none | fields: 10 |
| Admin, desktop 1280 px | Set (Rate limit) | none | Rate limit now a field: 1 |
| Admin, desktop 1280 px | Add entry (origin) | none | origin inputs: 8 |
| Admin, desktop 1280 px | Move down (origin) | none | origins in order: https://staging.harborline.app, https://harborline.app, https://r2.harborline.test/ |
| Admin, desktop 1280 px | Review changes | POST /api/admin/projects/harborline/config/validate | Valid. Check the destinations and the changes, then publish.; Publish enabled: true |
| Admin, desktop 1280 px | Publish | PUT /api/admin/projects/harborline/config | Published settings revision 13. Active on all edge locations within 60 s.; meta: fk_pub_3a91c07e5d22 · settings revision 13 |
| Admin, desktop 1280 px | Export config | none | the browser saved harborline.feedbackkit.config.json |
| Admin, desktop 1280 px | Advanced JSON | none | open: true, 121 lines |
| Admin, desktop 1280 px | Sidebar: All projects | GET /api/admin/projects | Projects page |
| Admin, desktop 1280 px | Theme (three clicks) | none | label: Theme: Auto, data-theme: none |
| Admin, desktop 1280 px | Theme: one more click | none | label: Theme: Light, stored: light |
| Admin, desktop 1280 px | Sign out | none | login form visible: true, token in sessionStorage: null |
| Admin, phone 390 px | Menu | none | navigation visible: true, aria-expanded true |
| Admin, phone 390 px | Menu: Setup | none | setup visible: true, menu closed: true |
| Admin, phone 390 px | Report row | none | list hidden: true, report visible: true |
| Admin, phone 390 px | ‹ Reports | none | list visible: true, address #history |
| Accounts, real server | Create passkey (first owner) | POST /api/auth/setup/begin<br>POST /api/auth/setup/finish | Passkey created: Robin, owner |
| Accounts, real server | Open the admin | GET /api/admin/projects | Projects page, sidebar owner links visible: true, who: Signed in as Robin |
| Accounts, real server | Sidebar: your name | GET /api/admin/projects<br>GET /api/admin/account | Your account |
| Accounts, real server | Add a passkey | none | dialog: Add a passkey |
| Accounts, real server | Create passkey (second one) | POST /api/admin/account/passkeys/begin<br>POST /api/admin/account/passkeys/finish<br>GET /api/admin/account | 2 passkeys listed, dialog closed: true |
| Accounts, real server | Remove (passkey) | none | dialog: Remove Security key? |
| Accounts, real server | Cancel (remove passkey) | none | 2 passkeys still listed |
| Accounts, real server | Revoke all other sessions (disabled with one session) | none | disabled: true |
| Accounts, real server | Sidebar: Users | GET /api/admin/projects<br>GET /api/admin/accounts | Users: 1 user · 1 owner |
| Accounts, real server | Invite user | none | dialog: Invite user |
| Accounts, real server | Create invitation | POST /api/admin/accounts<br>GET /api/admin/accounts | Invite user; link starts: http://localhost:52382/admin/setup#fk_… |
| Accounts, real server | Copy link | none | button reads: Copied |
| Accounts, real server | Done (invitation) | none | Taylor listed: Taylor MemberInvitedNo passkey yet · Invitation expires 18 N |
| Accounts, real server | New link | POST /api/admin/accounts/8ab25a31-dc2e-4eaa-845a-c92c761a89a5/link | dialog: New link for Taylor |
| Accounts, real server | Done (new link) | none | dialog closed: true |
| Accounts, real server | Make owner | none | (an invited user shows New link, not Make owner) |
| Accounts, real server | Remove (Taylor) | none | dialog: Remove Taylor? |
| Accounts, real server | Remove Taylor | DELETE /api/admin/accounts/8ab25a31-dc2e-4eaa-845a-c92c761a89a5<br>GET /api/admin/accounts | users: 1 user · 1 owner |
| Accounts, real server | Show removed | GET /api/admin/accounts?removed=1 | aria-pressed true, rows: 2 |
| Accounts, real server | Sidebar: API tokens | GET /api/admin/projects<br>GET /api/admin/tokens | API tokens |
| Accounts, real server | Create token | GET /api/admin/projects | dialog: Create an API token; project boxes: 2 |
| Accounts, real server | Create token (submit) | POST /api/admin/tokens<br>GET /api/admin/tokens | Create an API token; token starts: fk_tok_… |
| Accounts, real server | Copy token | none | button reads: Copied |
| Accounts, real server | Done (token) | none | tokens listed: 1; token field empty: true |
| Accounts, real server | Revoke (token) | none | dialog: Revoke Setup agent? |
| Accounts, real server | Revoke token | DELETE /api/admin/tokens/e2e73547-fb49-4bd5-b60c-0426aa29350d<br>GET /api/admin/tokens | token row: Setup agent ReadAll projectsRevoked fk_tok_5tZf2R… · Revoked 11 Nov 2026 |
| Accounts, real server | Sign out | POST /api/auth/signout | sign-in page: Sign in |
| Accounts, real server | Sign in with a passkey | POST /api/auth/signin/begin<br>POST /api/auth/signin/finish<br>GET /api/admin/projects | Projects page, who: Signed in as Robin |

## Screenshots

Light unless named. The files sit next to this document in `plain-admin/`.

| File | Screen |
|---|---|
| `projects-light.png` | Projects |
| `reports-split-light.png`, `reports-split-dark.png` | Reports with the first report open beside the list, at 1280 px |
| `reports-phone.png`, `report-phone.png`, `menu-phone.png` | Reports, one report and the open menu at 390 px |
| `setup-light.png`, `types-light.png`, `settings-light.png`, `system-light.png` | The other project sections and System |
| `your-account-light.png`, `users-light.png`, `tokens-light.png`, `tokens-new-light.png` | Account screens |
| `setup-owner-light.png`, `sign-in-dark.png` | Pages without the sidebar |

## Not covered

- Firefox and Safari. The layout uses `:has()` (Chrome 105, Firefox 121, Safari 15.4) for the switch row of the settings editor; everything else is plain CSS grid and flex.
- The theme switch exists in the sidebar only. The sign-in and setup pages have no sidebar, so they follow the saved theme and offer no switch.
- Link targets under 44 px on a phone that no test asserts: the "Projects /" crumb above a project title.
- The consent page of the MCP connection was only restyled, not re-walked with a real MCP client.

Co-created by Michel with NORA (AI Agent)
