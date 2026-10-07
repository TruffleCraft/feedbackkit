# Releases and channels

FeedbackKit ships on two channels (ADR-013). Every merge is a **dev** build; a tested dev
build is **promoted** to **stable** by hand. Versions come from git tags, never from a bump
commit.

| Channel | Version | Built when | Served at | Who uses it |
|---|---|---|---|---|
| **stable** | `vX.Y.Z` | `Promote to stable` workflow, by hand | the gateway's production URL (and custom domain) | live sites, self-hosters (`stable` branch) |
| **dev** | `vX.Y.Z-dev.N` | every merge to `main` | `dev-<worker>.<subdomain>.workers.dev` (Worker preview alias) | preview/staging environments of the embedding apps |

- A dev build after a stable release takes the next patch by itself (`v0.1.0` → `v0.1.1-dev.1`).
  A new minor or major line starts once via the `Release (dev channel)` workflow's `bump`
  input; later dev builds stay on it.
- A dev build sorts below the stable release of the same version. GitHub keeps the newest
  three dev prereleases; promoting a version removes its dev builds.
- `/diag` reports `version` and `channel`; the widget logs its release with `?fkdebug=1`.

## How an embedding app picks a channel

The channel is the gateway URL in the snippet. Production points at the stable gateway, the
app's preview environment at the dev alias, for example:

```html
<!-- production -->
<script src="https://<gateway>/widget.js" data-project="fk_pub_…"></script>
<!-- preview / staging -->
<script src="https://dev-<worker>.<subdomain>.workers.dev/widget.js" data-project="fk_pub_…"></script>
```

Both channels read the same projects (one D1), so a project needs no second import; its
`auth.origins` must list the preview hosts too. Within a channel the widget is evergreen: it
is served with `Cache-Control: max-age=0, must-revalidate`, so every page load after a release
gets it. `?v=` in a snippet does not pin a version.

## Releasing (maintainers)

1. Merge to `main`. `Release (dev channel)` builds `vX.Y.Z-dev.N`, applies D1 migrations,
   uploads the Worker version behind the `dev` alias, smoke-checks it and publishes a
   prerelease with `widget.js` attached.
2. Test on the dev alias (or an app's preview environment).
3. Run **Promote to stable** with that dev tag. It rebuilds the same commit as `vX.Y.Z`,
   deploys production, smoke-checks it, publishes the release as latest (notes since the
   previous stable) and fast-forwards the `stable` branch.

Required setup: secret `CLOUDFLARE_API_TOKEN` (Workers Scripts edit, D1 edit, R2 read,
account settings read, user details and memberships read); variables `CLOUDFLARE_ACCOUNT_ID`,
`FK_D1_ID`, `FK_R2_BUCKET`, optional `FK_GATEWAY_URL`, `FK_DEV_URL` (smoke checks) and
`FK_CUSTOM_DOMAIN`. Environments `dev` and `production`; add required reviewers to
`production` to gate promotion.

**Migrations** run before the dev upload and touch the database production also uses. They
must stay expand/contract: a migration may only add, and stable must keep working on the new
schema for one release.

## Rolling back

Production: `pnpm exec wrangler rollback` (previous deployment) or
`pnpm exec wrangler versions deploy <version-id>@100%` for a specific one; the GitHub release
stays, the next promotion moves on. Dev: re-run `Release (dev channel)` on an older commit, or
wait for the next merge. D1 migrations are not rolled back; expand/contract keeps the previous
code working on the newer schema.

## Self-hosting updates

Fork the repository and connect it to Cloudflare Workers Builds with production branch
**`stable`** and build command `pnpm deploy` (it builds, applies migrations, deploys). To
update, sync the `stable` branch of your fork with upstream; Workers Builds deploys it. Read the
release notes of every version you skip.
