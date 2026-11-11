# Plain admin layout

Status: waiting for a pick. This is a mock only. Nothing in `src/admin/` or `src/worker/admin/` has changed.

The owner finds the admin too loud and wants it as quiet as the NORA Web and iCloud-MCP dashboards. Open [admin-plain/index.html](admin-plain/index.html) for the three variants side by side, or open one variant and click through it: [A](admin-plain/a-top-bar.html), [B](admin-plain/b-sidebar.html), [C](admin-plain/c-drill-down.html). Each file stands alone, follows the system light or dark setting (or the switch in the bar on top) and turns into one column below 640 px. A button that is not drawn says so in a short message. All names and numbers are invented.

PNG contact sheets: `admin-plain/sheet-<a|b|c>-<light|dark>.png`. The admin as it is today: `admin-plain/current-admin.png`.

## What is wrong today

Seen in real screenshots of every screen (projects, reports, project setup, types and settings, system, sign-in, setup, account, users, tokens) at 1280 px and 390 px, light and dark.

| Finding | Where |
|---|---|
| Three navigation levels stacked: header pills, four project tabs, nine filter chips | Project page |
| Every report is a bordered card with a thumbnail, chips, a model name, a status pill and buttons | Reports |
| Pills and 22 px cards everywhere, weight 900 headings, violet tints on the current item | All screens |
| The funnel card sits above the list, so on a phone the first report starts about 800 px down | Reports, phone |
| Settings are a wall of bordered inputs, with a pill button per optional setting and a "Use default / remove setting" link under each field | Settings |

## What the mock takes from the references

Read in full: NORA Web `cloud/webapp/DESIGN.md` and the iCloud-MCP `docs/DESIGN.md`.

| Adopted | From |
|---|---|
| Lists are hairline rows and grouped settings sit in one inset panel, never a card in a card. Neutral ground, no uppercase labels, no shadows | NORA principle 5, iCloud-MCP |
| One filled button per screen, only when you have to act now. Secondary actions sit in a "More" menu | NORA principle 10 |
| Colour has one meaning each: failure is red, the accent marks the one primary action and the current page, every other status is plain words | NORA principle 3, iCloud-MCP (danger as text, not a filled button) |
| Label on the left, value on the right, one explanatory line under a group, no tooltips | NORA principle 9 |
| Sidebar on wide screens, list and detail side by side from 1180 px, one column below | NORA layout, iCloud-MCP at 900 px |

| Left out | Why |
|---|---|
| Ionic components, floating glass tab bar, serif titles, sage or indigo palette | Runtime too large for the budget (see below), an effect that exists only in NORA, and a palette that is not this product's. The accent stays FeedbackKit violet |
| Thumbnails in report rows, funnel bars, numbered step cards, dark code blocks | They move to the report page or shrink to one sentence. The code block becomes a raised box |
| Urbanist in the admin | The admin uses the system font, so it no longer loads the 27 kB font file. The widget and the landing page keep Urbanist |

Contrast, computed from the tokens: text on the page 15.3 to 16.6, muted text 5.3 (light) and 6.5 (dark), failure red 6.4 and 8.4, label on the accent 7.1 and 6.9, control borders 3.2 to 3.6.

## Make or buy

`standards.md` has no UI entry. Both reference apps use one library, Ionic Core 9.0.10 in iOS mode (NORA ADR-0024, iCloud-MCP `docs/DESIGN.md`). I measured it for this admin: `@ionic/core` 9.0.10, custom-elements build, only the components named, bundled and minified with esbuild the way `admin.js` is, JavaScript only, gzipped.

| What | Size | For comparison |
|---|---|---|
| Button, input, list, item, label, note | 35.6 kB gz | `admin.js` today: 15.3 kB gz in total, 210 bytes left of its 15.5 kB budget |
| Plus segment, toggle, select, textarea, chip | 117.7 kB gz | `auth.js`: 6.4 kB of 9 kB |
| Plus modal, alert, popover, toast | 122.5 kB gz | Widget: 22.8 kB of 23 kB |

Proposed: native controls and the shared tokens, no library. The browser already has every control the admin needs (button, input, select, textarea, checkbox as a switch, radio, `<dialog>`, `<details>`), the admin already uses two of them, and Ionic would be 2 to 8 times the whole admin module. The tokens carry the iOS look. If Ionic should win anyway, it needs its own module, a CSP review and a rewrite of about 100 kB of source (`main.ts`, `settings.ts`, `auth/main.ts`), which would be its own PR.

The mock's stylesheet is about 2.3 to 2.8 kB gzipped (crude minification, without the account-screen rules) against 4.3 kB for the `CSS` of `pages.ts` today. It sits in the HTML shell, so it does not count against the JavaScript budget.

## The three variants

They share tokens, rows and wording. They differ in how you move around.

| | Navigation | Reports and one report | Cost to build | Pick it if |
|---|---|---|---|---|
| A. Top bar and tabs | Text navigation, project sections as tabs, account in a name menu | List, then a page per report | Least: the shells stay, the stylesheet and row markup change, the report page is new | Budget and time are tight |
| B. Sidebar and split view | One sidebar with projects and their sections, system, tokens, users and account. A menu button on a phone | List and report side by side from 1180 px, one at a time below | Most: a new shell on every admin page plus the split logic | Triage speed matters and you want the NORA and iCloud-MCP pattern |
| C. Drill-down lists | One grouped list per level with a back link. No tabs, no sidebar | List, then a page per report | Medium: a project overview page and one page per level | Calm matters more than clicks |

Recommendation: B. It is the pattern the two reference apps use, it leaves one navigation level, and triaging many reports does not cost a page load each. If the build has to stay small, A.

Every variant needs a decision on the JavaScript budget. The report page and the filter replace code that goes away (nine chips, the card builder), but I have not measured the balance and `admin.js` has 210 bytes left. A project-page module next to `auth.js` is the way out if the balance is negative.

## Screens drawn

Projects, reports (with the filter and the empty state), a failed report, an inbox report, setup, types, settings (General), system, API tokens (list, new token, token shown once, revoke), users, your account and sign-in. In B, the two other projects in the sidebar show the empty state.

Not drawn: the other settings sections, the review-and-publish diff, the first-owner and invitation pages, error and rate-limit states, the consent page. They follow from the rows and groups shown. Tested in Chrome only: no horizontal scroll at 320, 390, 768, 1280 and 1440 px on every screen of all three variants, and the dialogs, menus, filter, theme switch and phone menu clicked once each. Firefox and Safari are not tried.

## Constraints the mock keeps

| Constraint | In the mock |
|---|---|
| Admin bundle budget | No new JavaScript runtime. The budget question is open, see above |
| Passkey sign-in at `/admin/setup`, no password field | One button, recovery commands folded under "Locked out?" |
| Owner and member roles, "Users" as the name after the rename in progress | Owner-only actions in a menu, "the only owner" stays visible. Where the account area lives depends on the variant |
| Scoped API tokens at `/admin/tokens` | Name, read or write, projects, expiry, shown once, revoke asks first |
| Phone | One column below 640 px, 44 px targets, no sideways scrolling |

## What I need from you

- [ ] Which variant: A, B or C.
- [ ] System font in the admin instead of Urbanist.
- [ ] Native controls instead of Ionic here. If yes, `standards.md` gets one line: Ionic Core in apps with their own build (NORA Web, iCloud-MCP), native controls plus the shared tokens where the bundle budget rules out a runtime (FeedbackKit admin).

After the pick, a follow-up PR implements the chosen variant in `src/admin/` and `src/worker/admin/`, starting from a fresh `origin/main` once the Users rename has landed. Every changed button gets clicked once in a real browser, the e2e specs follow the new markup and `pnpm check:bundle` stays green.

Co-created by Michel with NORA (AI Agent)
