# Run FeedbackKit on your own server

The standalone gateway runs on **Node.js 24 or newer**, with SQLite on a persistent disk. It supports the widget, admin UI, inbox, AI extraction, GitHub issue/Project delivery and attachment retention. It needs no Cloudflare account, D1 or R2.

The recommended install is a signed release tarball: no Git, pnpm or build on the server, and `feedbackkit-update` updates and rolls it back ([steps](#install-from-a-release-tarball)). The checkout install below is for developers and for trying a commit that is not released.

What is verified and what is not: the server and its tests run on a developer machine and in CI on Node 24 and 26, and the steps below ran on a clean, unprivileged Debian 13 LXC without nesting, including systemd, a crash and a reboot. The release tarball path ran there too, first with fixture releases and throw-away keys (including a release whose server does not start, and a reboot), then with the real signed dev builds 0.1.19-dev.5 and 0.1.19-dev.6 from GitHub: install, `--check`, update, rollback, update again ([evidence](design/evidence/2026-11-10-real-release-lxc.md)). The signed stable release 0.2.0 then installed from GitHub on a clean LXC and survived a reboot ([evidence](design/evidence/2026-11-11-stable-release.md)). An update from one stable release to the next has not run, because no newer stable release exists yet. A real GitHub issue delivery has run from it, including an invalid token and a retry ([evidence](design/evidence/2026-11-11-github-delivery.md)); GitHub Project delivery has not. It has not been tested on a cloud VPS. [Claims and their proof](design/claims.md) lists each statement with its test.

Coming from Cloudflare? [Move from Cloudflare](#move-from-cloudflare) copies your data across.

The server also serves MCP at `/mcp`, so an agent can read projects, feedback and the funnel with the same tools and read-only scopes as on Cloudflare ([MCP for agents](#mcp-for-agents)). It is on for an https `FK_PUBLIC_URL`. A person signed in with a passkey approves an OAuth connection, and a scoped API token is a bearer for gateways such as LiteLLM. It has run with the MCP SDK's own client against the release tarball on a clean Debian 13 LXC ([evidence](design/evidence/2026-11-11-mcp-accounts-tokens.md)), but not against Claude Code, claude.ai or ChatGPT, and no admin screen lists the OAuth connections yet (see [Accounts and recovery](#accounts-and-recovery)).

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

Both checks must pass before you extract anything. The unit expects Node at `/usr/bin/node`; change `ExecStart` if yours is elsewhere. `/diag` shows the release and channel, and the System page tells you when a newer release exists (`FK_UPDATE_CHECK` turns that off). To update, run `/opt/feedbackkit/current/feedbackkit-update --check`, then without `--check`. To let the host follow a channel by itself, run `sudo /opt/feedbackkit/current/feedbackkit-update --auto on`. [Updating](RELEASES.md#updating) lists the commands and what a subscription does.

## MCP for agents

The gateway serves an MCP server at `/mcp`, so Claude Code, claude.ai, ChatGPT, Hermes or a gateway such as LiteLLM can read your projects, feedback items, the widget funnel and the project configs. It is read-only. There are two ways in, and both need an account:

- **OAuth 2.1**, for a client that has a browser: the client opens a consent page of your gateway, you are signed in there with your passkey, and you click **Allow**. The agent gets `feedback:read`, `config:read` or both, an access token for an hour and a refresh token for 30 days.
- **A scoped API token** as `Authorization: Bearer fk_tok_…`, for a gateway or script without a browser flow (LiteLLM calls it `bearer_token`). An owner creates the token in the admin ([API tokens](#accounts-and-recovery)). The tools only read, so a read and a write token see the same; a token limited to some projects sees only those. This is not the MCP authorization flow, only a side door that you control and can revoke ([why](SECURITY.md#scoped-api-tokens-as-a-bearer)).

**When it is on.** MCP is on when `FK_PUBLIC_URL` is an https origin, and off when it is not. `FK_MCP=off` turns it off anyway, and `FK_MCP=on` turns it on for a test on this machine (`FK_PUBLIC_URL=http://localhost:8787`, `HOST=127.0.0.1`). The start log says which: `MCP on (issuer https://…, resource https://…/mcp)`, and `/diag` shows the same line as `mcp`. Where it is off, every `/mcp`, `/oauth/*` and `/.well-known/oauth-*` path answers 404 and says how to turn it on. The server refuses to start MCP where a sign-in would travel in clear text: an http address that is not localhost, or `HOST` open to other addresses with an http address. Before the first owner exists nothing can connect.

**What is not there yet.** No admin screen lists the OAuth connections, so a connection ends when you remove the user who approved it or its grant runs out (see [Accounts and recovery](#accounts-and-recovery) for the screens that exist). Claude Code, claude.ai and ChatGPT have not been run against it.

**Connect with OAuth.**

1. Serve the gateway over https at `FK_PUBLIC_URL` through your reverse proxy, with `FK_TRUSTED_PROXY_HOPS` set to the number of proxies. Without it every client shares the proxy's address and one failed-login limit.
2. Add the server in the client. In Claude Code:

   ```sh
   claude mcp add --transport http feedbackkit https://<your-gateway>/mcp
   ```

   Other clients take the same address as a remote MCP server or custom connector. The client must support OAuth with dynamic client registration; the gateway does not offer Client ID Metadata Documents on a standalone server.
3. The client opens the consent page in your browser. If you are not signed in it says so and where to sign in; sign in, then start again from the app. Check that the address bar shows your gateway and that the page names the app and the host the tokens go to, then click **Allow**.
4. In the client, call `whoami`, then `list_projects`.

**Connect with a token.** Point the client at `https://<your-gateway>/mcp` and send the token in the `Authorization` header. A token in the URL is ignored. `whoami` shows the token's name, its projects and when it ends. A revoked or ended token, or one whose user was removed, gets `401` from the next request on. After 30 failed tokens from one address in an hour that address gets `429`, and a valid token still works.

A page in a browser cannot call `/mcp`: the MCP SDK refuses any `Origin` that is not a localhost name, with `403`. Agents, command-line clients and gateways send no `Origin` and are not affected. A client that asks for neither scope gets `feedback:read`. One connection or token may make 1000 calls an hour. Feedback text comes from the visitors of your sites, and the tool descriptions tell the agent to treat it as data.

**Where it lives.** Clients, grants and tokens of OAuth are rows in the table `_fk_kv` of `feedbackkit.sqlite`, so backups, `feedbackkit-update` and a rollback carry them. API tokens are in the accounts tables. A release that has no MCP ignores `_fk_kv`, and the grants work again when you update. Expired rows are removed at start and every hour.

**Differences from the Cloudflare installation.**

| | Cloudflare | Standalone |
|---|---|---|
| Who may approve a connection | Whoever your Access application lets in, or a user with a session | A user with a session |
| Identity in `whoami` | The Access email, or the user's name | The user's name |
| Client registration | Dynamic, and Client ID Metadata Documents | Dynamic only |
| Storage of OAuth state | A KV namespace (`FK_OAUTH_KV_ID`) | A table in the SQLite file |
| Turned on by | Binding the KV namespace | An https `FK_PUBLIC_URL`, or `FK_MCP=on` |
| API tokens as a bearer | yes | yes |
| Limits | 1000 calls per grant or token and hour | The same, plus 30 registrations per address and hour |

### End agent connections

- **One person's connections:** remove the user in the admin. Every connection it approved answers `401` from the next call, and its tokens are revoked.
- **One token:** revoke it in the admin. It stops with the next request.
- **Every OAuth connection at once** (a client you no longer trust): stop the service, remove the grants, and start it again. The agents have to connect again. API tokens are not touched.

```sh
sudo systemctl stop feedbackkit
sudo -u feedbackkit node -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync("/var/lib/feedbackkit/feedbackkit.sqlite"); console.log(db.prepare("DELETE FROM _fk_kv WHERE key LIKE ? OR key LIKE ?").run("grant:%", "token:%").changes, "rows removed"); db.close()'
sudo systemctl start feedbackkit
```

There is no list of OAuth connections in the admin yet.

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
| `FK_MCP` | Unset: MCP is on when `FK_PUBLIC_URL` is an https origin. `off` turns it off, `on` turns it on for a test on localhost. Any other value stops the start, and so does `on` with an address that would carry a sign-in in clear text ([MCP for agents](#mcp-for-agents)) |
| `FK_TRUSTED_PROXY_HOPS` | Default 0. The number of reverse proxies in front of this server, for example 1 for one nginx or Caddy. The visitor address for rate limits and the failed-login limit is then read from `X-Forwarded-For` through that many proxies, counted from the right. With 0 every client behind a proxy shares the proxy's address, and the server logs a warning once |

Never expose a plain HTTP admin endpoint to the internet. Use HTTPS through your own reverse proxy and preserve the external Host/Origin. Incoming Cloudflare Access assertion headers are discarded by the standalone server; sign-in uses accounts with passkeys. `FK_TRUSTED_PROXY_HOPS` is a network trust decision, not an automatic detector: set it to the real number of proxies, or a client can pick its own address. The earlier `FK_TRUST_PROXY=true` is refused at start. Request paths that start with two slashes are answered with 400, and the server builds every request URL from `FK_PUBLIC_URL`, never from the `Host` header.

For issue screenshots, set the project's public attachment base to `https://<gateway>/attachments`. Only attachments of persisted issue deliveries are served there. Inbox and GitHub Project attachments remain behind the authenticated admin asset route.

## Accounts and recovery

Users replace `ADMIN_TOKEN`: two roles (owner and member), passkey sign-in, no password, no mail, no public sign-up. Each user has an account of their own, which **Your account** shows. Scripts and agents use scoped API tokens. The design and the threat model are in [design/gate2-accounts.md](design/gate2-accounts.md) and [SECURITY.md](SECURITY.md#accounts-and-sessions). The screens are part of the admin: `/admin/setup` (the page the links open), `/admin/sign-in`, `/admin/account` (your passkeys and sessions), `/admin/users` (invitations, roles, removal; the old address `/admin/accounts` redirects there) and `/admin/tokens` (API tokens). Users and tokens are for owners; a member uses the rest of the admin.

**Passkeys need HTTPS or `localhost`.** Browsers refuse WebAuthn on plain http to any other host. The relying party ID is the host name of `FK_PUBLIC_URL`, so set `FK_PUBLIC_URL` to the address people really use before the first owner enrolls, and do not change its host afterwards (a passkey belongs to the host name; use a recovery link to enroll again). An IP address cannot be a relying party ID. A server without TLS is reachable for the first setup through a tunnel: `ssh -L 8787:127.0.0.1:8787 you@host`, then `http://localhost:8787` with `FK_PUBLIC_URL=http://localhost:8787`.

**The host command.** The tarball carries `feedbackkit-admin` next to `feedbackkit-update`. Install it like the other, and run it with `sudo`:

```sh
sudo ln -s /opt/feedbackkit/current/feedbackkit-admin /usr/local/bin/feedbackkit-admin
sudo feedbackkit-admin setup-link          # link for the first owner
sudo feedbackkit-admin recovery-link       # link that replaces the owner's passkeys
sudo feedbackkit-admin users               # who can sign in, no secrets
sudo feedbackkit-admin import shop.json    # create or update a project from a config file
```

The command reads `FK_DATA_DIR` and `FK_PUBLIC_URL` from `/etc/feedbackkit.env` (which only root can read), then continues as the owner of the data directory, so the files it touches stay readable for the service. It prints the link alone on stdout (everything else goes to stderr) and never writes it anywhere. A link works once and expires after 30 minutes (`--minutes 1` to `240`). A new `setup-link` replaces an older unused one, and `setup-link` refuses once an owner exists. `recovery-link` picks the owner when there is exactly one; with several, name the user with `--user`. `accounts` and `--account` are the old names of `users` and `--user` and keep working until November 2027. A checkout install runs `node scripts/server.mjs admin setup-link`.

**Projects from the host.** `import` creates or updates a project from a config file: the JSON that `POST /api/admin/config/import` takes, checked the same way (validation, the delivery capability, a pinned `publicKey`). A re-import keeps the public key and raises `configVersion`. `-` reads the file from stdin. `--dry-run` checks the file and says whether it would create or update the project, how each type delivers and which delivery capability it needs, and writes nothing. The command reads the file before it drops root, so the file can stay where only root can read it. On stdout it prints `projectId=`, `publicKey=` and `configVersion=`; the embed snippet and the test page go to stderr. The running service picks up an update within a minute. It needs no sign-in and no API token: as with `recovery-link`, host access is the trust boundary of the installation.

```sh
sudo feedbackkit-admin import shop.json --dry-run
sudo feedbackkit-admin import - < shop.json
```

**First owner.** Run `setup-link`, open the link in the browser you will sign in with, enter a name and create a passkey, then add a second one under Your account (a security key or another device): the last passkey cannot be removed, and with only one a lost device means a recovery link. From then on `ADMIN_TOKEN` grants nothing, the server logs that it is ignored, and you can remove it from the environment file. Two browsers that open the link at the same time produce one owner.

**Recovery.** If every passkey is lost, run `recovery-link` on the host. The link replaces the user's passkeys, signs out all their sessions and **revokes the API tokens that user created**, because recovery is also the path after a lost or exposed credential; the owner creates new tokens afterwards, and the setup page says how many ended. `--keep-tokens` opts out. Tokens of other users are not touched. Recovery needs host access by design: there is no mail and no vendor to ask. Owners can invite members and renew a member's link from the admin; an owner is only ever recovered from the host.

**API tokens** are created by an owner in the admin. A token is shown once, is read-only or can write, covers all projects or a list, and ends after 1 to 365 days (90 by default). Use it as `Authorization: Bearer fk_tok_...`. A token cannot create tokens or users. Revoking takes effect on the next request.

**Behind a reverse proxy**, set `FK_TRUSTED_PROXY_HOPS` so that failed-attempt counters are per client. Without it every client shares the proxy's address; valid sign-ins and tokens still work, and failures there read as `429`.

## Data, backups and updates

The database contains project settings, feedback, counters, asset metadata **and attachment bytes**. SQLite migrations apply automatically at startup. Use persistent local storage; run one server process per database. This is a single-node installation, not shared storage for multiple replicas.

Back up before an upgrade. Stop the service, copy the entire data directory, then start it again. Do not copy only the main SQLite file while the process is writing: WAL files can contain committed data. Proxmox backups should include the LXC state directory; take them with the process stopped or using a consistent snapshot strategy.

To update a checkout install, fetch the chosen release, install with the lockfile, rebuild both bundles, then restart the service. A tarball install updates and rolls back with `feedbackkit-update` ([Updating](RELEASES.md#updating)).

To go back on a checkout install, stop the service, restore the backup you took before the update and start the older checkout. Do not start an older checkout on the data of a newer one: migrations only add, which is a rule of the repository and not something a test proves. A release older than the data refuses to start when the data needs a newer delivery capability, and says so. The first release with accounts raises it to 4: an older release would accept `ADMIN_TOKEN` again after the first owner exists, so it will not start on that data. Start the newer release again or restore the backup. `feedbackkit-update --rollback` restores the copy taken before the update, which also removes the accounts created since.

## Move from Cloudflare

You run FeedbackKit on Cloudflare and want it on your own host. `feedbackkit-migrate` copies a gateway from D1 and R2 into the standalone server's SQLite database. It ships in the release tarball and needs only Node.js 24. The export step also needs `wrangler`, signed in to your Cloudflare account, because it reads with your own login.

**What moves:** projects with their settings and settings revisions; the public project keys, so the snippets already embedded in your sites keep their `data-project`; reports with their delivery state, error and retry count; inbox state (open, done, dismissed, note); attachments; the funnel events; the delivery capability.

**What does not move:** rate-limit counters and the daily AI call count, which start at zero, and accounts, passkeys, sessions and API tokens (a passkey belongs to a host name, a token and a session to one instance). Create the first owner on the new host with `sudo feedbackkit-admin setup-link` ([accounts](#accounts-and-recovery)). Secrets: D1 holds the names of variables such as `GITHUB_PAT_<name>`, never their values, so you set those on the new host (the dry run lists them). OAuth and MCP: grants and tokens do not move, so an agent connected through `/mcp` has to connect again to the new address, and a gateway that used a token needs a new one from the new host. The admin sign-in is an account (or the `ADMIN_TOKEN` until the first owner exists) because Cloudflare Access is not part of the standalone server.

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

If startup refuses `ADMIN_TOKEN`, it is set but shorter than 32 characters: generate a longer one, or remove it and use `feedbackkit-admin setup-link`. For permission errors, check that the service user owns its data directory. For rejected admin writes behind a proxy, check `FK_PUBLIC_URL` against the browser's actual origin. Read process output with `journalctl -u feedbackkit`.

Co-created by Michel with NORA (AI Agent)
