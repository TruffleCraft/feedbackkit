import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { buildBundle, channelOf } from '../scripts/build-bundle.mjs';

// The release tarball: built from the checkout's build output, unpacked into an empty
// directory and run there with Node alone, no node_modules and no src/.
const root = new URL('..', import.meta.url).pathname;
const temporary = () => mkdtempSync(join(tmpdir(), 'fk-bundle-'));
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

async function freePort() {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise((r) => reservation.close(r));
  return port;
}

test('the channel follows the version', () => {
  assert.equal(channelOf('1.2.3'), 'stable');
  assert.equal(channelOf('1.2.3-dev.4'), 'dev');
  assert.equal(channelOf('0.0.0-local'), 'local');
  assert.equal(channelOf('garbage'), 'local');
});

test('a bundle is byte-identical when built again, and a bad release name is refused', async () => {
  const a = temporary(), b = temporary();
  try {
    const first = await buildBundle({ root, outDir: a, release: '1.2.3-dev.4', commit: 'abc', epoch: 1_800_000_000 });
    const second = await buildBundle({ root, outDir: b, release: '1.2.3-dev.4', commit: 'abc', epoch: 1_800_000_000 });
    assert.equal(first.sha256, second.sha256);
    assert.equal(sha(join(a, first.name)), first.sha256);
    assert.equal(readFileSync(join(a, 'SHA256SUMS'), 'utf8'), `${first.sha256}  feedbackkit-v1.2.3-dev.4.tar.gz\n`);
    await assert.rejects(buildBundle({ root, outDir: a, release: 'not a version' }), /release must look like/);
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

test('the tarball unpacks with tar, lists its files in bundle.json and has no node_modules or sources', async () => {
  const out = temporary(), dest = temporary();
  try {
    const built = await buildBundle({ root, outDir: out, release: '2.0.0', commit: 'abc', epoch: 1_800_000_000 });
    execFileSync('tar', ['-xzf', join(out, built.name), '-C', dest]);
    const dir = join(dest, 'feedbackkit-v2.0.0');
    const manifest = JSON.parse(readFileSync(join(dir, 'bundle.json'), 'utf8'));
    assert.deepEqual({ release: manifest.release, channel: manifest.channel, schemaVersion: manifest.schemaVersion, node: manifest.node }, { release: '2.0.0', channel: 'stable', schemaVersion: 4, node: '>=24' });
    assert.ok(manifest.deliveryCapability >= 3);
    const listed = (path = '') => readdirSync(join(dir, path), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listed(join(path, e.name)) : [join(path, e.name)]));
    assert.deepEqual(listed().filter((f) => f !== 'bundle.json').sort(), manifest.files);
    assert.ok(!existsSync(join(dir, 'node_modules')) && !existsSync(join(dir, 'src')));
    assert.ok(statSync(join(dir, 'server.mjs')).size < 2_000_000, 'one small file');
    assert.ok(readFileSync(join(dir, 'deploy/feedbackkit.service'), 'utf8').includes('/opt/feedbackkit/current/server.mjs'));
  } finally { rmSync(out, { recursive: true, force: true }); rmSync(dest, { recursive: true, force: true }); }
});

test('the unpacked release runs with Node alone and reports its own release and channel', async () => {
  const out = temporary(), dest = temporary(), data = temporary();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`, token = 'fictional-test-token-'.repeat(3);
  let child;
  try {
    const built = await buildBundle({ root, outDir: out, release: '3.1.4-dev.2', commit: 'abc', epoch: 1_800_000_000 });
    execFileSync('tar', ['-xzf', join(out, built.name), '-C', dest]);
    const dir = join(dest, 'feedbackkit-v3.1.4-dev.2');
    // A clean environment: no repository, no node_modules, only what the unit would set.
    const env = { PATH: process.env.PATH, HOME: data, HOST: '127.0.0.1', PORT: String(port), FK_PUBLIC_URL: base, FK_DATA_DIR: data, ADMIN_TOKEN: token };
    child = spawn(process.execPath, [join(dir, 'server.mjs')], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    let diag;
    for (let i = 0; i < 100 && !diag; i++) {
      if (child.exitCode !== null) throw new Error(output);
      try { const res = await fetch(`${base}/diag`); if (res.ok) diag = await res.json(); } catch { /* not listening yet */ }
      if (!diag) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(diag, 'started: ' + output);
    assert.equal(diag.version, '3.1.4-dev.2');
    assert.equal(diag.channel, 'dev');
    assert.equal(diag.schema.ok, true);
    assert.equal((await fetch(`${base}/widget.js`)).status, 200);
    assert.equal((await fetch(`${base}/admin.js`)).status, 200);
    assert.equal((await fetch(`${base}/mcp`)).status, 404);
    const admin = (path, method = 'GET', body) => fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, Origin: base, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const config = { projectId: 'example', locale: 'en', delivery: 'local', auth: { origins: [base] }, llm: { provider: 'off', model: '' }, templates: [{ type: 'feedback', label: 'Feedback', fields: [] }] };
    const created = await admin('/api/admin/projects', 'POST', { config });
    assert.equal(created.status, 201, await created.clone().text());
    const report = await admin('/api/admin/projects/example/test-report', 'POST', {});
    assert.equal(report.status, 200);
    const feedback = await (await admin('/api/admin/projects/example/feedback')).json();
    assert.equal(feedback.items.length, 1);
    assert.equal((await admin('/api/admin/projects')).status, 200);
  } finally {
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    for (const d of [out, dest, data]) rmSync(d, { recursive: true, force: true });
  }
});
