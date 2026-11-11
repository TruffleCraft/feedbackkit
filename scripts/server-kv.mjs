import { Buffer } from "node:buffer";

// The subset of Cloudflare KV that @cloudflare/workers-oauth-provider uses, on the
// standalone server's SQLite database (the table lives beside the feedback data, so
// backup, update and rollback treat it like the rest). Nothing else may be built on
// this: it is not a general KV.
//
//   get(key)                          text, or null
//   get(key, "json" | { type: "json" })   parsed, or null
//   put(key, string, { expirationTtl, expiration, metadata })
//   delete(key)
//   list({ prefix, limit, cursor })   { keys: [{ name, metadata, expiration }], list_complete, cursor }
//
// Expiry is honored on every read and list, and sweepExpired() removes the rows (the
// server calls it hourly). The limits are KV's own, so a call that Cloudflare would
// refuse fails here too instead of passing in a test and failing in production.
// The table is expand-only: an older release ignores it, a newer one reads it again.

export const KV_MAX_KEY_BYTES = 512;
export const KV_MAX_METADATA_BYTES = 1024;
export const KV_MIN_TTL_SECONDS = 60;
export const KV_MAX_LIST_LIMIT = 1000;

const bytes = (text) => Buffer.byteLength(text, "utf8");

/**
 * @param {import("node:sqlite").DatabaseSync} sqlite
 * @param {{ now?: () => number }} [options] now returns epoch milliseconds; tests move it.
 */
export function createKv(sqlite, { now = () => Date.now() } = {}) {
  sqlite.exec("CREATE TABLE IF NOT EXISTS _fk_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, metadata TEXT, expires_at INTEGER)");
  sqlite.exec("CREATE INDEX IF NOT EXISTS _fk_kv_expires ON _fk_kv (expires_at) WHERE expires_at IS NOT NULL");
  const seconds = () => Math.floor(now() / 1000);
  const checkKey = (key) => {
    if (typeof key !== "string" || key.length === 0) throw new TypeError("KV key must be a non-empty string");
    if (bytes(key) > KV_MAX_KEY_BYTES) throw new TypeError(`KV key is longer than ${KV_MAX_KEY_BYTES} bytes`);
  };
  const live = "(expires_at IS NULL OR expires_at > ?)";
  const get = sqlite.prepare(`SELECT value FROM _fk_kv WHERE key = ? AND ${live}`);
  const put = sqlite.prepare("INSERT INTO _fk_kv (key, value, metadata, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, metadata=excluded.metadata, expires_at=excluded.expires_at");
  const del = sqlite.prepare("DELETE FROM _fk_kv WHERE key = ?");
  const sweep = sqlite.prepare("DELETE FROM _fk_kv WHERE expires_at IS NOT NULL AND expires_at <= ?");
  const page = sqlite.prepare(`SELECT key, metadata, expires_at FROM _fk_kv WHERE key >= ? AND key < ? AND key > ? AND ${live} ORDER BY key LIMIT ?`);

  return {
    async get(key, options) {
      checkKey(key);
      const type = typeof options === "string" ? options : options?.type ?? "text";
      if (type !== "text" && type !== "json") throw new TypeError(`KV get type "${type}" is not supported`);
      const row = get.get(key, seconds());
      if (!row) return null;
      return type === "json" ? JSON.parse(row.value) : row.value;
    },

    async put(key, value, options = {}) {
      checkKey(key);
      if (typeof value !== "string") throw new TypeError("KV value must be a string");
      let expiresAt = null;
      if (options.expiration !== undefined && options.expirationTtl !== undefined) throw new TypeError("KV put takes expiration or expirationTtl, not both");
      if (options.expirationTtl !== undefined) {
        if (!Number.isFinite(options.expirationTtl) || options.expirationTtl < KV_MIN_TTL_SECONDS) throw new TypeError(`KV expirationTtl must be at least ${KV_MIN_TTL_SECONDS} seconds`);
        expiresAt = seconds() + Math.ceil(options.expirationTtl);
      } else if (options.expiration !== undefined) {
        if (!Number.isFinite(options.expiration) || options.expiration < seconds() + KV_MIN_TTL_SECONDS) throw new TypeError(`KV expiration must be at least ${KV_MIN_TTL_SECONDS} seconds in the future`);
        expiresAt = Math.ceil(options.expiration);
      }
      let metadata = null;
      if (options.metadata !== undefined && options.metadata !== null) {
        metadata = JSON.stringify(options.metadata);
        if (bytes(metadata) > KV_MAX_METADATA_BYTES) throw new TypeError(`KV metadata is larger than ${KV_MAX_METADATA_BYTES} bytes`);
      }
      put.run(key, value, metadata, expiresAt);
    },

    async delete(key) {
      checkKey(key);
      del.run(key);
    },

    async list({ prefix = "", limit = KV_MAX_LIST_LIMIT, cursor } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > KV_MAX_LIST_LIMIT) throw new TypeError(`KV list limit must be an integer from 1 to ${KV_MAX_LIST_LIMIT}`);
      let after = "";
      if (cursor !== undefined && cursor !== null && cursor !== "") {
        try { after = Buffer.from(String(cursor), "base64url").toString("utf8"); } catch { throw new TypeError("KV list cursor is not valid"); }
      }
      // Keys sort by their UTF-8 bytes. U+10FFFF is the last code point, so every key that starts with the prefix is below it.
      const rows = page.all(prefix, `${prefix}\u{10FFFF}`, after, seconds(), limit + 1);
      const keys = rows.slice(0, limit).map((row) => ({
        name: row.key,
        ...(row.expires_at === null ? {} : { expiration: row.expires_at }),
        ...(row.metadata === null ? {} : { metadata: JSON.parse(row.metadata) }),
      }));
      const complete = rows.length <= limit;
      return complete ? { keys, list_complete: true, cacheStatus: null } : { keys, list_complete: false, cursor: Buffer.from(keys.at(-1).name, "utf8").toString("base64url"), cacheStatus: null };
    },

    /** Removes expired rows and returns how many went. Reads already ignore them. */
    sweepExpired() {
      return Number(sweep.run(seconds()).changes);
    },
  };
}
