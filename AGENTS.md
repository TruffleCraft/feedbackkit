# FeedbackKit for coding and setup agents

Read [README.md](README.md), then [docs/AGENT_SETUP.md](docs/AGENT_SETUP.md) before installing or configuring FeedbackKit for someone. Deployment-specific values come from the operator and the actual target, never from examples or this repository's maintainer instance.

## Runtime choices

- Node.js 24 or newer directly on Linux or Proxmox LXC: persistent SQLite, no Cloudflare account needed.
- Cloudflare Worker: D1/R2, optional Cloudflare Access and OAuth/MCP.

The standalone runtime supports the widget, admin and delivery APIs. Cloudflare OAuth/MCP is not implemented there. Do not promise feature parity beyond the [hosting guide](docs/SELF_HOSTING.md).

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
