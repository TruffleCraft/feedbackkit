# Install check on a clean Debian LXC, 2026-11-10

What was run: the install path of `docs/SELF_HOSTING.md` (clone, `pnpm install`, build, systemd unit) on a clean Debian 13 container, from the head of the branch `feat/standalone-runtime-hardening` (`ab9afdf`). This is the developer install path. The release tarball does not exist yet (Step D), so the tarball path is not covered here. A cloud VPS was not tested, by decision of the owner. No GitHub token was used, so no real GitHub delivery was run.

## Environment

| Item | Value |
|---|---|
| Host | Proxmox VE 9.2 on a home network |
| Container | Debian 13 (trixie), unprivileged, `nesting=0`, 2 cores, 2 GB RAM, no swap, 8 GB disk, IPv4 by DHCP |
| Installed by hand | `curl`, `git`, `ca-certificates`, `xz-utils`, `openssl`, `procps` from apt. Node.js v24.22.2 from the nodejs.org tarball, its checksum verified. pnpm 11.5.0 through `corepack enable` |
| Nothing else | no Docker, no Cloudflare account, no GitHub token |

## Steps and results

| Step | Result |
|---|---|
| Clone the branch to `/opt/feedbackkit` | `ab9afdf` |
| `corepack enable`, `pnpm install --frozen-lockfile` | works, 52.8 s. `/opt/feedbackkit` is 575 MB afterwards, mostly development dependencies |
| `pnpm build:widget`, `pnpm build:server` | works, about 1 s |
| Foreground start with `node --env-file=.env scripts/server.mjs` | `/diag` green (`schema.ok`), `/admin` 200, `/widget.js` 200, admin API 401 without and 200 with the token, database file mode 600 |
| systemd: user, `/etc/feedbackkit.env`, unit copied, `ExecStart` pointed at `/usr/local/bin/node` as the doc says | `active (running)` with the unit's hardening (`ProtectSystem=strict`, `PrivateTmp`, `NoNewPrivileges`, `UMask=0077`) in an unprivileged container without nesting. Proxmox warns "Systemd 257 detected. You may need to enable nesting", and nothing needed it |
| Create a local-inbox project through the admin API | 201, answer carries `snippet` and `publicKey`. The public config answers 200 for an allowed origin |
| Send a test report | 200. The inbox lists 1 report with delivery `local` |
| `systemctl restart` | project and report are still there |
| `kill -9` of the process | systemd restarted it within seconds (`NRestarts` 1), the report is still there |
| Stop the service, copy the data directory, start | the copy holds only `feedbackkit.sqlite` (the write-ahead log is folded in on a clean stop), `/diag` 200 |
| Reboot of the container | the service starts by itself, the report is still there. 73 MiB of memory |
| Refusals at start | a token under 32 characters, a public URL with a path, and the old `FK_TRUST_PROXY=true` each exit with code 1 and a clear message |

## Findings

| ID | Finding |
|---|---|
| R18 | `/diag` on the standalone server lists next steps that are Cloudflare steps: `npx wrangler secret put GITHUB_PAT_default` and `docs/QUICKSTART.md` |
| R19 | The unit leaves `/var/lib/feedbackkit` at mode 755 (the files in it are 600), and `systemd-analyze security` rates the unit 8.3 EXPOSED |
| R20 | The host carries 575 MB for a gateway of a few hundred kB of code, and the install needs pnpm, a network and 53 s. This is the case for the release tarball (R17) |

Also seen: `/diag` reports version `0.0.0` and channel `local` (R17), and the unit hard-codes `/usr/bin/node`, which is where distribution packages put it and not where the nodejs.org tarball does. The doc already says to adjust it.

The container was destroyed after the run. The commands were run from the maintainer's machine over SSH with `pct exec`. The full transcripts stay in the maintainer's session, this page keeps the results.

Co-created by Michel with NORA (AI Agent)
