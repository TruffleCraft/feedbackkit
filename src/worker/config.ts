import { FeedbackConfig } from "../shared/contract.js";
import { ConfigError } from "./errors.js";
import type { Env } from "./env.js";

export interface LoadedProject {
  config: FeedbackConfig;
  version: number;
}

interface CacheEntry {
  result: LoadedProject | null;
  at: number;
}

// Per-isolate config cache (ADR-008). Bounds staleness to TTL_MS so an admin edit
// propagates within ~60 s, while the hot /api/feedback origin check reads memory
// instead of hitting D1 on every request. D1 stays the source of truth.
// Misses are negative-cached (shorter TTL) so an attacker spraying unknown
// ?project= keys can't drive one D1 SELECT per request.
const cache = new Map<string, CacheEntry>();
const TTL_MS = 60_000;
const NEG_TTL_MS = 10_000;

/** Load a project's config by its public key. Returns null if unknown. */
export async function loadProject(
  env: Env,
  publicKey: string,
  now: number = Date.now(),
): Promise<LoadedProject | null> {
  const cached = cache.get(publicKey);
  if (cached) {
    const ttl = cached.result ? TTL_MS : NEG_TTL_MS;
    if (now - cached.at < ttl) return cached.result;
  }

  const row = await env.DB.prepare(
    "SELECT config, config_version FROM projects WHERE public_key = ?",
  )
    .bind(publicKey)
    .first<{ config: string; config_version: number }>();
  if (!row) {
    cache.set(publicKey, { result: null, at: now }); // negative-cache the miss
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.config);
  } catch {
    throw new ConfigError(`project ${publicKey}: config is not valid JSON`);
  }
  const validated = FeedbackConfig.safeParse(parsed);
  if (!validated.success) {
    throw new ConfigError(`project ${publicKey}: config failed validation: ${validated.error.message}`);
  }

  // Freeze the cached object so a future handler can't poison it for other callers.
  const result: LoadedProject = { config: Object.freeze(validated.data), version: Number(row.config_version) };
  cache.set(publicKey, { result, at: now });
  return result;
}

/** Test-only: clear the isolate cache. */
export function __clearConfigCache(): void {
  cache.clear();
}
