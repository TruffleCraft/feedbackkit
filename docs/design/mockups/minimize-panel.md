# Minimize the panel and keep the report (#170)

Status: mock, not built, variant A chosen. Open [minimize-panel.html](minimize-panel.html) in a browser. It shows three ways to minimize the panel and the list of reports sent in this session, each on desktop and on a phone, with light and dark frames. One PNG per variant and theme sits in [minimize-panel/](minimize-panel/). All data is invented: Sam reports a wrong total on the made-up ticket shop at `example.org`.

## What exists today

- The panel sits on `.fk-backdrop` and locks page scroll. Below 600 px it is a full-screen sheet (`src/widget/ui/styles.ts`).
- Closing from the form already keeps the draft in memory (`draft` in `src/widget/index.ts`), so a single-page app gets text and screenshots back on the next open. A full page load loses them. The widget writes nothing to `localStorage`, `sessionStorage`, IndexedDB or cookies.
- Screenshots stay Blobs until Send. Manual attachments upload when picked, so an abandoned draft can already leave uploads behind. They stay until the asset's `expires_at` (the project's retention) passes, and with no retention they stay.
- `feedbackkit:open` and `feedbackkit:close` (#169) mark the start and end of a report. `docs/QUICKSTART.md` already says that minimizing will not fire `feedbackkit:close` and that a page that hides content keeps it hidden until the report ends.
- Escape and a click outside close the panel. A click outside is ignored while the form holds unsent text.
- The widget bundle is 23,436 bytes gzipped against a budget of 23,552 (`scripts/check-bundle.mjs`). 116 bytes are left.

## References

- Intercom: `hide` closes the panel and leaves the launcher; `shutdown` clears user data. A cookie keeps conversations in the Messenger for a week ([JavaScript API methods](https://developers.intercom.com/installing-intercom/web/methods)).
- Zendesk messaging: `open` and `close` expand and collapse the window, `show` and `hide` control the launcher, `reset` clears all widget state. The widget uses cookies plus local and session storage ([Web Widget core API](https://developer.zendesk.com/api-reference/widget-messaging/web/core/)). Zendesk's own recipe for keeping the widget open across page loads stores the state in `localStorage` ([support article](https://support.zendesk.com/hc/en-us/articles/8251700342938-How-can-I-customize-the-Web-Widget-to-remain-open-when-the-page-loads)).
- Help Scout Beacon: `open`, `close` and `toggle`, with `open` and `close` events. `reset` clears the contact form, its fields and attachments; `logout` clears everything ([Beacon JavaScript API](https://developer.helpscout.com/beacon-2/web/javascript-api/)).
- Crisp: a cookie on the base domain keeps one session across pages and subdomains ([cookie policies](https://docs.crisp.chat/guides/chatbox-sdks/web-sdk/cookie-policies/)), so a page view does not start a new conversation ([cookie policy](https://help.crisp.chat/en/article/crisp-chatbox-cookie-ip-policy-1147xor)).

The pattern taken over: minimizing and ending are separate acts. Minimizing never loses anything; only Send, discard or Done end the report, clear the draft and fire `feedbackkit:close`. The chat widgets keep their state on the server and find it again through a cookie. FeedbackKit has nothing on the server before Send, so the draft stays in the tab, in `sessionStorage`, which a tab close empties.

## Same in every variant

- A minimize button sits left of close in the panel and in the phone sheet header (44 px tap target, like close).
- Minimized, the backdrop, `aria-modal` and the scroll lock go away. Focus moves to the minimized control.
- The minimized control respects `--fk-trigger-bottom` and the safe area, so it stays clear of a host's tab bar. It also shows with `data-trigger="none"`, because otherwise Sam has no way back. `window.FeedbackKit.open()` restores a minimized report.
- The restored panel labels each screenshot with the path of the page it came from (origin and path only, as `pageUrl`). The report's `pageUrl` stays the page where Sam presses Send.
- The cap stays at 4 screenshots and 5 attachments in total.
- The panel has no type picker. The gateway picks the type, as it does today with a model and `askType: false`; #172 drops the picker for projects without a model too.

## Variants

| | A. Pill | B. Bubble | C. Edge tab |
|---|---|---|---|
| Minimized | The trigger grows into a pill: "Report draft · 2 screenshots", a camera and an open button | Round launcher with a count badge | Narrow tab on the right edge, halfway down, opens a menu |
| Screenshot of the next page | 1 tap on the camera, the panel stays closed | 3 taps: open, Screenshot, minimize | 2 taps through the menu |
| After a full page load | Draft back, minimized | Draft back, minimized | Gone (a single-page app keeps it in memory) |
| Kept in the tab | `sessionStorage`: text, report id, upload keys | `sessionStorage` (text, report id, upload keys), plus screenshot images in IndexedDB | Nothing |
| Uploads before Send | Screenshots upload on capture, like attachments today; markup made later replaces the file | Attachments only, as today | Attachments only, as today |
| Left behind if Sam walks away | Uploaded screenshots without a report | Images in IndexedDB until the tab closes or the next Send | Nothing new |

The bytes are not measured. Every variant needs more than the 116 bytes left.

Events in every variant: minimizing and restoring fire nothing. A restored draft fires `feedbackkit:open` once after a page load, because the new page has not heard it. In C a page load ends the report without `feedbackkit:close`, because the page that would hear it is gone.

Make or buy: no library. The widget is plain DOM in a shadow root, the storage is the browser's `sessionStorage`, and early uploads reuse `/api/upload` with `kind=screenshot`.

## Recommendation

Build A. One tap on the pill captures the page Sam is on, so a report can cover several pages without opening the panel each time (TruffleCraft/nora#486). The pill shows that a draft waits and what it holds, and it sits where the trigger already sits, above the tab bar on a phone (TruffleCraft/nora#511). The storage follows the issue: text, id and keys in `sessionStorage`, screenshots uploaded on capture.

If the budget cannot grow much, C covers single-page apps and phones but loses the draft on a full page load.

## Sent in this session

After Send the widget already shows how the gateway understood the report: its summary and the type it picked. New: each sent report also goes into a list in the tab, shown above the form the next time the panel opens.

- An entry holds the gateway's summary, the type, time, page path and report id. The ticket link is kept only when the project sets `issueLink: true` (the default). Otherwise the entry and the done card show a short reference taken from the report id.
- No live status. GitHub owns the state of an issue, and the widget asks nothing after Send. A report still being delivered keeps the state it had at Send.
- The full issue text, its fields and the console log are not shown.
- The list lives in `sessionStorage` next to the draft and is gone when the tab closes. `localStorage` would keep it past the session, and on a shared computer the next person would read the summaries.
- The trigger shows no count, so the list never looks like unread messages.

## Decided (2026-11-18)

- **Variant:** A, the pill.
- **Escape and close:** Escape minimizes. Close with unsent text asks "Discard this report?"
- **Hidden content while minimized:** content a page hides on `feedbackkit:open` stays hidden until the report ends, as QUICKSTART promises, and there are no new events. The camera on the pill can capture at any time, so hidden content has to stay hidden while minimized.
- **Leftovers:** uploaded screenshots that never got a report are deleted after 24 hours. A draft lasts until the tab closes.
- **Bundle budget:** it goes up. The build PR measures by how much.
- **Sent list:** as above, per tab.
- **Type picker:** gone by default, the gateway picks the type (#172). Setting up new projects through a guided chat follows later (#173).

Co-created by Michel with NORA (AI Agent)
