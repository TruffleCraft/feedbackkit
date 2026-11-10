import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { canonicalUrl, clientAddress, readTrustedHops } from '../scripts/server-http.mjs';

const origin = new URL('https://feedback.example.org');

test('canonicalUrl keeps the host of the public origin whatever the path says', () => {
  assert.equal(canonicalUrl(origin, '/api/config', '?project=a').href, 'https://feedback.example.org/api/config?project=a');
  assert.equal(canonicalUrl(origin, '//evil.example.net/x', ''), null);
  assert.equal(canonicalUrl(origin, '/\\evil.example.net/x', ''), null);
  assert.equal(canonicalUrl(origin, '/a//b', '').host, 'feedback.example.org');
});

test('clientAddress ignores forwarding headers without trusted proxies', () => {
  assert.equal(clientAddress({ forwardedFor: '203.0.113.9', peer: '10.0.0.2', hops: 0 }), '10.0.0.2');
  assert.equal(clientAddress({ forwardedFor: undefined, peer: '::ffff:10.0.0.2', hops: 0 }), '10.0.0.2');
  assert.equal(clientAddress({ forwardedFor: undefined, peer: undefined, hops: 0 }), 'unknown');
});

test('clientAddress reads the chain from the right through the trusted hops', () => {
  // One proxy: it appended the client address, the socket peer is the proxy.
  assert.equal(clientAddress({ forwardedFor: '203.0.113.9', peer: '10.0.0.2', hops: 1 }), '203.0.113.9');
  // A client that prepends its own entries cannot change the right end.
  assert.equal(clientAddress({ forwardedFor: '198.51.100.1, 203.0.113.9', peer: '10.0.0.2', hops: 1 }), '203.0.113.9');
  // Two proxies: client, first proxy, then the socket peer is the second proxy.
  assert.equal(clientAddress({ forwardedFor: '203.0.113.9, 10.0.0.3', peer: '10.0.0.2', hops: 2 }), '203.0.113.9');
  assert.equal(clientAddress({ forwardedFor: '2001:db8::7', peer: '10.0.0.2', hops: 1 }), '2001:db8::7');
});

test('clientAddress falls back to the socket peer when the chain cannot be trusted', () => {
  assert.equal(clientAddress({ forwardedFor: undefined, peer: '10.0.0.2', hops: 1 }), '10.0.0.2');
  assert.equal(clientAddress({ forwardedFor: '203.0.113.9', peer: '10.0.0.2', hops: 3 }), '10.0.0.2');
  assert.equal(clientAddress({ forwardedFor: 'not-an-address', peer: '10.0.0.2', hops: 1 }), '10.0.0.2');
  assert.equal(clientAddress({ forwardedFor: ' , ', peer: '10.0.0.2', hops: 1 }), '10.0.0.2');
});

test('readTrustedHops accepts a small number and refuses the old switch', () => {
  assert.equal(readTrustedHops({}), 0);
  assert.equal(readTrustedHops({ FK_TRUSTED_PROXY_HOPS: '' }), 0);
  assert.equal(readTrustedHops({ FK_TRUSTED_PROXY_HOPS: '2' }), 2);
  assert.throws(() => readTrustedHops({ FK_TRUSTED_PROXY_HOPS: '-1' }), /whole number/);
  assert.throws(() => readTrustedHops({ FK_TRUSTED_PROXY_HOPS: 'one' }), /whole number/);
  assert.throws(() => readTrustedHops({ FK_TRUST_PROXY: 'true' }), /FK_TRUSTED_PROXY_HOPS/);
  assert.equal(readTrustedHops({ FK_TRUST_PROXY: 'false' }), 0);
});

async function freePort() {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise((r) => reservation.close(r));
  return port;
}

async function startServer(extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fk-edge-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const token = 'fictional-test-token-'.repeat(3);
  const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), FK_PUBLIC_URL: base, FK_DATA_DIR: dir, ADMIN_TOKEN: token, ...extraEnv };
  const child = spawn(process.execPath, ['scripts/server.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(output);
    try { if ((await fetch(`${base}/diag`)).ok) break; } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 50));
    if (i === 99) throw new Error('Server startup timed out: ' + output);
  }
  const stop = async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    rmSync(dir, { recursive: true, force: true });
  };
  return { base, token, stop, output: () => output };
}

test('a path that starts with two slashes is refused instead of replacing the origin', async () => {
  const server = await startServer();
  try {
    for (const path of ['//evil.example.net/api/admin/projects', '/\\evil.example.net/api/admin/projects']) {
      const response = await fetch(server.base + path, { headers: { Authorization: `Bearer ${server.token}` } });
      assert.equal(response.status, 400, path);
    }
    assert.equal((await fetch(server.base + '/api/admin/projects', { headers: { Authorization: `Bearer ${server.token}` } })).status, 200);
  } finally { await server.stop(); }
});

test('behind one trusted proxy the failed-login limit is per client and a client cannot choose its address', async () => {
  const server = await startServer({ FK_TRUSTED_PROXY_HOPS: '1' });
  const call = (forwardedFor, token) => fetch(server.base + '/api/admin/projects', { headers: { 'X-Forwarded-For': forwardedFor, Authorization: `Bearer ${token}` } });
  try {
    let last;
    for (let i = 0; i < 25; i++) last = await call('203.0.113.10', 'wrong-' + i);
    assert.equal(last.status, 429, 'the guessing client is limited');
    assert.equal((await call('203.0.113.11', server.token)).status, 200, 'another client with the right token is not');
    // Prepending the address of an innocent client does not move the counter.
    assert.equal((await call('203.0.113.11, 203.0.113.10', server.token)).status, 429, 'the right end of the chain decides');
  } finally { await server.stop(); }
});

test('without trusted proxies forwarding headers change nothing and the server warns once', async () => {
  const server = await startServer();
  const call = (forwardedFor, token) => fetch(server.base + '/api/admin/projects', { headers: { 'X-Forwarded-For': forwardedFor, Authorization: `Bearer ${token}` } });
  try {
    let last;
    for (let i = 0; i < 25; i++) last = await call('203.0.113.' + i, 'wrong-' + i);
    assert.equal(last.status, 429, 'every request came from the same socket address');
    assert.equal(server.output().split('FK_TRUSTED_PROXY_HOPS is 0').length - 1, 1);
  } finally { await server.stop(); }
});
