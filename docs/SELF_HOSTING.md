# Run FeedbackKit on your own server

The standalone gateway runs on **Node.js 24 or newer**, with SQLite on a persistent disk. It supports the widget, admin UI, inbox, AI extraction, GitHub issue/Project delivery and attachment retention. It needs no Cloudflare account, D1 or R2.

The recommended install is a signed release tarball: no Git, pnpm or build on the server, and `feedbackkit-update` updates and rolls it back ([steps](#install-from-a-release-tarball)). The checkout install below is for developers and for trying a commit that is not released.

What is verified and what is not: the server and its tests run on a developer machine and in CI on Node 24 and 26, and the steps below ran on a clean, unprivileged Debian 13 LXC without nesting, including systemd, a crash and a reboot. The release tarball path ran there too, first with fixture releases and throw-away keys (including a release whose server does not start, and a reboot), then with the real signed dev builds 0.1.19-dev.5 and 0.1.19-dev.6 from GitHub: install, `--check`, update, rollback, update again ([evidence](design/evidence/2026-11-10-real-release-lxc.md)). The signed stable release 0.2.0 then installed from GitHub on a clean LXC and survived a reboot ([evidence](design/evidence/2026-11-11-stable-release.md)). An update from one stable release to the next has not run, because no newer stable release exists yet. It has not been tested on a cloud VPS, and a real GitHub delivery has not been run from it. [Claims and their proof](design/claims.md) lists each statement with its test.

Coming from Cloudflare? [Move from Cloudflare](#move-from-cloudflare) copies your data across.

The Cloudflare installation additionally supports OAuth/MCP through its Worker OAuth provider. Those endpoints are explicitly unavailable in the standalone server; admin and widget operation do not depend on them.

## Node.js on a server or Proxmox LXC

Use a Linux server or an unprivileged Proxmox LXC with Node.js 24 or newer, Git and pnpm 11. A starting allocation is 1 vCPU, 1 GB RAM and persistent disk sized for your attachment retention.

Install Node.js from your distribution or the [official Node.js installation guide](https://nodejs.org/en/download). Clone the release you want under `/opt/feedbackkit`:

```sh
git clone https://github.com/TruffleCraft/feedbackkit.git /opt/feedbackkit
cd /opt/feedbackkit
corepack enable
pnpm install --frozen-lockfile
pnpm build:widget
pnpm build:server
```

For an initial foreground check, create a protected environment file:

```sh
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
```

Put the random value in `.env` as `ADMIN_TOKEN`; set `FK_PUBLIC_URL` to the gateway's external origin. For a local check it defaults to `http://localhost:8787`. Start it:

```sh
node --env-file=.env scripts/server.mjs
```

Visit `/diag` and `/admin`. [Create a project and test the widget](GETTING_STARTED.md). The process binds to `127.0.0.1:8787` unless `HOST` is set. If your TLS reverse proxy is outside the LXC, set `HOST=0.0.0.0` and restrict the port to that proxy using your firewall.

### Keep it running with systemd

Create a dedicated `feedbackkit` system user. Copy your environment file to `/etc/feedbackkit.env`, owned by root and readable only by root. Copy [`deploy/feedbackkit.service`](../deploy/feedbackkit.service) to `/etc/systemd/system/feedbackkit.service`. Its defaults expect `/opt/feedbackkit` and `/usr/bin/node`; adjust the Node binary path if your installation differs.

```sh
sudo useradd --system --home-dir /var/lib/feedbackkit --shell /usr/sbin/nologin feedbackkit
sudo install -m 600 -o root -g root .env /etc/feedbackkit.env
sudo install -m 644 deploy/feedbackkit.service /etc/systemd/system/feedbackkit.service
sudo systemctl daemon-reload
sudo systemctl enable --now feedbackkit
sudo systemctl status feedbackkit
```

systemd creates `/var/lib/feedbackkit` for persistent data. The service user needs read access to the built checkout; it writes only to its state directory. The service uses an hourly retention sweep, and also sweeps on startup.

## Install from a release tarball

A release tarball needs no Git, pnpm or build on the server, and `feedbackkit-update` updates and rolls it back. This is the recommended install. The newest stable release is on the [releases page](https://github.com/TruffleCraft/feedbackkit/releases/latest), and the steps below use its version and the stable key ([release keys](RELEASES.md#release-keys)). To try a dev build instead, use its version, the principal `release-dev` and the dev key in `release-keys/dev.pub`.

You need Node.js 24 or newer, curl, tar, sha256sum and ssh-keygen. Create the system user as in the systemd section, then:

```sh
version=X.Y.Z                      # the newest stable release
base=https://github.com/TruffleCraft/feedbackkit/releases/download/v$version
cd /tmp
curl -fsSLO "$base/feedbackkit-v$version.tar.gz" -O "$base/SHA256SUMS" -O "$base/SHA256SUMS.sig"
# allowed_signers holds one line: release-stable namespaces="feedbackkit-release" ssh-ed25519 <the stable key from RELEASES.md>
ssh-keygen -Y verify -f allowed_signers -I release-stable -n feedbackkit-release -s SHA256SUMS.sig < SHA256SUMS
sha256sum -c --ignore-missing SHA256SUMS
sudo mkdir -p /opt/feedbackkit/releases
sudo tar -xzf "feedbackkit-v$version.tar.gz" -C /opt/feedbackkit/releases
sudo mv "/opt/feedbackkit/releases/feedbackkit-v$version" "/opt/feedbackkit/releases/$version"
sudo ln -s "releases/$version" /opt/feedbackkit/current
sudo install -m 600 -o root -g root .env /etc/feedbackkit.env      # as in the checkout install
sudo install -m 644 /opt/feedbackkit/current/deploy/feedbackkit.service /etc/systemd/system/feedbackkit.service
sudo systemctl daemon-reload && sudo systemctl enable --now feedbackkit
```

Both checks must pass before you extract anything. The unit expects Node at `/usr/bin/node`; change `ExecStart` if yours is elsewhere. `/diag` shows the release and channel, and the System page tells you when a newer release exists (`FK_UPDATE_CHECK` turns that off). To update, run `/opt/feedbackkit/current/feedbackkit-update --check`, then without `--check`. [Updating](RELEASES.md#updating) lists the commands.

## Configuration

| Variable | Purpose |
|---|---|
| `ADMIN_TOKEN` | Random secret, at least 32 characters; used only for admin access |
| `FK_PUBLIC_URL` | External origin including https scheme and optional port; used in snippets and same-origin checks |
| `FK_DATA_DIR` | Directory for `feedbackkit.sqlite`; default `./data`, systemd `/var/lib/feedbackkit` |
| `HOST`, `PORT` | Listen interface and port; defaults `127.0.0.1`, `8787` |
| `LLM_API_KEY`, `GITHUB_PAT_<name>`, `TURNSTILE_SECRET_<name>` | Optional integration secrets; project settings reference the variable names |
| `FK_UPDATE_CHECK` | Default `on`. On a release tarball install the System page tells you when a newer release exists. The server asks the GitHub Releases API at most once a day (once an hour after a failed check) and sends nothing about your installation. `off` turns the check and the notice off. Any other value stops the start. A checkout install never checks |
| `FK_UPDATE_API` | The releases API the notice asks. Default: this project's GitHub API. Set it for a mirror or a test |
| `FK_TRUSTED_PROXY_HOPS` | Default 0. The number of reverse proxies in front of this server, for example 1 for one nginx or Caddy. The visitor address for rate limits and the failed-login limit is then read from `X-Forwarded-For` through that many proxies, counted from the right. With 0 every client behind a proxy shares the proxy's address, and the server logs a warning once |

Never expose a plain HTTP admin endpoint to the internet. Use HTTPS through your own reverse proxy and preserve the external Host/Origin. Incoming Cloudflare Access assertion headers are discarded by the standalone server; login uses the admin token. `FK_TRUSTED_PROXY_HOPS` is a network trust decision, not an automatic detector: set it to the real number of proxies, or a client can pick its own address. The earlier `FK_TRUST_PROXY=true` is refused at start. Request paths that start with two slashes are answered with 400, and the server builds every request URL from `FK_PUBLIC_URL`, never from the `Host` header.

For issue screenshots, set the project's public attachment base to `https://<gateway>/attachments`. Only attachments of persisted issue deliveries are served there. Inbox and GitHub Project attachments remain behind the authenticated admin asset route.

## Data, backups and updates

The database contains project settings, feedback, counters, asset metadata **and attachment bytes**. SQLite migrations apply automatically at startup. Use persistent local storage; run one server process per database. This is a single-node installation, not shared storage for multiple replicas.

Back up before an upgrade. Stop the service, copy the entire data directory, then start it again. Do not copy only the main SQLite file while the process is writing: WAL files can contain committed data. Proxmox backups should include the LXC state directory; take them with the process stopped or using a consistent snapshot strategy.

To update a checkout install, fetch the chosen release, install with the lockfile, rebuild both bundles, then restart the service. A tarball install updates and rolls back with `feedbackkit-update` ([Updating](RELEASES.md#updating)).

To go back on a checkout install, stop the service, restore the backup you took before the update and start the older checkout. Do not start an older checkout on the data of a newer one: migrations only add, which is a rule of the repository and not something a test proves. A release older than the data refuses to start when the data needs a newer delivery capability, and says so. Start the newer release again or restore the backup.

## Move from Cloudflare

You run FeedbackKit on Cloudflare and want it on your own host. `feedbackkit-migrate` copies a gateway from D1 and R2 into the standalone server's SQLite database. It ships in the release tarball and needs only Node.js 24. The export step also needs `wrangler`, signed in to your Cloudflare account, because it reads with your own login.

**What moves:** projects with their settings and settings revisions; the public project keys, so the snippets already embedded in your sites keep their `data-project`; reports with their delivery state, error and retry count; inbox state (open, done, dismissed, note); attachments; the funnel events; the delivery capability.

**What does not move:** rate-limit counters and the daily AI call count, which start at zero. Secrets: D1 holds the names of variables such as `GITHUB_PAT_<name>`, never their values, so you set those on the new host (the dry run lists them). OAuth and MCP: the standalone server has neither, so a coding agent connected through `/mcp` loses that connection, and the admin sign-in is the `ADMIN_TOKEN` because Cloudflare Access is not part of the standalone server.

1. Install the release on the new host as described [above](#install-from-a-release-tarball) and do not start the service yet.
2. Export. Unpack the same tarball on a machine where wrangler is signed in to your Cloudflare account. The tool reads the database and bucket names from your fork's `wrangler.toml` (`pnpm materialize` writes it), or you pass `--bucket <your R2 bucket>` and `--database <name>`. It starts wrangler with `npx --yes wrangler`; `--wrangler "pnpm exec wrangler"` uses another command.

   ```bash
   ./feedbackkit-migrate.mjs export --config /path/to/your-fork/wrangler.toml --out ./fk-export
   ```

   The export only reads: `wrangler d1 export --remote` and `wrangler r2 object get`. Cloudflare says that a running D1 export blocks other requests to that database, so run it when the gateway is quiet. The directory holds every report and screenshot, so treat it like the database and delete it after the move.
3. Copy `fk-export` to the new host, stop the service if it runs, and import it as the service user. Run the dry run first:

   ```bash
   sudo -u feedbackkit /opt/feedbackkit/current/feedbackkit-migrate.mjs import --from ./fk-export --data-dir /var/lib/feedbackkit --dry-run
   sudo -u feedbackkit /opt/feedbackkit/current/feedbackkit-migrate.mjs import --from ./fk-export --data-dir /var/lib/feedbackkit
   ```
4. Put the secrets the dry run named into `/etc/feedbackkit.env`, start the service, and check `/diag` and the System page. A report whose delivery failed because a token was missing can be retried from the project's history once the secret is set.
5. Point your gateway's hostname at the new host. With the same hostname the embedded snippets keep working unchanged. With a new one, change the host in the snippets. Projects that deliver to GitHub issues keep their old screenshot links on your R2 public URL, so keep that bucket while those issues matter, and set the project's public attachment base to `https://<gateway>/attachments` for new reports.

You can repeat steps 2 and 3 with `--replace-existing` as often as you like before the switch, because the new host has no reports of its own yet. Reports sent to Cloudflare after an export are not in it. After the switch, do not import again.

What the import checks and refuses:

- It refuses a data directory that already holds data. `--replace-existing` replaces it and keeps a copy of the old database next to it.
- It refuses an export from a newer schema or delivery capability than the installed release knows, and brings an export from an older schema up with the migrations the server runs.
- It refuses a damaged or edited export, and an attachment whose checksum or image type is wrong.
- It writes in one transaction, compares the row count and a checksum of every table and the checksum of every attachment before it commits, and compares them again through a new connection after. A difference writes nothing.
- `--dry-run` reads the export, applies the migrations to a copy and reports counts and secret names without writing anything.

What was run: the tool, with the real wrangler, against a local D1 and R2 filled with fictional data by the Worker, then the standalone server started on the result ([evidence](design/evidence/2026-11-11-cloudflare-move.md)). It was not run against a remote Cloudflare account, because the tests never touch one. The import reads plain SQL, so run `--dry-run` on your own export first.

## Verification and troubleshooting

`GET /diag` checks the database schema and runtime bindings. A healthy gateway with no projects is ready for project creation. A deep check with the admin token can verify configured integrations. A successful health check does not prove real GitHub delivery: use a neutral test report and inspect its destination.

If startup refuses `ADMIN_TOKEN`, generate a secret of at least 32 characters. For permission errors, check that the service user owns its data directory. For rejected admin writes behind a proxy, check `FK_PUBLIC_URL` against the browser's actual origin. Read process output with `journalctl -u feedbackkit`.

Co-created by Michel with NORA (AI Agent)
