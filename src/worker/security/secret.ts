import type { Env } from "../env.js";
import { randomB64url } from "../auth/crypto.js";

// The instance secret keys the HMACs that must not depend on ADMIN_TOKEN: the
// hashed client addresses of the rate limiter and the signed WebAuthn
// challenges. Once the first owner exists ADMIN_TOKEN grants nothing and the
// standalone server starts without it, so the secret lives in the database
// (meta row `instance_secret`, 256 random bits, created on first use). A copy of
// the database holds it, which is no worse than the rows it protects.
//
// Create-if-absent is one statement (`ON CONFLICT DO NOTHING`), so two
// processes or isolates that start together end up reading the same value.

const cache = new WeakMap<object, string>();

export async function instanceSecret(env: Env): Promise<string> {
  const key = env.DB as unknown as object;
  const known = cache.get(key);
  if (known) return known;
  try {
    const read = () => env.DB.prepare("SELECT value FROM meta WHERE key = 'instance_secret'").first<{ value: string }>();
    let row = await read();
    if (!row?.value) {
      await env.DB.prepare("INSERT INTO meta (key, value) VALUES ('instance_secret', ?1) ON CONFLICT(key) DO NOTHING").bind(randomB64url(32)).run();
      row = await read();
    }
    if (row?.value && row.value.length >= 32) {
      cache.set(key, row.value);
      return row.value;
    }
  } catch {
    /* storage unreachable: fall through to the weaker fallback below */
  }
  // The store could not give a secret (outage, or a test double). Rate limiting must keep working, so fall back to
  // the admin token when there is one. Challenges never use this fallback (see challenge.ts).
  return typeof env.ADMIN_TOKEN === "string" && env.ADMIN_TOKEN ? env.ADMIN_TOKEN : "feedbackkit-no-instance-secret";
}

/** The stored secret only, or null when the store cannot provide one. Used where a fallback would be unsafe. */
export async function storedInstanceSecret(env: Env): Promise<string | null> {
  const s = await instanceSecret(env);
  const key = env.DB as unknown as object;
  return cache.get(key) === s ? s : null;
}
