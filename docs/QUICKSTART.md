# Quickstart

Self-host FeedbackKit — one Cloudflare Worker (+ D1 + R2, free tiers) — and get
your first structured issue. **Existing Cloudflare user: ~15 min. Cold (no CF
account yet): ~45 min** (most of it is CF signup + `wrangler login`).

> **Order matters:** create the resources locally FIRST, then (optionally)
> connect a fork to Workers Builds. Workers Builds only runs `pnpm deploy` — it
> does *not* create your D1 database, R2 bucket, or secrets.

## 0. Prerequisites

- Node **≥ 22.13** and pnpm **11** (`corepack enable`).
- A Cloudflare account + `pnpm exec wrangler login`.
- A GitHub repo where issues should land.

```bash
git clone https://github.com/TruffleCraft/feedbackkit ~/feedbackkit
cd ~/feedbackkit && pnpm install
```

## 1. Create the Cloudflare resources

```bash
pnpm exec wrangler d1 create feedbackkit            # copy the database_id
pnpm exec wrangler r2 bucket create feedbackkit-uploads
```

Set these three build variables (locally now; and in Workers Builds later if you
fork). `pnpm setup` prints them too:

```bash
export CLOUDFLARE_ACCOUNT_ID=…      # dash → your account id
export FK_D1_ID=…                   # the database_id from above
export FK_R2_BUCKET=feedbackkit-uploads
```

## 2. Secrets

```bash
pnpm exec wrangler secret put ADMIN_TOKEN          # generate a long random string
pnpm exec wrangler secret put GITHUB_PAT_default   # see the PAT recipe below
pnpm exec wrangler secret put LLM_API_KEY          # OPTIONAL — skip to run "LLM off"
```

### GitHub PAT recipe (exact)

Create a **fine-grained** personal access token (Settings → Developer settings →
Fine-grained tokens):

- **Resource owner:** the owner of your target repo. ⚠️ Fine-grained PATs are
  scoped to **one owner** — a token owned by `org-A` cannot reach `org-B/repo`.
  Multi-org? Use several named secrets (`GITHUB_PAT_teamA`, `GITHUB_PAT_teamB`)
  and point each project's `tracker.patSecret` at the right one.
- **Repository access:** only the repo(s) issues go to.
- **Permissions:** **Issues → Read and write**, **Metadata → Read-only** (that's
  all — nothing else).
- Fine-grained PATs expire (max 1 year). `/diag` surfaces the expiry; renew before it lapses.

If you skip `LLM_API_KEY`, the widget runs in **required-field mode** (plain
forms, no AI follow-up) — not a failure state. Add the key later to enable AI
structuring. See [MODELS.md](MODELS.md) for the model to use.

## 3. Deploy

```bash
pnpm deploy
```

This builds the widget, generates `wrangler.toml` from your build variables
(ADR-004 — the real toml is gitignored), applies D1 migrations to the remote DB,
and deploys the Worker.

## 4. Create a project (seed config)

There's no admin UI yet (P2); in P1 a project is a JSON file seeded into D1 —
**the same schema the admin will import**, so no rework.

```bash
cp config/example.json config/my-project.json
# edit: projectId, tracker.defaultRepo (owner/repo), auth.origins (your site),
#       storage.publicBaseUrl (your R2 public URL), llm.model
pnpm seed config/my-project.json --remote
```

It prints your **public key**, the **snippet**, and the **test page URL**.
Re-run any time to update the config (bumps the version so widgets refetch).

**No CLI at hand?** The same JSON imports over the API — one authenticated POST,
no clone, no wrangler, no Node (this is the path after a one-click deploy):

```bash
curl -X POST "https://<your-worker>.workers.dev/api/admin/config/import" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data @config/my-project.json
```

The response carries the same public key, snippet, and test-page URL. An
optional top-level `"publicKey"` field pins the key; on re-import the stored
key always wins (installed snippets never break).

> **R2 public URL:** enable public access on the bucket (an `r2.dev` URL or a
> custom domain) and put it in `storage.publicBaseUrl` — screenshots are served
> from there and rendered inline in the issue.

## 5. Verify

```bash
# base health (public): schema + bindings
curl https://<your-worker>.workers.dev/diag

# deep check (admin-gated): PAT reach + expiry, LLM config, R2 roundtrip
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://<your-worker>.workers.dev/diag?project=<public-key>"

# prove a PAT can open issues in your repo. This CLI uses a LOCAL token (not the
# Cloudflare secret), so pass it for this check — the /diag line above already
# verified the deployed secret's reach:
GITHUB_PAT=<your-fine-grained-pat> pnpm test-issue your-org/your-repo

# try the full flow with zero risk (dry-run — no issue, no AI call)
open https://<your-worker>.workers.dev/t/<public-key>
```

## 6. Install the widget

Add the snippet to your site (exactly two attributes — everything else comes
from `/api/config`, so the snippet never goes stale):

```html
<script src="https://<your-worker>.workers.dev/widget.js" data-project="<public-key>"></script>
```

Make sure your site's origin is in the project's `auth.origins` (re-seed if you
change it). Debug an integration with `?fkdebug=1` on the page URL, or
`data-debug` on the script tag.

### Host CSP

If your site sends a Content-Security-Policy, allow the gateway origin
(`<gw>`) and what the widget injects:

| Directive | Value | Why |
|---|---|---|
| `script-src` | `<gw>` | `widget.js` |
| `connect-src` | `<gw>` | config, upload, feedback, events |
| `font-src` | `<gw>` | Urbanist `@font-face` (`/urbanist.woff2`) |
| `style-src` | `'unsafe-inline'` | the widget injects `<style>` (no nonce support yet) |
| `img-src` | `blob: data:` | screenshot preview and annotator |
| `script-src`, `frame-src` | `https://challenges.cloudflare.com` | only with Turnstile |

A custom domain keeps these entries stable: set the build variable
`FK_CUSTOM_DOMAIN=feedback.example.com` (zone in the same Cloudflare account)
and deploy; `pnpm materialize` adds the custom-domain route.

### Privacy and capture settings (project config)

```jsonc
{
  "capture": { "screenshot": "off", "console": false }, // default: "optional", true
  "privacyUrl": "https://example.com/privacy",          // linked from the widget
  "issueLink": false,                                   // default true: "View ticket" after sending
  "askType": false,                                     // default false: see below
  "storage": { "kind": "r2", "retentionDays": 90 }      // R2 objects AND D1 rows
}
```

- `capture.screenshot: "off"` removes the page capture (the gateway also refuses
  it); users can still attach images themselves. Use it when pages show
  sensitive content. `capture.console: false` never hooks the console.
- `issueLink: false` keeps the issue URL out of the widget response. Use it for
  public sites whose tracker is private or should stay unnamed.
- With an LLM configured, `askType: false` and more than one template, the
  gateway classifies each report itself and the widget shows no type picker.
  When the text fits more than one type (a new feature or a change to something
  that exists), the one follow-up question settles it, and the answer may move
  the report to the other type. `askType: true` (or `llm.provider: "off"`)
  brings the picker back.
- The page URL is always reported as origin + path; query strings and fragments
  are dropped (they carry login tokens).
- With `retentionDays`, the daily cron deletes attachments, stored submissions
  and funnel events older than that.

### Context from a signed-in app

```html
<script>
  // object, or a function read at submit time; flat values only, max 20 keys
  window.FeedbackKitContext = () => ({ userId: currentUser?.id, appVersion: "1.4.2" });
</script>
```

It lands in the issue as "App context (not verified)" and is never sent to the
LLM. Prefer opaque ids over e-mail addresses.

### Own button and lazy loading

`data-trigger="none"` hides the floating button; `window.FeedbackKit.open()`
opens the panel once the widget has booted, `data-autoopen` opens it right
after boot. Load the script only on click when a page must not contact any
server before the user asks to:

```html
<button id="feedback">Feedback</button>
<script>
  document.getElementById("feedback").addEventListener("click", () => {
    if (window.FeedbackKit) return window.FeedbackKit.open();
    const s = document.createElement("script");
    s.src = "https://<gw>/widget.js";
    s.dataset.project = "<public-key>";
    s.dataset.trigger = "none";
    s.dataset.autoopen = "";
    document.body.appendChild(s);
  });
</script>
```

### Match your design (theming)

The widget renders in a Shadow DOM, so your CSS cannot reach its rules. It reads
its colours, font and shadow from CSS custom properties instead, and your page
sets them on the widget's host element. Declarations from your page win over
the widget's defaults:

```css
[data-feedbackkit="host"] {
  --fk-accent: #587263;      /* send button, focus, the trigger and avatar disc */
  --fk-accent-ink: #fbfaf7;  /* text and icons on the accent */
  --fk-accent-soft: #eaf0ec; /* question bubble, type tag, active pills */
  --fk-accent-text: #3f5a4b; /* accent-coloured text on light surfaces */
  --fk-accent-2: #88ab98;    /* second pill of the mark in the panel head */
  --fk-bg: #fbfaf7;          /* panel */
  --fk-soft: #f4f2ec;        /* composer, answer field, the user's bubble */
  --fk-ink: #1a1917; --fk-ink-2: #6e6a62; --fk-muted: #6e6a62;
  --fk-line: #e4e0d7; --fk-line-2: #d6d1c6;
  --fk-font: "Hanken Grotesk", system-ui, sans-serif;
  --fk-shadow: 0 8px 24px rgba(40, 36, 28, .08);
}
html.dark [data-feedbackkit="host"] { /* repeat the tokens for your dark theme */ }
```

Set every token you change for each theme your site has; tokens you leave out
keep FeedbackKit's own values. The widget follows `<html data-theme="dark|light">`
and otherwise `prefers-color-scheme`; a site that switches themes another way
(for example a `dark` class) sets both themes' tokens as above. Use fonts your
page already loads.

### Turnstile (open sites)

Create a Turnstile widget for your site's hostnames, then:

```bash
wrangler secret put TURNSTILE_SECRET_main
```

```jsonc
{ "turnstile": { "siteKey": "0x4AAAA…", "secret": "TURNSTILE_SECRET_main" } }
```

The widget loads Turnstile on first open (`interaction-only`: invisible unless a
check is needed) and sends a fresh token with every POST. The gateway redeems
it at Siteverify and requires success, action `feedback` and a hostname from
`auth.origins`; anything else gets a 403.

## Fork + auto-deploy (recommended for updates)

After step 1–5 work locally: fork the repo, connect it to **Cloudflare Workers
Builds** with production branch **`stable`**, build command `pnpm deploy` and the
three build variables from step 1. Then syncing the `stable` branch with upstream
(GitHub "Sync fork") redeploys you automatically with the latest stable release
([RELEASES.md](RELEASES.md)) —
the repo stays commit-identical with upstream because all your state lives in
D1 + secrets, never in tracked files (ADR-004).
