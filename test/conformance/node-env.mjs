import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

// The standalone server's storage, shaped like the "cloudflare:test" module the
// durability tests in test/durable/ import. vitest.conformance.config.ts aliases
// that module to this file, so the same tests run against the real D1 and R2
// (vitest.workers.config.ts) and against SQLite (here).

// Vite 5 does not know node:sqlite as a built-in module, so Node loads the
// storage module itself (require of an ES module, Node 24) instead of vite.
const { openStorage } = createRequire(import.meta.url)("../../scripts/server-storage.mjs");

const dir = mkdtempSync(join(tmpdir(), "fk-conformance-"));
const store = openStorage(join(dir, "feedbackkit.sqlite"), "migrations");
process.on("exit", () => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

// Besides the calls the gateway makes, the tests use D1's batch and R2's list
// and multi-key delete to empty the storage between tests.
const DB = {
  prepare: store.DB.prepare,
  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  },
};
const UPLOADS = {
  ...store.UPLOADS,
  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) await store.UPLOADS.delete(key);
  },
  async list() {
    return { objects: store.sqlite.prepare("SELECT key FROM _fk_objects").all().map((row) => ({ key: row.key })) };
  },
};

export const env = { DB, UPLOADS, FK_ENV: "test", WIDGET_VERSION: "test" };
export async function applyD1Migrations() {
  /* openStorage applied the migrations */
}
