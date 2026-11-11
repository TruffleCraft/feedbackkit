# FeedbackKit for coding and setup agents

Read [README.md](README.md), then [docs/AGENT_SETUP.md](docs/AGENT_SETUP.md) before installing or configuring FeedbackKit for someone. Deployment-specific values come from the operator and the actual target, never from examples or this repository's maintainer instance.

## Runtime choices

- Node.js 24 or newer directly on Linux or Proxmox LXC: persistent SQLite, no Cloudflare account needed.
- Cloudflare Worker: D1/R2, optional Cloudflare Access and OAuth/MCP.

The standalone runtime supports the widget, admin and delivery APIs, and MCP (on for an https `FK_PUBLIC_URL`; an account's session approves OAuth connections and a scoped API token is a bearer). Do not promise feature parity beyond the [hosting guide](docs/SELF_HOSTING.md).

## Product boundaries

FeedbackKit captures and delivers reports. GitHub owns the state of GitHub issues and Project items; the delivery log is not their status mirror. Local inbox reports have their own disposition. A local LLM is independent of runtime choice: configure the gateway to call the operator's endpoint. External providers and trackers remain optional.

## Development and verification

Use pnpm from `package.json` and the existing lockfile. Work on an isolated branch/worktree. Read [CONTRIBUTING.md](CONTRIBUTING.md) and [CLAUDE.md](CLAUDE.md) for repository rules.

| Change | Checks |
|---|---|
| Shared contract or backend | `pnpm typecheck` and `pnpm test` |
| Standalone server/storage | `pnpm build:widget && pnpm build:server && pnpm test:server` |
| Admin or widget UI | `pnpm e2e`, plus a real-browser check of affected controls |
| Widget build | `pnpm build:widget && pnpm check:bundle`; commit the generated `site/src/widget-ver.ts` |
| Installation docs | Follow the relevant path on a clean instance; separate tested commands from untested target deployment |

Keep secrets and private data out of source, fixtures, logs, screenshots, exports, commit messages and PR text. Use fictional examples: made-up names, `example.org`, coordinates with at most four decimals, no agent session links. The `secrets` CI job scans every pull request ([Keep private data out](CONTRIBUTING.md#keep-private-data-out)). Do not merge UI changes or deploy to someone else's installation without the operator's approval.

## Pull requests

Follow [CONTRIBUTING.md](CONTRIBUTING.md): Conventional Commits, PRs against `main`, and a PR title that names the change in this repo. Branch names start with `feat/`, `fix/`, `docs/`, `chore/` or `refactor/`. Link the issue in the PR body (`Closes #N`, `Refs #N`, or `No issue: <reason>`). Merge only when all checks are green.

## Code Review Rules

For every review of a PR here, by a person or an agent:

- Comment on correctness and security only: bugs, broken contracts between runtimes, data that leaks into reports or logs, missing auth checks, secrets or private data in the diff.
- No style comments. Formatting and naming are not findings.
- Skip `pnpm-lock.yaml` and generated files: `site/src/widget-ver.ts`, `src/admin/settings-descriptor.json` and the rendered diagrams under `docs/design/diagrams/`.
