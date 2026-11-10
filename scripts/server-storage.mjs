import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Implements the D1 methods used by the gateway over the same SQLite schema. */
export function openStorage(filename, migrations) {
  mkdirSync(dirname(filename), { recursive: true });
  const sqlite = new DatabaseSync(filename);
  sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
  sqlite.exec("CREATE TABLE IF NOT EXISTS _fk_migrations (name TEXT PRIMARY KEY)");
  for (const name of readdirSync(migrations).filter((n) => n.endsWith(".sql")).sort()) {
    if (sqlite.prepare("SELECT name FROM _fk_migrations WHERE name = ?").get(name)) continue;
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      sqlite.exec(readFileSync(join(migrations, name), "utf8"));
      sqlite.prepare("INSERT INTO _fk_migrations VALUES (?)").run(name);
      sqlite.exec("COMMIT");
    } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  }
  sqlite.exec("CREATE TABLE IF NOT EXISTS _fk_objects (key TEXT PRIMARY KEY, data BLOB NOT NULL, metadata TEXT NOT NULL)");
  function statement(sql, values = []) {
    const run = (method) => sqlite.prepare(sql)[method](...values);
    return {
      bind(...bound) { return statement(sql, bound); },
      async first(column) { const row = run("get"); return row ? column === undefined ? row : row[column] : null; },
      async all() { return { success: true, results: run("all"), meta: {} }; },
      async run() { const result = run("run"); return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; },
    };
  }
  const DB = { prepare: (sql) => statement(sql) };
  const UPLOADS = {
    async put(key, value, options = {}) {
      const data = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
      sqlite.prepare("INSERT INTO _fk_objects (key, data, metadata) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data=excluded.data, metadata=excluded.metadata").run(key, data, JSON.stringify(options.httpMetadata ?? {}));
    },
    async get(key) {
      const row = sqlite.prepare("SELECT data, metadata FROM _fk_objects WHERE key = ?").get(key);
      if (!row) return null;
      const bytes = new Uint8Array(row.data);
      return { body: bytes, httpMetadata: JSON.parse(row.metadata), async arrayBuffer() { return bytes.slice().buffer; } };
    },
    async delete(key) { sqlite.prepare("DELETE FROM _fk_objects WHERE key = ?").run(key); },
  };
  return { DB, UPLOADS, sqlite, close: () => sqlite.close() };
}
