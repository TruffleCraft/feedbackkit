import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { ConsentAuthenticator } from "./oauth/consent-identity.js";

/** What the admin notice about a newer release shows (docs/design/mockups/update-notice.md). */
export interface UpdateStatus {
  state: "available" | "current" | "failed";
  latest: string | null; // newest release of the channel, without the leading v
  url: string | null; // its release notes
  checkedAt: number; // epoch ms
  reason?: string; // state "failed" only: a short fixed phrase
}

// Worker bindings. Adapters resolve lazily per request (Workers have no env at
// module init); this type is the contract, not a constructed instance.
export interface Env {
  DB: D1Database;
  UPLOADS: R2Bucket;
  ASSETS: Fetcher;
  FK_ENV: string;
  WIDGET_VERSION: string;
  FK_RELEASE?: string; // semver of this build (ADR-013); unset in tests
  FK_CHANNEL?: string; // stable | dev | local
  // Set by the standalone server on installs from a release tarball (scripts/server-update-check.mjs),
  // never on Cloudflare and never on a checkout. Absent means: no notice.
  UPDATE_CHECK?: () => Promise<UpdateStatus>;
  // Optional MCP server (ADR-015): grants, clients and tokens live in this KV
  // namespace. Bound only when FK_OAUTH_KV_ID is set at build time.
  OAUTH_KV?: KVNamespace;
  // Injected per request by the OAuth provider when OAUTH_KV is bound.
  OAUTH_PROVIDER?: OAuthHelpers;
  // Who may approve an MCP connection (oauth/consent-identity.ts). Unset on the Worker, which
  // asks Cloudflare Access. The standalone server sets it. It is a function, so no process
  // environment variable can supply it.
  CONSENT_AUTHENTICATOR?: ConsentAuthenticator;
  // The standalone server's one-line answer to "is MCP on?", shown in /diag. Never set on the Worker.
  MCP_STATUS?: string;
  // Secrets (set via `wrangler secret put`): ADMIN_TOKEN, GITHUB_PAT_<name>,
  // LLM_API_KEY, FEEDBACKKIT_CONFIG_JSON (optional), FK_ACCESS_TEAM_DOMAIN and
  // FK_ACCESS_AUD (optional, Cloudflare Access sign-in for the admin and for
  // MCP consent). Indexed dynamically.
  [key: string]: unknown;
}
