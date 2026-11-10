# Set up FeedbackKit for an operator

This guide is for an LLM/coding agent with terminal access. Its job is to leave a working, verified installation and a clear handoff, without guessing infrastructure details or exposing credentials.

## 1. Establish the target

Read [the README](../README.md) and the selected [hosting guide](SELF_HOSTING.md) or [Cloudflare guide](QUICKSTART.md). Confirm only information that is actually missing:

| Required decision | What to establish |
|---|---|
| Installation | Existing gateway, Linux/Proxmox LXC, or Cloudflare; who may change it |
| Addresses | Actual gateway origin and website origins; TLS/reverse-proxy arrangement |
| Persistence | Data directory/volume, service user, backup owner and storage capacity |
| Delivery | Inbox, GitHub issue or GitHub Project; defaults and overrides for each feedback type |
| AI/privacy | AI off, local endpoint or external provider; exact model ID, capture and masking requirements |

The runtime, LLM and delivery destination are separate choices. A fully local installation uses the standalone runtime, its own disk, local authentication and an AI endpoint on the operator's network, with inbox delivery. Do not enable GitHub, Turnstile, remote AI or OIDC merely because they appear in an example. Passkey/account and masking capabilities must be checked against the installed release; never claim a planned feature is available.

Inspect the current version, service and stored configuration before changing an existing installation. Do not create another gateway if the operator already has one. Use a supported release, preserve its lockfile, and report the actual tag/commit used.

## 2. Install and start

For direct Linux/LXC, install Node.js 24 or newer, clone the chosen release, run `pnpm install --frozen-lockfile`, `pnpm build:widget` and `pnpm build:server`. Follow [the systemd instructions](SELF_HOSTING.md#keep-it-running-with-systemd) for persistent operation. Cloudflare uses its own resource and migration workflow.

Generate a random `ADMIN_TOKEN` in the target's approved secret/environment store. Never print it, put it in an issue, or ask the operator to paste it into chat. The standalone service refuses tokens shorter than 32 characters. Set `FK_PUBLIC_URL` to the actual external origin, and verify data-directory permissions before startup.

Check `/diag` from the target. Schema readiness is necessary, but it is not proof that GitHub or AI calls succeed. Keep each result separate.

## 3. Create the first project without overwriting existing work

The admin UI's **New project** dialog is the simplest route. For automation, use the authenticated create-only API:

```sh
curl --fail-with-body "$GATEWAY/api/admin/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -H "Origin: $GATEWAY" \
  --data @project-create.json
```

`project-create.json` contains `{ "config": { ... } }`; start with [`config/local-example.json`](../config/local-example.json) as the inner `config` and replace the fictional project ID and website origins with the operator's confirmed values. The sample has **Bug** and **Feature request** types, AI off and local inbox delivery. A successful create returns HTTP 201, the stable public project key and settings revision 1. HTTP 409 means the project already exists: read it, do not switch to the upserting import route to force an overwrite.

For an existing project, read `GET /api/admin/projects/<id>/config`, preserve unrelated fields and the public key, validate with `POST /api/admin/projects/<id>/config/validate`, then publish with `PUT /api/admin/projects/<id>/config` carrying `{ "config": ..., "expectedVersion": ... }`. A 409 publication conflict needs a fresh read and a deliberate merge. Settings revisions are project-edit counters, not software releases.

Install the returned snippet on the confirmed website. Use only the **public project key** in the snippet; never the admin token. Keep CSP and the exact allowed origins aligned. Do not bypass a rejected origin by allowing every website.

## 4. Configure integrations and verify the actual path

For local AI, establish the endpoint's reachability **from the gateway process**, its supported vision model ID and authentication requirements. `localhost` inside an LXC refers to that LXC, not the host or another LXC. Set `llm.provider` to `custom`, its actual `baseUrl` including `/v1`, and its exact model ID. `LLM_API_KEY` stays in the gateway's secret environment. A plain-model health response does not prove image input or structured extraction; test with fictional feedback and an artificial screenshot.

For a local endpoint that does not require authentication, the current gateway still expects `LLM_API_KEY` to be present. Configure a non-secret placeholder such as `local-only` only after verifying the local endpoint accepts that header. Do not send this placeholder to a remote service or describe it as a real credential.

For GitHub, configure a narrowly scoped token in the approved environment store and use its variable **name** in project settings. Verify repository/Project access, then send one explicitly authorized neutral test report. Do not classify a successful upload as a successful delivery. Check the returned destination and the delivery log. GitHub's current open/closed state remains in GitHub.

Privacy verification must cover the transmitted bytes. Do not use real personal information in screenshots or AI tests. If the installed release cannot mask images **before upload**, tell the operator and disable image capture/uploads or withhold sensitive screenshots until that path is available. Never upload the original and redact only its displayed preview.

## 5. Leave an actionable handoff

Report the installed release, gateway/admin addresses, configured project and website origins, data/backup location and the observed result of each test. Explain how the operator signs in through the approved access path without exposing credentials. State any gaps plainly: a successful Node test is not an observed Proxmox deployment; a successful image transfer is not an observed GitHub issue.

Link [GETTING_STARTED.md](GETTING_STARTED.md), [ADMIN.md](ADMIN.md) and the relevant update instructions. List the next required action only if the operator must still do it. Do not claim account/passkey login or screenshot masking until the installed release's flow has been verified.

Co-created by Michel with NORA (AI Agent)
