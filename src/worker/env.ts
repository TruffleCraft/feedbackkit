import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

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
  // Optional MCP server (ADR-015): grants, clients and tokens live in this KV
  // namespace. Bound only when FK_OAUTH_KV_ID is set at build time.
  OAUTH_KV?: KVNamespace;
  // Injected per request by the OAuth provider when OAUTH_KV is bound.
  OAUTH_PROVIDER?: OAuthHelpers;
  // Secrets (set via `wrangler secret put`): ADMIN_TOKEN, GITHUB_PAT_<name>,
  // LLM_API_KEY, FEEDBACKKIT_CONFIG_JSON (optional), FK_ACCESS_TEAM_DOMAIN and
  // FK_ACCESS_AUD (optional, Cloudflare Access sign-in for the admin and for
  // MCP consent). Indexed dynamically.
  [key: string]: unknown;
}
