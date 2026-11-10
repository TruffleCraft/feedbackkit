# Real signed dev builds on a clean Debian LXC, 2026-11-10

What was run: the install steps of `docs/SELF_HOSTING.md` ("Install from a release tarball") and `feedbackkit-update` on a clean Debian 13 container under real systemd, against the real signed dev builds on GitHub. The earlier run used fixture releases and a stand-in API ([evidence](2026-11-10-tarball-lxc.md)). This one used `github.com` and `api.github.com`, the tarballs the dev workflow published, and the dev key that was committed in `release-keys/dev.pub`.

## Environment

Unprivileged Debian 13 LXC on a Proxmox VE 9.2 host, `nesting=0`, 2 cores, 2 GB RAM, 8 GB disk, IPv4 by DHCP. Installed by hand: `curl`, `ca-certificates`, `xz-utils`, `openssh-client`, `openssl`, `procps` and Node.js v24.22.2 from the nodejs.org tarball with its checksum verified. No Git, no pnpm, no GitHub token. The container was destroyed after the run.

Releases used: `v0.1.19-dev.5` (built from the merge of the key PR, `fb26706`) and `v0.1.19-dev.6` (built from the merge of the notice PR, `804296c`). Dev key fingerprint: `SHA256:ogXw2Hs1dsFjNhFXSWNYTm7maKOFI5XAh7Lxq1oCSkU`.

## Results

| Step | Result |
|---|---|
| Install steps from the docs with `version=0.1.19-dev.5`: download tarball, `SHA256SUMS` and signature from the release, `ssh-keygen -Y verify`, `sha256sum -c`, extract, link `current`, unit from the tarball | `Good "feedbackkit-release" signature for release-dev with ED25519 key SHA256:ogXw2Hs1dsFjNhFXSWNYTm7maKOFI5XAh7Lxq1oCSkU`, `feedbackkit-v0.1.19-dev.5.tar.gz: OK`, service `active` |
| `/diag` | `version 0.1.19-dev.5`, `channel dev`, schema ok |
| Data directory | mode 700, database file mode 600, owned by the service user |
| A project through the admin API | 201 |
| `feedbackkit-update --check` | `Installed: 0.1.19-dev.5 (dev). Newest on dev: 0.1.19-dev.6.`, exit 10. With and without `--channel dev` the answer is the same, because an install follows its own channel |
| `feedbackkit-update --channel dev` | `Signature (release-dev) and checksum are valid.` `Updated to 0.1.19-dev.6.` `/diag` shows 0.1.19-dev.6, the project is still there, `current` and `previous` point to the two releases, the data copy `/var/lib/feedbackkit.backup-0.1.19-dev.5` exists |
| System page data on 0.1.19-dev.6 | `update` is `state current`, `latest 0.1.19-dev.6`, with the link to the release notes. The gateway got it from the real Releases API |
| A second project, then `--rollback` | back on 0.1.19-dev.5 with the data of before the update. What came in since is in `/var/lib/feedbackkit.after-rollback-<time>` |
| Update again after the rollback | works: signature and checksum valid, back on 0.1.19-dev.6, the project is kept |
| `systemd-analyze security` | 3.7 OK |

Observation: the `update` field is absent on 0.1.19-dev.5, as it should be. That build is older than the notice, so it does not know the field.

## Separately, on the Mac

The same release `v0.1.19-dev.6` was downloaded and checked outside the container. `ssh-keygen -Y verify` against `release-keys/dev.pub` is good. The stable key (`release-stable`) refuses the same signature. A `SHA256SUMS` with one added line is refused (`incorrect signature`). `bundle.json` names release `0.1.19-dev.6`, channel `dev` and the commit `804296c`, and both public keys are in the tarball.

## What this does not cover

- No stable release has been signed. The promote workflow, the stable key in CI, and `feedbackkit-update` on the stable channel have not run against a real release.
- The notice in the state "update waiting" was not seen against the real API, because no release newer than 0.1.19-dev.6 existed during the run. That state is covered by the e2e test with a mocked response.
- A cloud VPS was not tested, and no real GitHub delivery was run from the standalone server.

Co-created by Michel with NORA (AI Agent)
