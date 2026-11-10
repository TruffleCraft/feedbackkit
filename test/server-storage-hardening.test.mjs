import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { openStorage } from '../scripts/server-storage.mjs';

const temporary = () => mkdtempSync(join(tmpdir(), 'fk-store-'));
const bytesOf = (file) => (existsSync(file) ? readFileSync(file) : Buffer.alloc(0));

test('the database keeps its safety settings', () => {
  const dir = temporary();
  const store = openStorage(join(dir, 'feedbackkit.sqlite'), 'migrations');
  try {
    const pragma = (name) => Object.values(store.sqlite.prepare(`PRAGMA ${name}`).get())[0];
    assert.equal(pragma('journal_mode'), 'wal');
    assert.equal(pragma('synchronous'), 1, 'NORMAL');
    assert.equal(pragma('secure_delete'), 1);
    assert.equal(pragma('auto_vacuum'), 2, 'INCREMENTAL');
    assert.equal(pragma('foreign_keys'), 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('an older database without auto_vacuum is converted once', () => {
  const dir = temporary();
  const file = join(dir, 'feedbackkit.sqlite');
  let store = openStorage(file, 'migrations');
  store.sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  store.close();
  // Simulate a database from before this change.
  const old = new DatabaseSync(file);
  old.exec('PRAGMA auto_vacuum=NONE; VACUUM');
  assert.equal(Object.values(old.prepare('PRAGMA auto_vacuum').get())[0], 0);
  old.close();
  store = openStorage(file, 'migrations');
  try {
    assert.equal(Object.values(store.sqlite.prepare('PRAGMA auto_vacuum').get())[0], 2);
    assert.equal((store.sqlite.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).value, '4', 'data survived the VACUUM');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a deleted attachment leaves the database file and the write-ahead log', async () => {
  const dir = temporary();
  const file = join(dir, 'feedbackkit.sqlite');
  const store = openStorage(file, 'migrations');
  const marker = 'FICTIONAL-SENTINEL-' + 'x'.repeat(40);
  const blob = Buffer.from((marker + ' ').repeat(8000)); // about 380 kB each
  try {
    for (const key of ['a/1', 'a/2', 'a/3']) await store.UPLOADS.put(key, blob, { httpMetadata: { contentType: 'image/png' } });
    store.sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const grown = statSync(file).size;
    assert.ok(grown > 1_000_000, 'the blobs are in the file');
    for (const key of ['a/1', 'a/2', 'a/3']) await store.UPLOADS.delete(key);
    assert.ok(bytesOf(file + '-wal').includes(marker), 'control: the write-ahead log still holds the old pages before compaction');
    store.compact();
    assert.ok(!bytesOf(file).includes(marker), 'the database file holds no trace');
    assert.ok(!bytesOf(file + '-wal').includes(marker), 'the log holds no trace');
    assert.ok(statSync(file).size < grown / 2, `the file shrank (${grown} to ${statSync(file).size})`);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

async function freePort() {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise((r) => reservation.close(r));
  return port;
}

async function launch(dir, extraEnv = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), FK_PUBLIC_URL: base, FK_DATA_DIR: dir, ADMIN_TOKEN: 'fictional-test-token-'.repeat(3), ...extraEnv };
  const child = spawn(process.execPath, ['scripts/server.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const exited = once(child, 'exit').then(([code]) => code);
  const ready = (async () => {
    for (let i = 0; i < 200; i++) {
      if (child.exitCode !== null) return false;
      try { if ((await fetch(`${base}/diag`)).ok) return true; } catch { /* not listening yet */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  })();
  return { base, child, output: () => output, ready, exited, stop: async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await exited; } } };
}

test('two processes that open a new database at the same instant both succeed', async () => {
  for (let trial = 0; trial < 6; trial++) {
    const dir = temporary();
    const at = String(Date.now() + 700);
    const runs = [0, 1].map(() => {
      const child = spawn(process.execPath, ['test/fixtures/open-storage-at.mjs', join(dir, 'feedbackkit.sqlite'), at], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (d) => (output += d));
      child.stderr.on('data', (d) => (output += d));
      return once(child, 'exit').then(() => output.trim());
    });
    try { assert.deepEqual(await Promise.all(runs), ['ok', 'ok'], `trial ${trial}`); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('a failing start sweep is logged and the service still starts', async () => {
  const dir = temporary();
  const store = openStorage(join(dir, 'feedbackkit.sqlite'), 'migrations');
  store.sqlite.exec('DROP TABLE assets');
  store.close();
  const server = await launch(dir);
  try {
    assert.ok(await server.ready, server.output());
    assert.match(server.output(), /Start sweep failed: .*assets/);
  } finally { await server.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('the delivery capability never goes down, and a release behind the data refuses to start', async () => {
  const dir = temporary();
  let store = openStorage(join(dir, 'feedbackkit.sqlite'), 'migrations');
  store.sqlite.exec("INSERT INTO meta (key,value) VALUES ('delivery_capability','1') ON CONFLICT(key) DO UPDATE SET value='1'");
  store.close();
  let server = await launch(dir);
  try {
    assert.ok(await server.ready, server.output());
  } finally { await server.stop(); }
  store = openStorage(join(dir, 'feedbackkit.sqlite'), 'migrations');
  assert.equal(store.sqlite.prepare("SELECT value FROM meta WHERE key='delivery_capability'").get().value, '2', 'raised to what this release provides');
  store.sqlite.exec("UPDATE meta SET value='99' WHERE key='delivery_capability'");
  store.close();
  server = await launch(dir);
  try {
    assert.equal(await Promise.race([server.exited, new Promise((r) => setTimeout(() => r('still running'), 10_000))]), 1);
    assert.match(server.output(), /needs delivery capability 99 and this release provides 2/);
    store = openStorage(join(dir, 'feedbackkit.sqlite'), 'migrations');
    assert.equal(store.sqlite.prepare("SELECT value FROM meta WHERE key='delivery_capability'").get().value, '99', 'not lowered');
    store.close();
  } finally { await server.stop(); rmSync(dir, { recursive: true, force: true }); }
});
