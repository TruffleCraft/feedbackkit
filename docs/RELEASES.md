# Releases and channels

FeedbackKit ships on two channels (ADR-013). Every merge is a **dev** build; a tested dev
build is **promoted** to **stable** by hand. Versions come from git tags, never from a bump
commit.

| Channel | Version | Built when | Published as | Who uses it |
|---|---|---|---|---|
| **stable** | `vX.Y.Z` | `Promote to stable` workflow, by hand | the latest GitHub release (`widget.js`, signed server tarball) and the `stable` branch | live sites, standalone hosts on the stable channel, Cloudflare self-hosters |
| **dev** | `vX.Y.Z-dev.N` | every merge to `main` | a GitHub prerelease (`widget.js`, signed server tarball) | staging hosts on the dev channel |

The workflows deploy nothing. A standalone host takes a release with `feedbackkit-update` ([Updating](#updating)), a Cloudflare fork with Workers Builds ([below](#cloudflare-self-hosting-updates)).

- A dev build after a stable release takes the next patch by itself (`v0.1.0` → `v0.1.1-dev.1`).
  A new minor or major line starts once via the `Release (dev channel)` workflow's `bump`
  input; later dev builds stay on it.
- A dev build sorts below the stable release of the same version. GitHub keeps the newest
  three dev prereleases; promoting a version removes its dev builds.
- `/diag` reports `version` and `channel`; the widget logs its release with `?fkdebug=1`.

## How an embedding app picks a channel

The channel is the gateway URL in the snippet. Production points at a gateway on the stable
channel, the app's preview environment at a staging gateway that follows dev
(`feedbackkit-update --auto on --channel dev`), for example:

```html
<!-- production -->
<script src="https://<gateway>/widget.js" data-project="fk_pub_…"></script>
<!-- preview / staging -->
<script src="https://<staging-gateway>/widget.js" data-project="fk_pub_…"></script>
```

Two gateways keep their own projects, so the staging gateway needs the project imported too
(`feedbackkit-admin import`). Within a channel the widget is evergreen: it
is served with `Cache-Control: max-age=0, must-revalidate`, so every page load after a release
gets it. `?v=` in a snippet does not pin a version.

## Releasing (maintainers)

1. Merge to `main`. `Release (dev channel)` builds `vX.Y.Z-dev.N`, starts the unpacked server
   tarball and checks its `/diag` (`scripts/smoke-bundle.mjs`), then publishes a prerelease
   with `widget.js` and the signed tarball.
2. Test it on a staging host on the dev channel.
3. Run **Promote to stable** with that dev tag. It rebuilds the same commit as `vX.Y.Z`,
   compares the tarball with the tested one, checks it the same way, publishes the release as
   latest (notes since the previous stable) and fast-forwards the `stable` branch.

Required setup: environments `dev` and `production`, each with the secret
`FK_RELEASE_SIGNING_KEY` ([Release keys](#release-keys)); add required reviewers to
`production` to gate promotion. The workflows need no Cloudflare account.

**Delivery capability** (#109): every gateway records its release's `DELIVERY_CAPABILITY`
(`src/shared/contract.ts`) in `meta.delivery_capability`: the standalone server at start, a
Cloudflare deployment in `pnpm deploy` (`scripts/record-capability.mjs`).
Config writers accept new delivery shapes only up to that level, because stable reads the
same configs. Level 3 covers archived types (`templates[].archived`). Level 4 means the data knows accounts (schema 5): once the first owner exists `ADMIN_TOKEN` grants nothing, and an older release would honor it again, so the standalone server refuses to start below 4. No config shape needs 4. A rollback with `wrangler rollback` does not lower the value: before rolling
back past a release that raised it, check that no stored config needs the higher level
(`noIssue: true` next to `delivery` keeps older releases from opening issues).

**Migrations** must stay expand/contract: a migration may only add, and the previous release
must keep working on the new schema, so that a rollback of the code does not need a rollback
of the data.

## Rolling back

A Cloudflare deployment: `pnpm exec wrangler rollback` (previous deployment) or
`pnpm exec wrangler versions deploy <version-id>@100%` for a specific one. D1 migrations are not
rolled back; expand/contract keeps the previous code working on the newer schema.

The standalone server installed from a release tarball goes back with `feedbackkit-update --rollback`
(see [Updating](#updating)). A checkout install has no rollback command: restore the backup taken before
the update (see [SELF_HOSTING.md](SELF_HOSTING.md#data-backups-and-updates)).

## Server tarball

The standalone server ships as a tarball, so an operator installs a finished release without Git, pnpm or a compiler. Every dev build and every stable release carries three files on its GitHub release: `feedbackkit-vX.Y.Z.tar.gz`, `SHA256SUMS` and `SHA256SUMS.sig`. They are published only when the signing key of the channel is configured (see Release keys). An unsigned tarball is never attached.

- **Contents:** a single-file `server.mjs` without `node_modules`, the widget and admin assets, the migrations, the systemd unit, `feedbackkit-update`, `feedbackkit-admin` (the host commands for users), `feedbackkit-migrate.mjs` (moves a gateway from Cloudflare, see [SELF_HOSTING.md](SELF_HOSTING.md#move-from-cloudflare)), the public release keys and `bundle.json` (release, channel, schema version, delivery capability, file list). It is about 360 kB. `/diag` shows the release and channel from `bundle.json`.
- **Build:** `pnpm build:widget && pnpm build:server && pnpm build:bundle` writes `dist-bundle/`. Two builds of one release are byte-identical (`test/server-bundle.test.mjs`).
- **What was tested is what ships:** promoting a dev build rebuilds the same commit under the stable version and compares the two tarballs. They must be equal except `bundle.json` and the widget with its version stamp (`scripts/compare-bundles.mjs`), or the promotion stops before anything is published.
- **Target:** Node.js 24 or newer and the standard tools curl, tar, sha256sum and ssh-keygen. One tarball serves every Linux target.

### Release keys

`SHA256SUMS` is signed with an Ed25519 key through `ssh-keygen -Y sign` (namespace `feedbackkit-release`). A checksum detects a damaged download. The signature detects a tampered one. Each channel has its own key: stable releases carry the stable signature, dev builds the dev signature, and the update command trusts the dev key only on the dev channel and never for a stable release.

- **Public keys** are committed as `release-keys/stable.pub` and `release-keys/dev.pub` and ship in every tarball. The stable key is `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILxeMV0GhgnPRcC5a2U3Kvuka/1EcDxLGq17YHP9fjvu` with the fingerprint `SHA256:4yszmEKSSoX49kfCJkTRP6CYIaqWhU/KUMqrL55nXb0`. No release has been signed yet.
- **Private keys** are the secret `FK_RELEASE_SIGNING_KEY` of the GitHub environments `production` (stable) and `dev`. `sh scripts/gen-release-keys.sh` creates a pair and prints these steps. The maintainers keep one copy of each private key in a password manager. Nothing else stores them.
- **Verify by hand** (the first install): `ssh-keygen -Y verify -f allowed_signers -I release-stable -n feedbackkit-release -s SHA256SUMS.sig < SHA256SUMS`, where `allowed_signers` holds the line `release-stable namespaces="feedbackkit-release" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILxeMV0GhgnPRcC5a2U3Kvuka/1EcDxLGq17YHP9fjvu`.
- **Rotation:** publish a release that carries the new key list in `release-keys/` and is signed with the old key. Installs that update to it then trust the new key. Sign every later release with the new key. A release signed with the old key is refused from then on. `test/server-update.test.mjs` rehearses this ("a key rotation").
- **A lost or leaked key:** publish new keys as a new release, tell operators to verify the first install against the key in this file, and treat releases signed after the leak as untrusted.

### Updating

`feedbackkit-update` is part of every release and needs nothing beyond Node and the tools above. It makes one plain read of the GitHub Releases API and sends nothing about the installation. Nothing updates unless you run it or subscribe to a channel (below).

A tarball install also tells you on the System page when a newer release waits. The server asks the same API at most once a day (the browser never does), `FK_UPDATE_CHECK=off` turns it off ([SELF_HOSTING.md](SELF_HOSTING.md#configuration)), and the notice only points at this command.

| Command | What it does |
|---|---|
| `feedbackkit-update --check` | Prints the installed and the newest release. Exit 0 when up to date, 10 when an update waits |
| `feedbackkit-update` | Downloads the newest release of the channel, verifies signature and checksum, unpacks it, copies the data directory, switches `current`, restarts the service and waits for `/diag` to show the new release. Any failure restores the old release and its data |
| `feedbackkit-update --channel dev` | Takes dev builds as well. The default is stable, or dev when a dev build is installed |
| `feedbackkit-update --rollback` | Goes back to the previous release with the data copy taken before the update. What came in since stays in `<data dir>.after-rollback-<time>` |
| `sudo feedbackkit-update --auto on [--channel dev] [--at HH:MM]` | Subscribes: a systemd timer runs the update every night, by default at 03:30 plus up to 30 minutes of random delay. The channel is the installed one unless you name it |
| `feedbackkit-update --auto status` | Shows whether a subscription exists, its channel and time, and a release it skips |
| `sudo feedbackkit-update --auto off` | Removes the timer. Nothing updates by itself after that |

**Subscribing to a channel.** `--auto on` is off by default and changes nothing by itself. It writes `feedbackkit-update.service` and `.timer` to `/etc/systemd/system` and enables the timer. A run missed while the host was off happens at the next start. The timer calls `/opt/feedbackkit/current/feedbackkit-update --unattended`, so every update also brings the newer updater. Each run is the ordinary update: signature and checksum against the keys of the installed release, data copy, health check and automatic restore, and the dev key counts on the dev channel only. Two things differ. A release that did not start is noted in `/opt/feedbackkit/auto-skip` and not tried again every night; the next newer release is. And a failed run leaves the unit failed, so it shows in `systemctl --failed` and `journalctl -u feedbackkit-update`. A person can still run the skipped release by hand.

A subscription to the dev channel puts every merge on the host within a day. That suits a staging host or an operator who accepts that a broken build costs a restart (about 30 seconds) before it is rolled back, and it does not suit a host whose sites must never see a half-tested build. The stable channel is the careful choice.

The two newest releases stay on disk. The layout is `/opt/feedbackkit/releases/<version>/` with `current` and `previous` as links. [SELF_HOSTING.md](SELF_HOSTING.md#install-from-a-release-tarball) has the install steps.

## Cloudflare self-hosting updates

Fork the repository and connect it to Cloudflare Workers Builds with production branch
**`stable`** and build command `pnpm deploy` (it builds, applies migrations, deploys and records the delivery capability). To
update, sync the `stable` branch of your fork with upstream; Workers Builds deploys it. Read the
release notes of every version you skip.
