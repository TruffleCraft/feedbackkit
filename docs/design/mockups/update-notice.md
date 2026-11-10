# Notice for a newer release (journey J2)

Status: variant A was approved and built (see "Outcome" at the end). The mock below is what it was built from. Open [update-notice.html](update-notice.html) in a browser. It shows three placements in four states, on desktop and on a phone, with a light and a dark switch. One PNG per variant: [A](update-notice-a.png), [B](update-notice-b.png), [C](update-notice-c.png). All data is invented.

The short version of this note sits in the J2 section of [journeys.md](../journeys.md).

## What exists today

- `/api/admin/system` returns `version` and `channel`. The System page shows them in its subtitle and in the Release row of the Gateway table (`loadSystem` in `src/admin/main.ts`).
- Needs attention lists faults: a schema mismatch, a missing token, reports that retention is about to delete. An update that waits is not a fault.
- A release tarball reports release and channel from `bundle.json`. A checkout has no `bundle.json` and reports channel `local` (`scripts/server.mjs`). A Worker build reports `stable` or `dev` from `FK_CHANNEL`, so the channel alone cannot tell a tarball install from Cloudflare.
- Nothing in `src/` asks GitHub for a release. `feedbackkit-update --check` does, and exits 10 when an update waits.
- The admin CSP is `connect-src 'self'`, so the admin page cannot call the GitHub API itself.
- The admin bundle is 15,305 bytes gzipped against a budget of 15,360 (ADR-014). 55 bytes are left.

## References

- Nextcloud shows a banner on every page and an Updates section under Administration settings, Overview ([upgrade docs](https://docs.nextcloud.com/server/latest/admin_manual/maintenance/upgrade.html)).
- Uptime Kuma puts a "New Update" button in the desktop header. It links to the releases page, and the layout file has no dismiss control ([Layout.vue](https://github.com/louislam/uptime-kuma/blob/master/src/layouts/Layout.vue)).
- Vaultwarden lists the installed and the latest version on its diagnostics page, each with an Ok, Update or Unknown badge ([diagnostics.hbs](https://github.com/dani-garcia/vaultwarden/blob/main/src/static/templates/admin/diagnostics.hbs)).
- Grafana checks by default, one setting turns the check off, and nothing sensitive is sent ([configuration](https://grafana.com/docs/grafana/latest/setup-grafana/configure-grafana/), `check_for_updates`).
- Home Assistant lets an operator skip an available update ([update integration](https://www.home-assistant.io/integrations/update/), `update.skip`).

Gitea checks a version file once a week ([app.example.ini](https://github.com/go-gitea/gitea/blob/main/custom/conf/app.example.ini), section `cron.update_checker`).

The mock follows Vaultwarden for the Release row, with one badge per state, and shows a card only when an update waits. Uptime Kuma's button is left out because it links to the list of releases, not to the new one.

## Component check

The admin is plain DOM (ADR-014). The card needs a container, a badge, a link and a code block, and `.c`, `.badge`, `.lnk` and `.term` already provide them. Maintained notice components exist: Web Awesome's `<wa-callout>` ([docs](https://webawesome.com/docs/components/callout)) and Primer's `Banner` for React ([docs](https://primer.style/product/components/banner/)). Each needs a runtime the admin does not load, and 55 bytes are left. None is used.

## Variants

| Variant | Seen on | Extra request | Admin bundle, gzipped | Against the 55 bytes left |
|---|---|---|---|---|
| A. Card on the System page | System page | none, it rides on `/api/admin/system` | +71 B | 16 B over |
| B. A plus a dot on the System tab | every page, as a dot | one small call per page load | +115 B | 60 B over |
| C. Banner under the top bar, dismissible per version | every page, as text | one small call per page load | +157 B | 102 B over |

The byte counts come from a throw-away copy of `src/admin/main.ts` with the update code added, built with the esbuild settings of `scripts/build-widget.mjs`. The static text of the notice sits in the server-rendered shell, as the admin does elsewhere, so the module only sets a state, a version and a link. Real code needs error handling and tests, so expect a little more.

In every variant the Release row carries the other states: a badge for up to date, check failed or update waiting, and one line under the version with the check date or the reason. On a phone the Gateway table scrolls sideways, as it does today, so that line keeps the state in view.

## Recommendation

Build A. It adds no request outside the System page, costs the fewest bytes, and keeps an update out of Needs attention and out of the way of the inbox. The dot of B is a cheap addition later (about 44 bytes and one request per page) if operators miss the card.

All three variants exceed the budget today. Either raise the admin budget by 0.25 kB or free about 100 bytes first. That decision comes before any build.

## Open questions

- **Where the check runs.** The mock assumes the gateway asks GitHub once a day and caches the answer. A check in the browser is blocked by the CSP and would tell GitHub each time an admin opens a page. How is the check switched off: an environment variable or a setting in the admin?
- **Telling a tarball install apart.** The standalone server knows whether `bundle.json` exists. Is a field on `/api/admin/system` that is absent on Cloudflare and on checkouts the right carrier?
- **The bundle budget.** Raise it by 0.25 kB, or find the bytes elsewhere in the admin?
- **Languages.** CONTRIBUTING and the plan ask for English and German keys for new strings. The admin has no string table and is English only. Is the notice the first German admin string, or does the rule cover the widget only?
- **Skipping a version.** Only variant C needs it. Should a dismissal last for one release, as drawn, or until the operator brings the notice back?

## Outcome

Variant A was approved and built, with the evidence in [2026-11-10-update-notice.md](../evidence/2026-11-10-update-notice.md). The five questions were decided as recommended: the gateway checks once a day and the browser never does, `FK_UPDATE_CHECK=off` switches it off, `/api/admin/system` carries an `update` field that is absent on Cloudflare and on checkouts, the admin budget is 15.25 kB (ADR-014), and the notice is English only with no dismiss.

The built module costs 215 bytes gzipped. The scratch build above cost 71, because it did not carry the reason text of a failed check or the badge texts of every state.

Co-created by Michel with NORA (AI Agent)
