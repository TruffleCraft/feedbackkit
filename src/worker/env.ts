// Worker bindings. Adapters resolve lazily per request (Workers have no env at
// module init); this type is the contract, not a constructed instance.
export interface Env {
  DB: D1Database;
  UPLOADS: R2Bucket;
  ASSETS: Fetcher;
  FK_ENV: string;
  // Secrets (set via `wrangler secret put`): ADMIN_TOKEN, GITHUB_PAT_<name>,
  // LLM_API_KEY, FEEDBACKKIT_CONFIG_JSON (optional). Indexed dynamically.
  [key: string]: unknown;
}
