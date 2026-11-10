# Autonomous FeedbackKit: admin and installation sprint

## Outcome

An operator can run the complete feedback process on a Linux server or Proxmox LXC: local storage, local user accounts with passkeys, optional OIDC and local LLM extraction. Cloudflare, GitHub, remote AI and mail services are optional. Installation and configuration are documented for both humans and LLM setup agents.

## Product structure

- **Instance:** first-run owner setup, public URL/storage/retention, shared local or remote AI connections, optional GitHub/webhook connections, health and updates.
- **People and access:** invitation-only local passkey accounts, optional OIDC, project access and roles, session revocation and recovery. No public signup or mandatory email provider. One-time bootstrap proves installation control; no takeover through an unprotected first-user route.
- **Projects and types:** any number of types (Bug, Feature request or operator-defined), each with labels, guidance, fields and a destination. Stable IDs survive renaming/reordering. Instance defaults can be overridden deliberately.
- **Inbox versus log:** reports whose resolved destination is local use a simple New/In progress/Done board. GitHub issue and Project deliveries are logged, linked and retried on error; their ticket lifecycle is not mirrored.
- **Privacy:** every capture and selected image remains local until review. Solid masks are rasterized before upload, thumbnails and LLM use. Marked private elements/password fields are excluded from capture. No promise of automatic PII detection. Click journeys/video remain a separate opt-in decision.

## Related public issues

| Work package | Existing issues | Scope |
|---|---|---|
| Admin, types and first run | #55, #59, #6 | Guided project/type editors, complete setup, log/inbox boundary |
| Theme and preview | #57 | Actual widget preview, states, tokens and contrast checks |
| Independent operation and docs | #60, local portion of #3, #69, #72 | Node/LXC and Docker, local AI, human/agent start guides |
| Privacy and screenshot reliability | PII portion of #127, #128, #129 | Pre-upload masks and manual-image review; one reproduction for the two navbar reports |
| Optional delivery integrations | #58, webhook portion of #127 | Signed webhook before adding more tracker-specific adapters |

#112 is a consumer rollout after a stable gateway. #56 (GitHub App) and #61 (Cloudflare button) improve optional setup paths but do not block independent local use. #1 and #2 are not wholesale sprint commitments. #94 is praise and #107 a triage log, not implementation work. #66 needs a current-version check; #67 is a separate small marketing-page contrast fix; #95 is a separate landing-page design slice.

Reports filed in embedding-app repositories need component-level triage. Carry over a neutral summary only; do not copy account context, private attachments or unrelated host-app requests into this public repository.

## Delivery and acceptance

| Slice | Acceptance evidence | Current state on this branch |
|---|---|---|
| Standalone runtime | Real HTTP, fresh migrations, create/duplicate safety, settings conflict, persistence across restart, private images | Implemented and local integration tests passing; actual Docker/Linux-LXC deployment still to verify |
| Documentation and agent setup | Clear runtime choice, install, first report, secrets, local AI, updates and revision explanation | Drafted; complete target walkthrough still to verify |
| Admin settings foundation | Existing config validation/publication reused; field edits preserve IDs and unrelated data | Implemented from initial approved mock; superseded product navigation needs the revised mock approval |
| Global setup and account management | Passkey registration/login, recovery, invitation policy, last-owner protection, OIDC callback/state/nonce/PKCE, session revocation | Planned, not implemented; requires revised design approval and dedicated security tests |
| Inbox board and multi-type navigation | Local-only board, per-type fields/destination, GitHub links without stale status claims | Planned, not implemented; requires revised design approval |
| PII-safe capture | Assert original bytes never reach upload or AI; opaque export pixels and all input paths tested | Planned, not implemented; high-priority acceptance gate |

Use mature WebAuthn/OIDC libraries and their verified upstream instructions. Do not implement cryptographic protocols by hand. A screenshot, mock or successful build is not evidence of working authentication or privacy protection.

This PR is a reviewable foundation, not a claim that the whole sprint is complete. No production rollout or milestone closure follows from merging only a subset.

Co-created by Michel with NORA (AI Agent)
