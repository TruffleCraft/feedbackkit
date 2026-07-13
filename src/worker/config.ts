import { FeedbackConfig } from "../shared/contract.js";
import { ConfigError } from "./errors.js";
import type { Env } from "./env.js";

export interface LoadedProject {
  config: FeedbackConfig;
  version: number;
}

interface CacheEntry extends LoadedProject {
  at: number;
}

// Per-isolate config cache (ADR-008). Bounds staleness to TTL_MS so an admin edit
// propagates within ~60 s, while the hot /api/feedback origin check reads memory
// instead of hitting D1 on every request. D1 stays the source of truth.
const cache = new Map<string, CacheEntry>();
const TTL_MS = 60_000;

/** Load a project's config by its public key. Returns null if unknown. */
export async function loadProject(
  env: Env,
  publicKey: string,
  now: number = Date.now(),
): Promise<LoadedProject | null> {
  const cached = cache.get(publicKey);
  if (cached && now - cached.at < TTL_MS) {
    return { config: cached.config, version: cached.version };
  }

  const row = await env.DB.prepare(
    "SELECT config, config_version FROM projects WHERE public_key = ?",
  )
    .bind(publicKey)
    .first<{ config: string; config_version: number }>();
  if (!row) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.config);
  } catch {
    throw new ConfigError(`project ${publicKey}: config is not valid JSON`);
  }
  const result = FeedbackConfig.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(`project ${publicKey}: config failed validation: ${result.error.message}`);
  }

  const entry: CacheEntry = { config: result.data, version: Number(row.config_version), at: now };
  cache.set(publicKey, entry);
  return { config: entry.config, version: entry.version };
}

/** Test-only: clear the isolate cache. */
export function __clearConfigCache(): void {
  cache.clear();
}
