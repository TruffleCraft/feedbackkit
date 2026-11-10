# Release tarball check on a clean Debian LXC, 2026-11-10

What was run: the install steps of `docs/SELF_HOSTING.md` ("Install from a release tarball") and `feedbackkit-update` on a clean Debian 13 container under real systemd, from the head of the branch `feat/standalone-release-bundle`. No real release exists yet, so the releases were fixtures: three tarballs (0.0.1, 0.0.2 and a dev build 0.0.3-dev.1) built from this commit, plus a fourth whose server does not start on purpose, all signed with throw-away Ed25519 keys and served by a small stand-in for the GitHub Releases API inside the container. No real GitHub request was made and no real key was used.

## Environment

Unprivileged Debian 13 LXC on a Proxmox VE 9.2 host, `nesting=0`, 2 cores, 2 GB RAM, 8 GB disk. Installed by hand: `curl`, `ca-certificates`, `xz-utils`, `openssh-client`, `openssl`, `procps` and Node.js v24.22.2 from the nodejs.org tarball with its checksum verified. The container was destroyed after the run.

## Results

| Step | Result |
|---|---|
| Install steps from the docs: download tarball, `SHA256SUMS`, signature. `ssh-keygen -Y verify`. `sha256sum -c`. Extract to `/opt/feedbackkit/releases`, link `current`, unit from the tarball | `Good "feedbackkit-release" signature for release-stable`, `feedbackkit-v0.0.1.tar.gz: OK`, service active |
| `/diag` | `version 0.0.1`, `channel stable`, schema ok |
| Data directory | mode 700, database file mode 600 |
| `systemd-analyze security` | 3.7 OK, against 8.3 EXPOSED for the unit of the checkout install |
| Project created, then `feedbackkit-update --check` | `Installed: 0.0.1 (stable). Newest on stable: 0.0.2.`, exit 10 |
| `feedbackkit-update` | `Signature (release-stable) and checksum are valid.` `Updated to 0.0.2.` `/diag` 0.0.2, the project is still there, `current` and `previous` point to the two releases, the data copy `var/lib/feedbackkit.backup-0.0.1` exists |
| A second project, then `--rollback` | back on 0.0.1 with the data of before the update. What came in since is kept in `/var/lib/feedbackkit.after-rollback-<time>` |
| Update again after the rollback | stopped with "releases/0.0.2 already exists" (bug 1, fixed) |
| A release whose server does not start | the update restored the old release and its data, exit 1, the service stayed active. It left the failed release on disk and dropped the link to the previous release and its older data copy (bug 2, fixed) |
| A tarball made with macOS tar (extra header entries) | the unpack left a half-unpacked release behind (bug 3, fixed: exactly one directory is required and a failed unpack is cleaned up) |
| The same cases again with the fixed script | update after rollback works, a broken release is restored and leaves no failed release and no stray data copy behind |
| `--channel dev --check` | `Newest on dev: 0.0.3-dev.1` |
| Reboot of the container | the service starts by itself, `/diag` shows 0.0.2 |

## What this does not cover

The signature and the download used fixture keys and a stand-in API. A real signed release on GitHub, the promote workflow and the signing secrets were not exercised, because no keys exist yet. A cloud VPS was not tested.

Co-created by Michel with NORA (AI Agent)
