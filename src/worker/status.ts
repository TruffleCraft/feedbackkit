import type { Env } from "./env.js";

// Instance status shared by /diag, the landing page and the admin system view.

export const VERSION = "0.0.0";

// The running release and channel (ADR-013): baked in per build by the release
// workflows via FK_RELEASE / FK_CHANNEL; VERSION is the fallback for local runs.
export const releaseOf = (env: Env) => ({ version: env.FK_RELEASE || VERSION, channel: env.FK_CHANNEL || "local" });

/** Which Worker bindings are wired up (presence only). */
export function bindingsPresence(env: Env): { DB: boolean; UPLOADS: boolean; ASSETS: boolean } {
  return {
    DB: typeof env.DB?.prepare === "function",
    UPLOADS: typeof env.UPLOADS?.get === "function",
    ASSETS: typeof env.ASSETS?.fetch === "function",
  };
}

// Non-sensitive presence booleans for /diag and the landing page: which setup
// steps are done, never the values. Any GITHUB_PAT_* secret counts — the name
// suffix is per-project config (tracker.patSecret), not fixed.
// accessTeamDomain / accessAud: Cloudflare Access sign-in for the admin (optional).
export interface SecretsPresence {
  adminToken: boolean;
  githubPat: boolean;
  llmKey: boolean;
  accessTeamDomain: boolean;
  accessAud: boolean;
}

export function secretsPresence(env: Env): SecretsPresence {
  return {
    adminToken: Boolean(env["ADMIN_TOKEN"]),
    githubPat: Object.keys(env).some((k) => k.startsWith("GITHUB_PAT_") && Boolean(env[k])),
    llmKey: Boolean(env["LLM_API_KEY"]),
    accessTeamDomain: Boolean(env["FK_ACCESS_TEAM_DOMAIN"]),
    accessAud: Boolean(env["FK_ACCESS_AUD"]),
  };
}
