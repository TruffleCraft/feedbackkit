# Run FeedbackKit on your own server

The standalone gateway runs on **Node.js 24 or newer**, with SQLite on a persistent disk. It supports the widget, admin UI, inbox, AI extraction, GitHub issue/Project delivery and attachment retention. It needs no Cloudflare account, D1 or R2.

The Cloudflare installation additionally supports OAuth/MCP through its Worker OAuth provider. Those endpoints are explicitly unavailable in the standalone server; admin and widget operation do not depend on them.

## Node.js on a server or Proxmox LXC

Use a Linux server or an unprivileged Proxmox LXC with Node.js 24+, Git and pnpm 11. A starting allocation is 1 vCPU, 1 GB RAM and persistent disk sized for your attachment retention.

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

A release tarball needs no Git, pnpm or build on the server, and `feedbackkit-update` updates and rolls it back. The first signed release does not exist yet, so until it does, use the checkout install above. The steps below are the ones that apply from then on ([release keys](RELEASES.md#release-keys)).

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

Both checks must pass before you extract anything. The unit expects Node at `/usr/bin/node`; change `ExecStart` if yours is elsewhere. `/diag` shows the release and channel. To update, run `/opt/feedbackkit/current/feedbackkit-update --check`, then without `--check`. [Updating](RELEASES.md#updating) lists the commands.

## Configuration

| Variable | Purpose |
|---|---|
| `ADMIN_TOKEN` | Random secret, at least 32 characters; used only for admin access |
| `FK_PUBLIC_URL` | External origin including https scheme and optional port; used in snippets and same-origin checks |
| `FK_DATA_DIR` | Directory for `feedbackkit.sqlite`; default `./data`, systemd `/var/lib/feedbackkit` |
| `HOST`, `PORT` | Listen interface and port; defaults `127.0.0.1`, `8787` |
| `LLM_API_KEY`, `GITHUB_PAT_<name>`, `TURNSTILE_SECRET_<name>` | Optional integration secrets; project settings reference the variable names |
| `FK_TRUSTED_PROXY_HOPS` | Default 0. The number of reverse proxies in front of this server, for example 1 for one nginx or Caddy. The visitor address for rate limits and the failed-login limit is then read from `X-Forwarded-For` through that many proxies, counted from the right. With 0 every client behind a proxy shares the proxy's address, and the server logs a warning once |

Never expose a plain HTTP admin endpoint to the internet. Use HTTPS through your own reverse proxy and preserve the external Host/Origin. Incoming Cloudflare Access assertion headers are discarded by the standalone server; login uses the admin token. `FK_TRUSTED_PROXY_HOPS` is a network trust decision, not an automatic detector: set it to the real number of proxies, or a client can pick its own address. The earlier `FK_TRUST_PROXY=true` is refused at start. Request paths that start with two slashes are answered with 400, and the server builds every request URL from `FK_PUBLIC_URL`, never from the `Host` header.

For issue screenshots, set the project's public attachment base to `https://<gateway>/attachments`. Only attachments of persisted issue deliveries are served there. Inbox and GitHub Project attachments remain behind the authenticated admin asset route.

## Data, backups and updates

The database contains project settings, feedback, counters, asset metadata **and attachment bytes**. SQLite migrations apply automatically at startup. Use persistent local storage; run one server process per database. This is a single-node installation, not shared storage for multiple replicas.

Back up before an upgrade. Stop the service, copy the entire data directory, then start it again. Do not copy only the main SQLite file while the process is writing: WAL files can contain committed data. Proxmox backups should include the LXC state directory; take them with the process stopped or using a consistent snapshot strategy.

Fetch the chosen release, install with the lockfile, rebuild both bundles, then restart the service. Data migrations are expand-only; read release notes before rolling back. A release older than the data refuses to start when the data needs a newer delivery capability: start the newer release again or restore the backup.

## Verification and troubleshooting

`GET /diag` checks the database schema and runtime bindings. A healthy gateway with no projects is ready for project creation. A deep check with the admin token can verify configured integrations. A successful health check does not prove real GitHub delivery: use a neutral test report and inspect its destination.

If startup refuses `ADMIN_TOKEN`, generate a secret of at least 32 characters. For permission errors, check that the service user owns its data directory. For rejected admin writes behind a proxy, check `FK_PUBLIC_URL` against the browser's actual origin. Read process output with `journalctl -u feedbackkit`.

Co-created by Michel with NORA (AI Agent)
