# First real GitHub delivery from the standalone server, 2026-11-11

What was run: the signed stable release 0.2.0, installed with the documented tarball steps on a clean Debian 13 LXC, delivered real reports to a GitHub issue tracker. A project with `delivery: issue` pointed at a throw-away private repository. One test report and one neutral report were sent and the issues were read back from GitHub. Then the failure path ran: an invalid token, an honest failure, a retry that fails honestly, and a retry with the right token. Everything was destroyed afterwards.

## Setup

| Part | Detail |
|---|---|
| Container | Unprivileged Debian 13.6 LXC on Proxmox VE 9.2 (VMID 500), `nesting=0`, 2 cores, 2 GB RAM, 8 GB disk, IPv4 by DHCP. `curl`, `ca-certificates`, `xz-utils`, `openssh-client`, `openssl` and `procps` from apt. Node.js v24.22.2 from the nodejs.org tarball, its SHA-256 checked against `SHASUMS256.txt`. No Git, no pnpm |
| Install | The steps of `docs/SELF_HOSTING.md`, "Install from a release tarball", with `version=0.2.0`. `ssh-keygen -Y verify`: `Good "feedbackkit-release" signature for release-stable with ED25519 key SHA256:4yszmEKSSoX49kfCJkTRP6CYIaqWhU/KUMqrL55nXb0`. `sha256sum -c`: OK. Service `active`, `/diag` version `0.2.0`, channel `stable`, schema ok |
| Destination | A new private repository under a personal account, one collaborator (its owner), no labels. It existed for this run only |
| Token | A fine-grained personal access token for that repository only: Issues read and write, Metadata read-only, 7 days. It was created by the repository's owner in the GitHub web UI and stored in a password manager. The general `gh` login was not used for the delivery |
| Project | `delivery: issue`, `tracker.defaultRepo` the throw-away repository, `tracker.patSecret` `GITHUB_PAT_deliverytest`, AI off, one type `bug` |

The token reached the container through the stdin of `ssh` and `pct exec` into `/etc/feedbackkit.env` (mode 600, owner root), never as an argument and never in an output. Every read of the repository used the same narrow token through the stdin of `curl`.

What the token reaches, checked before the run:

| Request | Status |
|---|---|
| The throw-away repository | 200 |
| Its issues | 200 |
| Another private repository of the same owner | 404 |

The response header `github-authentication-token-expiration` said `2026-11-18 12:56:35 UTC`, seven days.

## Success path

| Step | Result |
|---|---|
| System page data, project check | `tracker.access` `ok: true`, status 200, `patPresent: true`, `patExpiry` 2026-11-18 |
| Admin "test report" | HTTP 200, `status: sent`, `delivery: issue`, `deliveryState: delivered`, issue #1 |
| A neutral report through the public widget API (`Origin: https://example.org`, `type: bug`) | `status: created`, issue #2 |
| The issues read back from GitHub | #1 and #2, both open, titles `[BUG] Test report from the FeedbackKit admin. It checks that reports re…` and `[BUG] Neutral test report: the page title is cut off on narrow screens.`. Body: `### Environment`, the page URL, `### Original feedback` and the message as a quote. No labels |
| Delivery log (`/api/admin/projects/<id>/feedback`) | both rows `outcome: created`, `delivery: issue`, `deliveryState: delivered`, each with its `issueUrl`, and the test report marked `isTest` |

## Failure path

| Step | Result |
|---|---|
| A random string of the token's shape put in `/etc/feedbackkit.env`, service restarted | service `active` |
| System page data | `tracker.access` `ok: false`, status 401, reason `PAT invalid or expired`. The check reports the failure, not a healthy project |
| A neutral report sent | `status: issue_failed`, reason `tracker error 401`. The report is stored |
| Delivery log | the row has `outcome: issue_failed`, `deliveryState: failed`, `issueUrl: null`, `retryable: true`. The two delivered rows are unchanged |
| Admin retry with the token still wrong | HTTP 502, `code: FK_DELIVERY_FAILED`, `error: tracker error 401`, `githubStatus: 401` |
| Service and journal | `active`, 0 restarts, `/diag` answers, no stack trace or unhandled rejection in the journal, and the token prefix appears nowhere in it |
| The right token put back, service restarted, admin retry | HTTP 200, `status: delivered`, issue #3 |
| GitHub afterwards | exactly three issues for three reports: the retry created no duplicate |

## Incidental numbers

Idle, after three reports, on this container: resident memory of the server process 88.6 MB (`VmRSS`, which counts the shared Node binary), 37.1 MB by `systemd` `MemoryCurrent`. The release directory is 740 kB, the data directory 184 kB (`feedbackkit.sqlite`, `-shm`, `-wal`). `systemd-analyze security feedbackkit` rates the unit 3.7 OK. These are one idle run, not a measurement under load.

## Afterwards

The container was stopped and destroyed with `--purge`, and no logical volume `vm-500-*` is left. The repository and its three issues were deleted, the token was deleted in GitHub (its page already said "This token does not have access to any repositories"), and the password manager item was archived. Four other tokens of the account were not touched.

## What this does not cover

- GitHub Project (draft item) delivery, and issue types, issue fields or labels. The repository was a personal one without them.
- A delivery whose outcome is uncertain, which the retry has to find again by its marker.
- The widget in a real browser. The reports came through the public API with the headers a widget sends, and the widget's behavior is covered by its own tests.
- The Cloudflare runtime. This run did not touch it.

The run found no defect, so no code changed.

Co-created by Michel with NORA (AI Agent)
