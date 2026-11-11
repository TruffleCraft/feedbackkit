# FeedbackKit

Collect website feedback, ask for missing details, and deliver a report to GitHub or your own inbox.

FeedbackKit adds a small feedback widget to any website. Visitors describe a problem or idea and can attach annotated screenshots. An optional AI model extracts the details your feedback types require and asks a follow-up question before the report is sent.

**You operate the gateway and choose where the feedback goes.** No session replay, keystroke tracking or persistent visitor IDs.

## Start here

| What you want | Start with | What you need |
|---|---|---|
| Run on your own server or a Proxmox LXC | [Server installation](docs/SELF_HOSTING.md#nodejs-on-a-server-or-proxmox-lxc) | Linux, Node.js 24 or newer, persistent disk |
| Deploy on Cloudflare | [Cloudflare installation](docs/QUICKSTART.md) | Workers, D1 and R2 in your account |
| Add an already running gateway to a site | [Create a project and install the widget](docs/GETTING_STARTED.md) | Access to the gateway admin and your website |
| Change settings or understand the delivery log | [Admin guide](docs/ADMIN.md) | Admin access |

Status of the server installation: it runs from a checkout and its tests pass, and the documented install was run on a clean Debian 13 LXC, including systemd, a crash and a reboot. The release tarball and its update command ran there too, first with fixture releases, then with the signed dev builds 0.1.19-dev.5 and 0.1.19-dev.6 from GitHub (install, update, rollback), and then with the signed stable release 0.2.0 (install and reboot). An update between two stable releases has not run yet, and it was not tested on a cloud VPS. [Claims and their proof](docs/design/claims.md) lists what is verified. For the server installation, **no Cloudflare account is required**. The gateway runs on Node.js and stores project settings, reports and attachments in SQLite on your persistent disk. Cloudflare deployments use D1 and R2 instead. Both use the same widget, feedback processing and admin UI. MCP for agents (`/mcp`, OAuth 2.1, read-only) is available on the Cloudflare installation. The server installation carries its plumbing, off by default, because approving a connection needs the accounts of a later release ([MCP for agents](docs/SELF_HOSTING.md#mcp-for-agents)).

## First run on a Linux server

```sh
git clone https://github.com/TruffleCraft/feedbackkit.git
cd feedbackkit
corepack enable
pnpm install --frozen-lockfile
pnpm build:widget && pnpm build:server
cp .env.example .env
openssl rand -hex 32
```

Put the generated value in `.env` as `ADMIN_TOKEN` (it opens the admin until you create the first owner with `feedbackkit-admin setup-link`; see [accounts](docs/SELF_HOSTING.md#accounts-and-recovery)). Set `FK_PUBLIC_URL` to the address visitors will use, then start:

```sh
node --env-file=.env scripts/server.mjs
```

Open `http://localhost:8787/admin`, sign in with that token, and choose **New project**. Start with the local inbox; it needs neither GitHub credentials nor an AI service. Follow the [first-project walkthrough](docs/GETTING_STARTED.md) to install and test the widget. For public access, configure HTTPS through your reverse proxy and set `FK_TRUSTED_PROXY_HOPS`. The server binds to localhost by default. [SELF_HOSTING.md](docs/SELF_HOSTING.md) covers running it as a service.

## What happens to a report?

1. The widget collects the visitor's message, selected images and permitted page context. Automatic screenshots and console capture can be disabled per project.
2. If AI is enabled, one OpenAI-compatible API call classifies the message and extracts fields. Missing required details become a follow-up; visitors can still send an incomplete report.
3. The gateway delivers it as a **GitHub issue**, a **GitHub Project draft**, or a **report in the FeedbackKit inbox**.
4. The admin **delivery log** records delivery success, failure or an uncertain result. Retry is available where the saved delivery can be retried.

GitHub owns the lifecycle of GitHub tickets. FeedbackKit does not mirror open/closed status or comments. A log entry saying an issue was created remains true after that issue closes. Use its destination link for the current status. FeedbackKit's own Open/Done/Dismissed state applies to inbox reports.

## AI is optional

Start without AI using required-field forms. To enable it, configure the gateway's `LLM_API_KEY`, then set the project's provider, API base URL and model in **Settings → AI & follow-ups**. OpenAI-compatible gateways and privately hosted models are supported by the client; the endpoint must be reachable from the gateway. See [model setup](docs/MODELS.md).

A local model and a self-hosted gateway are separate choices: you can run either, or both, yourself.

## Setup with an AI agent

Give your coding agent [AGENTS.md](AGENTS.md) and [the agent setup guide](docs/AGENT_SETUP.md). They cover runtime selection, local AI, secret handling, safe project creation and evidence for the first working report.

## Documentation

- [Installation and first report](docs/GETTING_STARTED.md), [server and LXC operations](docs/SELF_HOSTING.md), [Cloudflare setup](docs/QUICKSTART.md)
- [Admin settings, revisions and delivery logs](docs/ADMIN.md), [release channels and updates](docs/RELEASES.md)
- [Architecture](docs/ARCHITECTURE.md), [security and retention](docs/SECURITY.md), [API errors](docs/ERRORS.md)
- [Contributing](CONTRIBUTING.md), [roadmap](docs/ROADMAP.md), [open issues](https://github.com/TruffleCraft/feedbackkit/issues)

FeedbackKit is under active development. Read the release notes before upgrading; `main` is the development branch. The [release guide](docs/RELEASES.md) explains stable and development builds.

## License

[MIT](LICENSE)

Co-created by Michel with NORA (AI Agent)
