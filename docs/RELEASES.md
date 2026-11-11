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

**Delivery capability** (#109): after the smoke check, the promote workflow writes the
release's `DELIVERY_CAPABILITY` (`src/shared/contract.ts`) to `meta.delivery_capability`.
Config writers accept new delivery shapes only up to that level, because stable reads the
same configs. Level 3 covers archived types (`templates[].archived`). Level 4 means the data knows accounts (schema 5): once the first owner exists `ADMIN_TOKEN` grants nothing, and an older release would honor it again, so the standalone server refuses to start below 4. No config shape needs 4. A rollback with `wrangler rollback` does not lower the value: before rolling
back past a release that raised it, check that no stored config needs the higher level
(`noIssue: true` next to `delivery` keeps older releases from opening issues).

**Migrations** run before the dev upload and touch the database production also uses. They
must stay expand/contract: a migration may only add, and stable must keep working on the new
schema for one release.

## Rolling back

Production: `pnpm exec wrangler rollback` (previous deployment) or
`pnpm exec wrangler versions deploy <version-id>@100%` for a specific one; the GitHub release
stays, the next promotion moves on. Dev: re-run `Release (dev channel)` on an older commit, or
wait for the next merge. D1 migrations are not rolled back; expand/contract keeps the previous
code working on the newer schema.

The standalone server installed from a release tarball goes back with `feedbackkit-update --rollback`
(see [Updating](#updating)). A checkout install has no rollback command: restore the backup taken before
the update (see [SELF_HOSTING.md](SELF_HOSTING.md#data-backups-and-updates)).

## Server tarball

The standalone server ships as a tarball, so an operator installs a finished release without Git, pnpm or a compiler. Every dev build and every stable release carries three files on its GitHub release: `feedbackkit-vX.Y.Z.tar.gz`, `SHA256SUMS` and `SHA256SUMS.sig`. They are published only when the signing key of the channel is configured (see Release keys). An unsigned tarball is never attached.

- **Contents:** a single-file `server.mjs` without `node_modules`, the widget and admin assets, the migrations, the systemd unit, `feedbackkit-update`, `feedbackkit-admin` (the host commands for accounts), the public release keys and `bundle.json` (release, channel, schema version, delivery capability, file list). It is about 360 kB. `/diag` shows the release and channel from `bundle.json`.
- **Build:** `pnpm build:widget && pnpm build:server && pnpm build:bundle` writes `dist-bundle/`. Two builds of one release are byte-identical (`test/server-bundle.test.mjs`).
- **What was tested is what ships:** promoting a dev build rebuilds the same commit under the stable version and compares the two tarballs. They must be equal except `bundle.json` and the widget with its version stamp (`scripts/compare-bundles.mjs`), or the promotion stops before anything is deployed.
- **Target:** Node.js 24 or newer and the standard tools curl, tar, sha256sum and ssh-keygen. One tarball serves every Linux target.

### Release keys

`SHA256SUMS` is signed with an Ed25519 key through `ssh-keygen -Y sign` (namespace `feedbackkit-release`). A checksum detects a damaged download. The signature detects a tampered one. Each channel has its own key: stable releases carry the stable signature, dev builds the dev signature, and the update command trusts the dev key only on the dev channel and never for a stable release.

- **Public keys** are committed as `release-keys/stable.pub` and `release-keys/dev.pub` and ship in every tarball. The stable key is `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILxeMV0GhgnPRcC5a2U3Kvuka/1EcDxLGq17YHP9fjvu` with the fingerprint `SHA256:4yszmEKSSoX49kfCJkTRP6CYIaqWhU/KUMqrL55nXb0`. No release has been signed yet.
- **Private keys** are the secret `FK_RELEASE_SIGNING_KEY` of the GitHub environments `production` (stable) and `dev`. `sh scripts/gen-release-keys.sh` creates a pair and prints these steps. The maintainers keep one copy of each private key in a password manager. Nothing else stores them.
- **Verify by hand** (the first install): `ssh-keygen -Y verify -f allowed_signers -I release-stable -n feedbackkit-release -s SHA256SUMS.sig < SHA256SUMS`, where `allowed_signers` holds the line `release-stable namespaces="feedbackkit-release" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILxeMV0GhgnPRcC5a2U3Kvuka/1EcDxLGq17YHP9fjvu`.
- **Rotation:** publish a release that carries the new key list in `release-keys/` and is signed with the old key. Installs that update to it then trust the new key. Sign every later release with the new key. A release signed with the old key is refused from then on. `test/server-update.test.mjs` rehearses this ("a key rotation").
- **A lost or leaked key:** publish new keys as a new release, tell operators to verify the first install against the key in this file, and treat releases signed after the leak as untrusted.

### Updating

`feedbackkit-update` is part of every release and needs nothing beyond Node and the tools above. It makes one plain read of the GitHub Releases API and sends nothing about the installation. Nothing updates unless you run it.

A tarball install also tells you on the System page when a newer release waits. The server asks the same API at most once a day (the browser never does), `FK_UPDATE_CHECK=off` turns it off ([SELF_HOSTING.md](SELF_HOSTING.md#configuration)), and the notice only points at this command.

| Command | What it does |
|---|---|
| `feedbackkit-update --check` | Prints the installed and the newest release. Exit 0 when up to date, 10 when an update waits |
| `feedbackkit-update` | Downloads the newest release of the channel, verifies signature and checksum, unpacks it, copies the data directory, switches `current`, restarts the service and waits for `/diag` to show the new release. Any failure restores the old release and its data |
| `feedbackkit-update --channel dev` | Takes dev builds as well. The default is stable, or dev when a dev build is installed |
| `feedbackkit-update --rollback` | Goes back to the previous release with the data copy taken before the update. What came in since stays in `<data dir>.after-rollback-<time>` |

The two newest releases stay on disk. The layout is `/opt/feedbackkit/releases/<version>/` with `current` and `previous` as links. [SELF_HOSTING.md](SELF_HOSTING.md#install-from-a-release-tarball) has the install steps.

## Cloudflare self-hosting updates

Fork the repository and connect it to Cloudflare Workers Builds with production branch
**`stable`** and build command `pnpm deploy` (it builds, applies migrations, deploys and records the delivery capability). To
update, sync the `stable` branch of your fork with upstream; Workers Builds deploys it. Read the
release notes of every version you skip.
