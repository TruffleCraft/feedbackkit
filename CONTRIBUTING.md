# Contributing to FeedbackKit

> FeedbackKit is actively developed. Start with [README.md](README.md) for the product and [AGENTS.md](AGENTS.md) for coding/setup-agent guidance. The [roadmap](docs/ROADMAP.md) contains historical phase plans; linked issues record remaining acceptance criteria.

## Ideas and feature requests

- Post new ideas and feature requests in the [Ideas category](../../discussions/categories/ideas) of Discussions. Upvote the ones you want; we use the vote count to gauge demand.
- When we accept an idea, a maintainer opens an issue from the discussion and links it to its epic. Bugs still go straight to [issues](../../issues/new/choose).
- We post releases and roadmap changes in [Announcements](../../discussions/categories/announcements).
- An idea that needs a design decision first moves to a `decision` issue (see below).

## How decisions are made

Open design questions live as issues labeled [`decision`](../../issues?q=is%3Aissue+label%3Adecision) (each states a recommendation and the counter-position). Workflow: **decision issue → discussion → resolution → ADR entry in [docs/DECISIONS.md](docs/DECISIONS.md) → issue closed.** The roadmap is updated at phase exits only; epics are the living truth.

## Development

- `pnpm setup` — one-time bootstrap: creates D1/R2, asks for secrets (LLM key skippable), prints your URLs. Idempotent.
- `pnpm dev` — local worker + widget + admin with local D1/R2, local D1/R2 bindings. Seed a project and configure test integrations before exercising delivery.
- `pnpm test` / `pnpm e2e` — unit + Playwright against the local stack. **CI runs secret-free** — fork PRs get green builds.
- `pnpm deploy` — build all artifacts, apply D1 migrations, deploy. This exact command is also the Workers Builds deploy command.

## Ground rules

- **Zero-touch-code invariant:** operators never edit repo files. Anything operator-specific belongs in D1, secrets, or build variables — never hardcoded.
- Security findings from the hardening checklist each carry a test — don't remove either.
- New user-facing strings: English + German keys from the start (`en` is the default locale; `de` ships as a first-class preset).
- Conventional commits; PRs against `main`; CI must be green.
- **Title and describe what changes in this repo.** The PR title shows up unchanged in the release notes, so it names the code or docs change, not the app whose rollout prompted it. Config and rollout state of an embedding app (its D1 config, Project, test reports) goes into that app's tracking issue.

## Keep private data out

This repository is public, and a push cannot be taken back: forks, clones and caches keep what was once there.

- **Use invented data** in code, tests, fixtures, docs, screenshots, commit messages and PR text: made-up names, `example.org` addresses and coordinates with at most four decimals. Never use data of real people, customers or your own projects, and no links to agent sessions.
- **No credentials.** Tokens, keys and `.env` files stay out. Public values are fine, for example a public project key or the fingerprint of a public release key. A credential that was pushed is burned: revoke it, because removing it from the history is not enough.
- **CI scans every pull request**, forks included, with [gitleaks](https://github.com/gitleaks/gitleaks) over the history and the tree (`secrets` job, rules in `.gitleaks.toml`). A finding fails the check.
- **If the scan flags something that is fake or public by design**, add its exact value to `.gitleaks.toml` with a comment that says where it is and why it is safe. Never allow a path or a broad pattern. A test that needs the shape of a real key builds it at run time instead of committing it.
- **Issues are public too.** Do not paste tokens, personal data or screenshots with real content. Blur or replace them first.

## Security

Please report vulnerabilities privately via GitHub Security Advisories, not public issues.
