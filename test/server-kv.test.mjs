import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../scripts/server-storage.mjs';
import { createKv, KV_MAX_KEY_BYTES, KV_MAX_METADATA_BYTES, KV_MIN_TTL_SECONDS } from '../scripts/server-kv.mjs';

// The KV the OAuth provider stores its clients, grants and tokens in, on the standalone server's SQLite file.
// test/durable/kv-contract.test.ts runs the same calls against Cloudflare's own KV; here are the parts only SQLite
// can get wrong: expiry, sweeping, the limits, and surviving a restart.

function setup(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fk-kv-'));
    const storage = openStorage(join(dir, 'feedbackkit.sqlite'), 'migrations');
    let now = 1_800_000_000_000;
    const kv = createKv(storage.sqlite, { now: () => now });
    try { await fn({ kv, storage, dir, advance: (seconds) => { now += seconds * 1000; }, at: () => now }); }
    finally { storage.close(); rmSync(dir, { recursive: true, force: true }); }
  };
}

test('get returns text or parsed JSON, and null for a missing key', setup(async ({ kv }) => {
  await kv.put('client:a', JSON.stringify({ n: 1 }));
  assert.equal(await kv.get('client:a'), '{"n":1}');
  assert.deepEqual(await kv.get('client:a', { type: 'json' }), { n: 1 });
  assert.deepEqual(await kv.get('client:a', 'json'), { n: 1 });
  assert.equal(await kv.get('client:none'), null);
  assert.equal(await kv.get('client:none', { type: 'json' }), null);
  await assert.rejects(kv.get('client:a', { type: 'stream' }), /not supported/);
}));

test('put replaces the value, the metadata and the expiry together', setup(async ({ kv, advance }) => {
  await kv.put('k', 'one', { expirationTtl: 120, metadata: { a: 1 } });
  await kv.put('k', 'two');
  advance(10_000);
  assert.equal(await kv.get('k'), 'two');
  assert.deepEqual((await kv.list()).keys, [{ name: 'k' }]);
}));

test('a key is gone once its TTL has passed, for get and for list', setup(async ({ kv, advance }) => {
  await kv.put('token:short', 'x', { expirationTtl: 60 });
  await kv.put('token:long', 'y', { expirationTtl: 3600 });
  await kv.put('token:forever', 'z');
  advance(59);
  assert.equal(await kv.get('token:short'), 'x');
  advance(1);
  assert.equal(await kv.get('token:short'), null, 'expired exactly at the TTL');
  assert.deepEqual((await kv.list({ prefix: 'token:' })).keys.map((k) => k.name), ['token:forever', 'token:long']);
  advance(3600);
  assert.equal(await kv.get('token:long'), null);
  assert.equal(await kv.get('token:forever'), 'z');
}));

test('an absolute expiration works like a TTL', setup(async ({ kv, advance, at }) => {
  await kv.put('a', '1', { expiration: Math.floor(at() / 1000) + 300 });
  advance(299);
  assert.equal(await kv.get('a'), '1');
  advance(1);
  assert.equal(await kv.get('a'), null);
}));

test('sweepExpired deletes the expired rows and keeps the rest', setup(async ({ kv, storage, advance }) => {
  await kv.put('a', '1', { expirationTtl: 60 });
  await kv.put('b', '2', { expirationTtl: 60 });
  await kv.put('c', '3', { expirationTtl: 600 });
  await kv.put('d', '4');
  const count = () => storage.sqlite.prepare('SELECT count(*) AS n FROM _fk_kv').get().n;
  assert.equal(count(), 4);
  assert.equal(kv.sweepExpired(), 0, 'nothing has expired yet');
  advance(61);
  assert.equal(count(), 4, 'expired rows stay until the sweep, but reads already ignore them');
  assert.equal(kv.sweepExpired(), 2);
  assert.equal(count(), 2);
}));

test('list pages by prefix in key order with a cursor, and reports list_complete', setup(async ({ kv }) => {
  for (const name of ['grant:u:3', 'grant:u:1', 'client:x', 'grant:v:1', 'grant:u:2', 'token:t']) await kv.put(name, name);
  const first = await kv.list({ prefix: 'grant:u:', limit: 2 });
  assert.deepEqual(first.keys.map((k) => k.name), ['grant:u:1', 'grant:u:2']);
  assert.equal(first.list_complete, false);
  const second = await kv.list({ prefix: 'grant:u:', limit: 2, cursor: first.cursor });
  assert.deepEqual(second.keys.map((k) => k.name), ['grant:u:3']);
  assert.equal(second.list_complete, true);
  assert.equal(second.cursor, undefined);
  // An exact page is complete, not "one more page".
  const exact = await kv.list({ prefix: 'grant:u:', limit: 3 });
  assert.equal(exact.keys.length, 3);
  assert.equal(exact.list_complete, true);
  assert.deepEqual((await kv.list({ prefix: 'nothing:' })).keys, []);
  assert.equal((await kv.list()).keys.length, 6, 'no prefix lists everything');
}));

test('a prefix is literal: LIKE wildcards and case do not widen it', setup(async ({ kv }) => {
  for (const name of ['a%b', 'axb', 'A_b', 'a_b', 'aXb']) await kv.put(name, '1');
  assert.deepEqual((await kv.list({ prefix: 'a%' })).keys.map((k) => k.name), ['a%b']);
  assert.deepEqual((await kv.list({ prefix: 'a_' })).keys.map((k) => k.name), ['a_b']);
  assert.deepEqual((await kv.list({ prefix: 'A' })).keys.map((k) => k.name), ['A_b']);
}));

test('list returns key metadata and expiration, and nothing for keys without them', setup(async ({ kv, at }) => {
  await kv.put('grant:u:1', '{}', { expirationTtl: 600, metadata: { clientId: 'c1' } });
  await kv.put('grant:u:2', '{}');
  assert.deepEqual((await kv.list({ prefix: 'grant:u:' })).keys, [
    { name: 'grant:u:1', expiration: Math.floor(at() / 1000) + 600, metadata: { clientId: 'c1' } },
    { name: 'grant:u:2' },
  ]);
}));

test('KV limits hold: key size, metadata size, TTL floor, one expiry kind, string values only', setup(async ({ kv }) => {
  await assert.rejects(kv.put('k'.repeat(KV_MAX_KEY_BYTES + 1), 'v'), /key is longer/);
  await kv.put('k'.repeat(KV_MAX_KEY_BYTES), 'v');
  await assert.rejects(kv.put('é'.repeat(KV_MAX_KEY_BYTES / 2 + 1), 'v'), /key is longer/, 'the limit counts bytes');
  await assert.rejects(kv.put('m', 'v', { metadata: { big: 'x'.repeat(KV_MAX_METADATA_BYTES) } }), /metadata is larger/);
  await assert.rejects(kv.put('t', 'v', { expirationTtl: KV_MIN_TTL_SECONDS - 1 }), /at least/);
  await assert.rejects(kv.put('t', 'v', { expiration: 5 }), /in the future/);
  await assert.rejects(kv.put('t', 'v', { expiration: 9e12, expirationTtl: 100 }), /not both/);
  await assert.rejects(kv.put('s', new Uint8Array(3)), /must be a string/);
  await assert.rejects(kv.put('', 'v'), /non-empty/);
  await assert.rejects(kv.list({ limit: 1001 }), /limit/);
  await assert.rejects(kv.list({ limit: 0 }), /limit/);
}));

test('rows survive a restart, and an older release that never heard of the table ignores it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fk-kv-'));
  const file = join(dir, 'feedbackkit.sqlite');
  try {
    let storage = openStorage(file, 'migrations');
    await createKv(storage.sqlite).put('grant:u:1', '{"ok":true}', { expirationTtl: 3600 });
    storage.close();
    // The release before this one: opens the file with its own code and never touches _fk_kv.
    storage = openStorage(file, 'migrations');
    assert.equal((await storage.DB.prepare("SELECT value FROM meta WHERE key='schema_version'").first()).value, '5');
    storage.close();
    storage = openStorage(file, 'migrations');
    assert.deepEqual(await createKv(storage.sqlite).get('grant:u:1', 'json'), { ok: true });
    storage.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
