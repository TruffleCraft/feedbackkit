# Run FeedbackKit on your own server

The standalone gateway runs on **Node.js 24 or newer**, with SQLite on a persistent disk. It supports the widget, admin UI, inbox, AI extraction, GitHub issue/Project delivery and attachment retention. It needs no Cloudflare account, D1 or R2.

The Cloudflare installation additionally supports OAuth/MCP through its Worker OAuth provider. Those endpoints are explicitly unavailable in the standalone server; admin and widget operation do not depend on them.

## Node.js on a server or Proxmox LXC

Use a Linux server or an unprivileged Proxmox LXC with Node.js 24+, Git and pnpm 11. A starting allocation is 1 vCPU, 1 GB RAM and persistent disk sized for your attachment retention. **Docker nesting is not required** for this direct installation. No container is provisioned automatically.

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

## Docker Compose

Clone the repo, copy `.env.example` to `.env`, set `ADMIN_TOKEN` and `FK_PUBLIC_URL`, then:

```sh
docker compose up -d --build
docker compose logs --tail=50 feedbackkit
```

The container runs as a non-root user. The named volume `feedbackkit-data` stores the SQLite database and attachments under `/data`; rebuilding/restarting the image keeps it. Compose exposes `127.0.0.1:8787` on the Docker host. Connect an HTTPS reverse proxy for public access; if it runs on another host, bind to a private interface and restrict access with a firewall.

You can also run this Compose deployment inside a Proxmox LXC whose Docker nesting is configured by its operator. The direct Node installation above avoids that requirement.

The Dockerfile builds from this checkout; the repository does not require a pre-published registry image. Check out the intended release tag before building.

## Configuration

| Variable | Purpose |
|---|---|
| `ADMIN_TOKEN` | Random secret, at least 32 characters; used only for admin access |
| `FK_PUBLIC_URL` | External origin including https scheme and optional port; used in snippets and same-origin checks |
| `FK_DATA_DIR` | Directory for `feedbackkit.sqlite`; default `./data`, Docker `/data`, systemd `/var/lib/feedbackkit` |
| `HOST`, `PORT` | Listen interface and port; defaults `127.0.0.1`, `8787` (Docker listens inside the container on `0.0.0.0`) |
| `LLM_API_KEY`, `GITHUB_PAT_<name>`, `TURNSTILE_SECRET_<name>` | Optional integration secrets; project settings reference the variable names |
| `FK_TRUST_PROXY` | Default false. Set true only when all access comes through your trusted private proxy; then its `X-Forwarded-For` supplies the visitor IP for rate limits |

Never expose a plain HTTP admin endpoint to the internet. Use HTTPS through your own reverse proxy and preserve the external Host/Origin. Incoming Cloudflare Access assertion headers are discarded by the standalone server; login uses the admin token. `FK_TRUST_PROXY` is a network trust decision, not an automatic detector.

For issue screenshots, set the project's public attachment base to `https://<gateway>/attachments`. Only attachments of persisted issue deliveries are served there. Inbox and GitHub Project attachments remain behind the authenticated admin asset route.

## Data, backups and updates

The database contains project settings, feedback, counters, asset metadata **and attachment bytes**. SQLite migrations apply automatically at startup. Use persistent local storage; run one server process per database. This is a single-node installation, not shared storage for multiple replicas.

Back up before an upgrade. Stop the service/container, copy the entire data directory/volume, then start it again. Do not copy only the main SQLite file while the process is writing: WAL files can contain committed data. Proxmox backups should include the LXC state directory; take them with the process stopped or using a consistent snapshot strategy.

For a Node installation: fetch the chosen release, install with the lockfile, rebuild both bundles, then restart the service. For Docker: check out the release, then run `docker compose up -d --build`. Data migrations are expand-only; read release notes before rolling back. Do not use `docker compose down -v` unless you intend to delete the data volume.

## Verification and troubleshooting

`GET /diag` checks the database schema and runtime bindings. A healthy gateway with no projects is ready for project creation. A deep check with the admin token can verify configured integrations. A successful health check does not prove real GitHub delivery: use a neutral test report and inspect its destination.

If startup refuses `ADMIN_TOKEN`, generate a secret of at least 32 characters. For permission errors, check that the service user owns its data directory. For rejected admin writes behind a proxy, check `FK_PUBLIC_URL` against the browser's actual origin. Read process output with `journalctl -u feedbackkit` or `docker compose logs`.

Co-created by Michel with NORA (AI Agent)
