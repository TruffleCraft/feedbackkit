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
  // Secrets (set via `wrangler secret put`): ADMIN_TOKEN, GITHUB_PAT_<name>,
  // LLM_API_KEY, FEEDBACKKIT_CONFIG_JSON (optional). Indexed dynamically.
  [key: string]: unknown;
}
