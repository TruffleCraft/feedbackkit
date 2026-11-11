# First stable release 0.2.0, 2026-11-11

What was run: the first promotion of a dev build to a stable release with the `Promote to stable` workflow, then the documented tarball install of that release on a clean Debian 13 LXC under real systemd. Before it, the dev build `v0.2.0-dev.1` (commit `a5e84ee`) was started as a new minor line with the dev workflow (`bump` minor), and its tarball and signature were checked.

## The release

| Check | Result |
|---|---|
| Promote workflow, input `v0.2.0-dev.1` | success: tests, build, D1 migrations (none were new since 0.1.18), deploy, smoke check, record of the delivery capability, release, tarball upload, `stable` branch moved, dev builds of 0.2.0 removed |
| Tarball compared with the tested dev tarball | `compare-bundles: the stable bundle equals the dev bundle except bundle.json and the widget stamp` |
| Release `v0.2.0` | not a draft, not a pre-release, marked latest, target `a5e84ee`. Assets: `feedbackkit-v0.2.0.tar.gz`, `SHA256SUMS`, `SHA256SUMS.sig`, `widget.js` |
| `ssh-keygen -Y verify` against `release-keys/stable.pub`, principal `release-stable`, namespace `feedbackkit-release` | `Good "feedbackkit-release" signature`, key `SHA256:4yszmEKSSoX49kfCJkTRP6CYIaqWhU/KUMqrL55nXb0` |
| The same signature against the dev key | refused (`Could not verify signature`) |
| `sha256sum -c` | `feedbackkit-v0.2.0.tar.gz: OK` |
| `bundle.json` in the tarball | release `0.2.0`, channel `stable`, commit `a5e84ee` |
| Production gateway `/diag` | `version 0.2.0`, `channel stable`, schema ok |
| `stable` branch | at `a5e84ee`. No `v0.2.0-dev.N` release is left |

## Install on a clean LXC

Unprivileged Debian 13 LXC, `nesting=0`, 2 cores, 2 GB RAM, 8 GB disk, Node.js v24.22.2 from the nodejs.org tarball with its checksum verified, no Git, no pnpm. The container was destroyed afterwards.

| Step | Result |
|---|---|
| The install steps from `docs/SELF_HOSTING.md` with `version=0.2.0` and the stable key | signature `Good`, checksum OK, service `active` |
| `/diag` | `version 0.2.0`, `channel stable`, schema ok |
| A project through the admin API | 201 |
| System page data | `update` is `state current`, `latest 0.2.0`, with the link to the release notes |
| `feedbackkit-update --check` | `Installed: 0.2.0 (stable). Newest on stable: 0.2.0. Up to date.`, exit 0 |
| Data directory | mode 700, database file mode 600, owned by the service user |
| `systemd-analyze security` | 3.7 OK |
| Reboot of the container | the service starts by itself, `/diag` shows 0.2.0 |

## What this does not cover

- An update from one stable release to the next, and a rollback on the stable channel. No newer stable release exists yet. Both ran on the dev channel ([evidence](2026-11-10-real-release-lxc.md)).
- The notice in the state "update waiting" against the real API, for the same reason.
- A cloud VPS, and a real GitHub delivery from the standalone server.

Co-created by Michel with NORA (AI Agent)
