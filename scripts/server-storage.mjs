import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Runs `work` again while SQLite answers "database is locked". The busy timeout
 * covers most contention, but SQLite skips the busy handler when waiting could
 * deadlock, for instance when two processes switch a new file to WAL at the same
 * moment. `work` must be safe to repeat.
 */
function retryWhileLocked(work, attempts = 40) {
  for (let attempt = 1; ; attempt++) {
    try { return work(); } catch (error) {
      if (attempt >= attempts || !/database is locked|SQLITE_BUSY/i.test(String(error?.message))) throw error;
      wait(10 + Math.floor(Math.random() * 40));
    }
  }
}

/** Implements the D1 methods used by the gateway over the same SQLite schema. */
export function openStorage(filename, migrations) {
  mkdirSync(dirname(filename), { recursive: true });
  const sqlite = new DatabaseSync(filename);
  // busy_timeout comes first so that switching to WAL, creating tables and the
  // migrations wait for a second process that starts at the same moment.
  sqlite.exec("PRAGMA busy_timeout=5000");
  // auto_vacuum=INCREMENTAL lets deleted attachments give their space back. A
  // new file takes it only if it is set before the switch to WAL writes the
  // header, and a database that already has tables takes it after one VACUUM.
  sqlite.exec("PRAGMA auto_vacuum=INCREMENTAL");
  retryWhileLocked(() => sqlite.exec("PRAGMA journal_mode=WAL"));
  // secure_delete zeroes the pages a delete frees.
  sqlite.exec("PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL; PRAGMA secure_delete=ON");
  retryWhileLocked(() => { if (sqlite.prepare("PRAGMA auto_vacuum").get().auto_vacuum !== 2) sqlite.exec("VACUUM"); });
  retryWhileLocked(() => sqlite.exec("CREATE TABLE IF NOT EXISTS _fk_migrations (name TEXT PRIMARY KEY)"));
  for (const name of readdirSync(migrations).filter((n) => n.endsWith(".sql")).sort()) {
    // The check sits inside the write transaction: a second process that waited
    // for the lock then sees the migration as applied instead of running it twice.
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      if (!sqlite.prepare("SELECT name FROM _fk_migrations WHERE name = ?").get(name)) {
        sqlite.exec(readFileSync(join(migrations, name), "utf8"));
        sqlite.prepare("INSERT INTO _fk_migrations VALUES (?)").run(name);
      }
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
    async delete(key) {
      sqlite.prepare("DELETE FROM _fk_objects WHERE key = ?").run(key);
      scheduleCompact();
    },
  };
  // Deleted blobs must leave the file: hand the freed pages back and reset the
  // write-ahead log, which still holds the old page images until a checkpoint.
  // Deletes come in bursts (a sweep), so the work is coalesced.
  function compact() {
    clearTimeout(compactTimer);
    compactTimer = undefined;
    sqlite.exec("PRAGMA incremental_vacuum");
    sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  let compactTimer;
  function scheduleCompact() {
    clearTimeout(compactTimer);
    compactTimer = setTimeout(() => { try { compact(); } catch (error) { console.error("Compaction failed:", error.message); } }, 1000);
    compactTimer.unref();
  }
  return { DB, UPLOADS, sqlite, compact, close: () => { if (compactTimer) compact(); sqlite.close(); } };
}
