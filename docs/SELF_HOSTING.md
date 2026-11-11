# Run FeedbackKit on your own server

The standalone gateway runs on **Node.js 24 or newer**, with SQLite on a persistent disk. It supports the widget, admin UI, inbox, AI extraction, GitHub issue/Project delivery and attachment retention. It needs no Cloudflare account, D1 or R2.

The recommended install is a signed release tarball: no Git, pnpm or build on the server, and `feedbackkit-update` updates and rolls it back ([steps](#install-from-a-release-tarball)). The checkout install below is for developers and for trying a commit that is not released.

What is verified and what is not: the server and its tests run on a developer machine and in CI on Node 24 and 26, and the steps below ran on a clean, unprivileged Debian 13 LXC without nesting, including systemd, a crash and a reboot. The release tarball path ran there too, first with fixture releases and throw-away keys (including a release whose server does not start, and a reboot), then with the real signed dev builds 0.1.19-dev.5 and 0.1.19-dev.6 from GitHub: install, `--check`, update, rollback, update again ([evidence](design/evidence/2026-11-10-real-release-lxc.md)). The signed stable release 0.2.0 then installed from GitHub on a clean LXC and survived a reboot ([evidence](design/evidence/2026-11-11-stable-release.md)). An update from one stable release to the next has not run, because no newer stable release exists yet. It has not been tested on a cloud VPS, and a real GitHub delivery has not been run from it. [Claims and their proof](design/claims.md) lists each statement with its test.

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

Put the random value in `.env` as `ADMIN_TOKEN` (optional since accounts exist: it opens the admin only until you create the first owner, see [Accounts and recovery](#accounts-and-recovery)); set `FK_PUBLIC_URL` to the gateway's external origin. For a local check it defaults to `http://localhost:8787`. Start it:

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
| `ADMIN_TOKEN` | Optional. A random secret of at least 32 characters. It opens the admin only until the first owner exists; after that it grants nothing and the server says so at start. The server starts without it |
| `FK_PUBLIC_URL` | External origin including https scheme and optional port; used in snippets, same-origin checks and as the **relying party of passkeys** (its host name is the passkey's RP ID, so changing the host orphans every passkey) |
| `FK_DATA_DIR` | Directory for `feedbackkit.sqlite`; default `./data`, systemd `/var/lib/feedbackkit` |
| `HOST`, `PORT` | Listen interface and port; defaults `127.0.0.1`, `8787` |
| `LLM_API_KEY`, `GITHUB_PAT_<name>`, `TURNSTILE_SECRET_<name>` | Optional integration secrets; project settings reference the variable names |
| `FK_UPDATE_CHECK` | Default `on`. On a release tarball install the System page tells you when a newer release exists. The server asks the GitHub Releases API at most once a day (once an hour after a failed check) and sends nothing about your installation. `off` turns the check and the notice off. Any other value stops the start. A checkout install never checks |
| `FK_UPDATE_API` | The releases API the notice asks. Default: this project's GitHub API. Set it for a mirror or a test |
| `FK_TRUSTED_PROXY_HOPS` | Default 0. The number of reverse proxies in front of this server, for example 1 for one nginx or Caddy. The visitor address for rate limits and the failed-login limit is then read from `X-Forwarded-For` through that many proxies, counted from the right. With 0 every client behind a proxy shares the proxy's address, and the server logs a warning once |

Never expose a plain HTTP admin endpoint to the internet. Use HTTPS through your own reverse proxy and preserve the external Host/Origin. Incoming Cloudflare Access assertion headers are discarded by the standalone server; sign-in uses accounts with passkeys. `FK_TRUSTED_PROXY_HOPS` is a network trust decision, not an automatic detector: set it to the real number of proxies, or a client can pick its own address. The earlier `FK_TRUST_PROXY=true` is refused at start. Request paths that start with two slashes are answered with 400, and the server builds every request URL from `FK_PUBLIC_URL`, never from the `Host` header.

For issue screenshots, set the project's public attachment base to `https://<gateway>/attachments`. Only attachments of persisted issue deliveries are served there. Inbox and GitHub Project attachments remain behind the authenticated admin asset route.

## Accounts and recovery

Accounts replace `ADMIN_TOKEN`: two roles (owner and member), passkey sign-in, no password, no mail, no public sign-up. Scripts and agents use scoped API tokens. The design and the threat model are in [design/gate2-accounts.md](design/gate2-accounts.md) and [SECURITY.md](SECURITY.md#accounts-and-sessions). **Status:** the account API, the host commands and their tests are in; the screens that the links open (setup, sign-in, account, accounts, tokens) come with the approved mock, so until a release ships them keep `ADMIN_TOKEN` as your way in. Release notes say when they ship.

**Passkeys need HTTPS or `localhost`.** Browsers refuse WebAuthn on plain http to any other host. The relying party ID is the host name of `FK_PUBLIC_URL`, so set `FK_PUBLIC_URL` to the address people really use before the first owner enrolls, and do not change its host afterwards (a passkey belongs to the host name; use a recovery link to enroll again). An IP address cannot be a relying party ID. A server without TLS is reachable for the first setup through a tunnel: `ssh -L 8787:127.0.0.1:8787 you@host`, then `http://localhost:8787` with `FK_PUBLIC_URL=http://localhost:8787`.

**The host command.** The tarball carries `feedbackkit-admin` next to `feedbackkit-update`. Install it like the other, and run it with `sudo`:

```sh
sudo ln -s /opt/feedbackkit/current/feedbackkit-admin /usr/local/bin/feedbackkit-admin
sudo feedbackkit-admin setup-link          # link for the first owner
sudo feedbackkit-admin recovery-link       # link that replaces the owner's passkeys
sudo feedbackkit-admin accounts            # who exists, no secrets
```

The command reads `FK_DATA_DIR` and `FK_PUBLIC_URL` from `/etc/feedbackkit.env` (which only root can read), then continues as the owner of the data directory, so the files it touches stay readable for the service. It prints the link alone on stdout (everything else goes to stderr) and never writes it anywhere. A link works once and expires after 30 minutes (`--minutes 1` to `240`). A new `setup-link` replaces an older unused one, and `setup-link` refuses once an owner exists. `recovery-link` picks the owner when there is exactly one; with several, name the account with `--account`. A checkout install runs `node scripts/server.mjs admin setup-link`.

**First owner.** Run `setup-link`, open the link in the browser you will sign in with, enter a name and create a passkey. From then on `ADMIN_TOKEN` grants nothing, the server logs that it is ignored, and you can remove it from the environment file. Two browsers that open the link at the same time produce one owner.

**Recovery.** If every passkey is lost, run `recovery-link` on the host. The link replaces the account's passkeys and signs out all its sessions. API tokens stay; review them in the admin after recovery. Recovery needs host access by design: there is no mail and no vendor to ask. Owners can invite members and renew a member's link from the admin; an owner is only ever recovered from the host.

**API tokens** are created by an owner in the admin. A token is shown once, is read-only or can write, covers all projects or a list, and ends after 1 to 365 days (90 by default). Use it as `Authorization: Bearer fk_tok_...`. A token cannot create tokens or accounts. Revoking takes effect on the next request.

**Behind a reverse proxy**, set `FK_TRUSTED_PROXY_HOPS` so that failed-attempt counters are per client. Without it every client shares the proxy's address; valid sign-ins and tokens still work, and failures there read as `429`.

## Data, backups and updates

The database contains project settings, feedback, counters, asset metadata **and attachment bytes**. SQLite migrations apply automatically at startup. Use persistent local storage; run one server process per database. This is a single-node installation, not shared storage for multiple replicas.

Back up before an upgrade. Stop the service, copy the entire data directory, then start it again. Do not copy only the main SQLite file while the process is writing: WAL files can contain committed data. Proxmox backups should include the LXC state directory; take them with the process stopped or using a consistent snapshot strategy.

To update a checkout install, fetch the chosen release, install with the lockfile, rebuild both bundles, then restart the service. A tarball install updates and rolls back with `feedbackkit-update` ([Updating](RELEASES.md#updating)).

To go back on a checkout install, stop the service, restore the backup you took before the update and start the older checkout. Do not start an older checkout on the data of a newer one: migrations only add, which is a rule of the repository and not something a test proves. A release older than the data refuses to start when the data needs a newer delivery capability, and says so. The first release with accounts raises it to 4: an older release would accept `ADMIN_TOKEN` again after the first owner exists, so it will not start on that data. Start the newer release again or restore the backup. `feedbackkit-update --rollback` restores the copy taken before the update, which also removes the accounts created since.

## Verification and troubleshooting

`GET /diag` checks the database schema and runtime bindings. A healthy gateway with no projects is ready for project creation. A deep check with the admin token can verify configured integrations. A successful health check does not prove real GitHub delivery: use a neutral test report and inspect its destination.

If startup refuses `ADMIN_TOKEN`, it is set but shorter than 32 characters: generate a longer one, or remove it and use `feedbackkit-admin setup-link`. For permission errors, check that the service user owns its data directory. For rejected admin writes behind a proxy, check `FK_PUBLIC_URL` against the browser's actual origin. Read process output with `journalctl -u feedbackkit`.

Co-created by Michel with NORA (AI Agent)
