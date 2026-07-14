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

## Fork + auto-deploy (recommended for updates)

After step 1–5 work locally: fork the repo, connect it to **Cloudflare Workers
Builds** with build command `pnpm deploy` and the three build variables from
step 1. Then pulling upstream (GitHub "Sync fork") redeploys you automatically —
the repo stays commit-identical with upstream because all your state lives in
D1 + secrets, never in tracked files (ADR-004).
