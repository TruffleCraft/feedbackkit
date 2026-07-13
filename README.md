# FeedbackKit

> ⚠️ **Pre-0.1 — under active development.** APIs, schema and docs are unstable. Roadmap and decisions live in this repo; nothing is announced yet.

**Self-hosted feedback gateway: complete-at-the-source user feedback → structured, agent-ready GitHub issues.**

Users love giving feedback but rarely know *what* developers need. The result: incomplete reports, frustrating back-and-forth, and devs burning time decoding vague messages. FeedbackKit closes that loop **at the source** — while the user is still on the page:

1. A **script-tag widget** (vanilla TS, Shadow DOM — works on any site) collects free-text feedback, a screenshot, and session context (browser, OS, viewport, console errors, URL) automatically.
2. **One LLM call** structures the unstructured text against the feedback types *you* define (Bug, Idea, Improvement — with required fields per type), including vision extraction from the screenshot.
3. If required details are missing, the widget shows **pre-filled follow-up fields** ("Almost done — 2 details missing") — the user completes them in seconds, or sends anyway.
4. A **structured, labeled issue** lands in your GitHub repo. Attachments included, agent-ready.

You host it yourself: **one Cloudflare Worker** (+ D1 + R2, free tiers), one `pnpm deploy`, one snippet. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the request/data flow.

## Why not …?

| | FeedbackKit | BugDrop | Sentry User Feedback | Marker.io | Formbricks |
|---|---|---|---|---|---|
| Sync LLM follow-up **before** the issue exists | ✅ | ❌ | ❌ | ❌ | ❌ |
| Per-project feedback types with required fields | ✅ | ❌ | ❌ | ✅ | ✅ |
| Self-hosted, no SaaS | ✅ | ✅ | ❌ | ❌ | ✅ |
| No session replay / surveillance | ✅ | ✅ | ❌ | ❌ | ✅ |
| Local/private LLM capable (OpenAI-compatible endpoint) | ✅ (P5) | — | ❌ | ❌ | — |
| LLM optional (kill switch → plain required-field forms) | ✅ | — | — | — | — |

Honest note: if you just want screenshots → GitHub issues with zero infrastructure, [BugDrop](https://bugdrop.dev/) is excellent. FeedbackKit is for teams that want **complete** feedback (LLM follow-up + session context), their own feedback types, multi-project routing, and privacy-first self-hosting.

## What the widget measures

Anonymous, content-free funnel events only (`opened → typed → submitted → completed`): no session replay, no keystrokes, no stable user IDs, no IP persistence. Console errors are PII-filtered client-side. Details in [SECURITY.md](docs/SECURITY.md) (from P1).

## Roadmap & status

The development roadmap lives at [docs/ROADMAP.md](docs/ROADMAP.md). Progress is tracked via [milestones](../../milestones) (P1–P2 committed) and [epics](../../issues?q=is%3Aissue+label%3Aepic); open design decisions carry the [`decision`](../../issues?q=is%3Aissue+label%3Adecision) label — input welcome.

## License

[MIT](LICENSE)
