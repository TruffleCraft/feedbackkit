# Contributing to FeedbackKit

> Pre-0.1: the codebase does not exist yet — we are iterating the [roadmap](docs/ROADMAP.md) first. Until P1 lands, contributions = discussion on issues.

## How decisions are made

Open design questions live as issues labeled [`decision`](../../issues?q=is%3Aissue+label%3Adecision) (each states a recommendation and the counter-position). Workflow: **decision issue → discussion → resolution → ADR entry in [docs/DECISIONS.md](docs/DECISIONS.md) → issue closed.** The roadmap is updated at phase exits only; epics are the living truth.

## Development (from P1)

- `pnpm setup` — one-time bootstrap: creates D1/R2, asks for secrets (LLM key skippable), prints your URLs. Idempotent.
- `pnpm dev` — local worker + widget + admin with local D1/R2, a seeded project, **mock LLM & mock GitHub** (no secrets needed).
- `pnpm test` / `pnpm test:e2e:local` — unit + Playwright against the local stack. **CI runs secret-free** — fork PRs get green builds.
- `pnpm deploy` — build all artifacts, apply D1 migrations, deploy. This exact command is also the Workers Builds deploy command.

## Ground rules

- **Zero-touch-code invariant:** operators never edit repo files. Anything operator-specific belongs in D1, secrets, or build variables — never hardcoded.
- Security findings from the hardening checklist each carry a test — don't remove either.
- New user-facing strings: English + German keys from the start (`en` is the default locale; `de` ships as a first-class preset).
- Conventional commits; PRs against `main`; CI must be green.

## Security

Please report vulnerabilities privately via GitHub Security Advisories, not public issues.
