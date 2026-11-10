import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, readlinkSync, existsSync, readdirSync, chmodSync, copyFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createNetServer } from 'node:net';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { buildBundle } from '../scripts/build-bundle.mjs';
import { packTarGz } from '../scripts/tar-pack.mjs';

// feedbackkit-update against a fake GitHub API and a fake systemctl that runs the real
// bundle: update with data, rollback, and every way a release can be bad.
const root = new URL('..', import.meta.url).pathname;
const UPDATE = join(root, 'scripts/feedbackkit-update');
const tmp = () => mkdtempSync(join(tmpdir(), 'fk-update-'));
const TOKEN = 'fictional-test-token-'.repeat(3);

async function freePort() {
  const r = createNetServer(); r.listen(0, '127.0.0.1'); await once(r, 'listening');
  const { port } = r.address(); await new Promise((x) => r.close(x)); return port;
}
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

function keypair(dir, name) {
  const key = join(dir, name);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', key]);
  return key;
}
const sign = (sums, key) => execFileSync('ssh-keygen', ['-Y', 'sign', '-q', '-f', key, '-n', 'feedbackkit-release', sums]);

/** Unpack a tarball, let `change` edit the files (it gets the release directory and its parent), pack it again. */
function repack(tarball, change) {
  const dir = tmp();
  execFileSync('tar', ['-xzf', tarball, '-C', dir]);
  const top = readdirSync(dir)[0];
  change(join(dir, top), dir);
  const walk = (rel = '') => readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const p = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? [{ path: p, mode: 0o755, dir: true }, ...walk(p)] : [{ path: p, mode: statSync(join(dir, p)).mode & 0o777, data: readFileSync(join(dir, p)) }];
  });
  const out = packTarGz(walk(), 0);
  rmSync(dir, { recursive: true, force: true });
  return out;
}

async function harness() {
  const dir = tmp();
  const keys = join(dir, 'keys'); mkdirSync(keys);
  const stable = keypair(keys, 'stable'), dev = keypair(keys, 'dev');
  const trust = join(dir, 'trust'); mkdirSync(trust);
  copyFileSync(`${stable}.pub`, join(trust, 'stable.pub')); copyFileSync(`${dev}.pub`, join(trust, 'dev.pub'));
  const assets = join(dir, 'assets'); mkdirSync(assets);
  const releases = []; // what the fake API lists, newest first
  const h = { dir, stable, dev, releases };

  /** Build release `version` with its checksum and signature; `bad` can break one part. */
  h.publish = async (version, { key = version.includes('-dev.') ? dev : stable, prerelease = version.includes('-dev.'), mutate, tamper, keysDir = trust } = {}) => {
    const out = join(assets, version); mkdirSync(out);
    const built = await buildBundle({ root, outDir: out, release: version, commit: 'abc', epoch: 1_800_000_000, keysDir });
    let tarball = join(out, built.name);
    if (mutate) { writeFileSync(tarball, repack(tarball, mutate)); writeFileSync(join(out, 'SHA256SUMS'), `${sha(readFileSync(tarball))}  ${built.name}\n`); }
    sign(join(out, 'SHA256SUMS'), key);
    if (tamper === 'tarball') { const b = readFileSync(tarball); b[b.length - 40] ^= 0xff; writeFileSync(tarball, b); }
    if (tamper === 'sums') writeFileSync(join(out, 'SHA256SUMS'), readFileSync(join(out, 'SHA256SUMS'), 'utf8').replace(/^./, (c) => (c === 'a' ? 'b' : 'a')));
    releases.unshift({ tag_name: `v${version}`, prerelease, draft: false, assets: ['tar.gz', 'SHA256SUMS', 'SHA256SUMS.sig'].map((s) => ({ name: s === 'tar.gz' ? built.name : s, browser_download_url: `${h.api}/dl/${version}/${s === 'tar.gz' ? built.name : s}` })) });
    return out;
  };

  const apiPort = await freePort();
  h.api = `http://127.0.0.1:${apiPort}`;
  h.apiServer = createServer((req, res) => {
    const url = new URL(req.url, h.api);
    if (url.pathname === '/releases/latest') { const r = releases.find((x) => !x.prerelease); res.setHeader('content-type', 'application/json'); return r ? res.end(JSON.stringify(r)) : (res.statusCode = 404, res.end('{}')); }
    if (url.pathname === '/releases') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(releases)); }
    const m = /^\/dl\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (m && existsSync(join(assets, m[1], m[2]))) return res.end(readFileSync(join(assets, m[1], m[2])));
    res.statusCode = 404; res.end('no');
  }).listen(apiPort, '127.0.0.1');
  await once(h.apiServer, 'listening');

  // The installed system: one release, a data directory, a fake systemd.
  h.base = join(dir, 'opt'); h.data = join(dir, 'var'); h.port = await freePort();
  h.baseUrl = `http://127.0.0.1:${h.port}`;
  mkdirSync(join(h.base, 'releases'), { recursive: true }); mkdirSync(h.data, { mode: 0o700 });
  h.envFile = join(dir, 'feedbackkit.env');
  writeFileSync(h.envFile, `HOST=127.0.0.1\nPORT=${h.port}\nFK_PUBLIC_URL=${h.baseUrl}\nFK_DATA_DIR=${h.data}\nADMIN_TOKEN=${TOKEN}\n`);
  h.pid = join(dir, 'service.pid'); h.log = join(dir, 'service.log');
  h.systemctl = join(dir, 'systemctl');
  writeFileSync(h.systemctl, `#!/bin/sh
case "$1" in
  start) set -a; . "${h.envFile}"; set +a
    # The subshell must not hold the caller's pipes, or the caller waits for the server to end.
    ( cd "${h.base}/current" && exec "${process.execPath}" server.mjs >> "${h.log}" 2>&1 < /dev/null ) > /dev/null 2>&1 &
    echo $! > "${h.pid}" ;;
  stop) if [ -f "${h.pid}" ]; then p=$(cat "${h.pid}"); kill "$p" 2>/dev/null || true; i=0; while kill -0 "$p" 2>/dev/null && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done; rm -f "${h.pid}"; fi ;;
esac
`);
  chmodSync(h.systemctl, 0o755);

  h.install = async (version) => {
    const out = await h.publish(version);
    execFileSync('tar', ['-xzf', join(out, `feedbackkit-v${version}.tar.gz`), '-C', join(h.base, 'releases')]);
    execFileSync('mv', [join(h.base, 'releases', `feedbackkit-v${version}`), join(h.base, 'releases', version)]);
    symlinkSync(`releases/${version}`, join(h.base, 'current'));
    execFileSync(h.systemctl, ['start', 'feedbackkit']);
    await h.up(version);
  };
  h.diag = async () => { try { return await (await fetch(`${h.baseUrl}/diag`)).json(); } catch { return null; } };
  h.up = async (version) => { for (let i = 0; i < 150; i++) { const d = await h.diag(); if (d?.version === version) return d; await new Promise((r) => setTimeout(r, 100)); } throw new Error(`release ${version} did not come up: ${existsSync(h.log) ? readFileSync(h.log, 'utf8') : ''}`); };
  h.admin = (path, method = 'GET', body) => fetch(h.baseUrl + path, { method, headers: { Authorization: `Bearer ${TOKEN}`, Origin: h.baseUrl, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  h.createProject = async (id) => assert.equal((await h.admin('/api/admin/projects', 'POST', { config: { projectId: id, locale: 'en', delivery: 'local', auth: { origins: [h.baseUrl] }, llm: { provider: 'off', model: '' }, templates: [{ type: 'feedback', label: 'Feedback', fields: [] }] } })).status, 201);
  h.projects = async () => (await (await h.admin('/api/admin/projects')).json()).projects.map((p) => p.id).sort();
  // Asynchronous on purpose: the fake API and the service live in this process, so it must not block while the script runs.
  h.run = (...args) => new Promise((resolve) => {
    const child = spawn('sh', [UPDATE, ...args], { env: { PATH: process.env.PATH, HOME: dir, FK_BASE: h.base, FK_DATA_DIR: h.data, FK_SERVICE: 'feedbackkit', FK_SYSTEMCTL: h.systemctl, FK_API: h.api, FK_ENV_FILE: h.envFile, FK_HEALTH_SECONDS: '8' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d)); child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  h.current = () => basename(readlinkSync(join(h.base, 'current')));
  h.close = async () => { try { execFileSync(h.systemctl, ['stop', 'feedbackkit']); } catch { /* already stopped */ } h.apiServer.close(); rmSync(dir, { recursive: true, force: true }); };
  return h;
}

test('--check says what is installed, what is newest, and exits 10 when an update waits', async () => {
  const h = await harness();
  try {
    await h.install('1.0.0');
    let r = await h.run('--check');
    assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /Up to date/);
    await h.publish('1.1.0');
    r = await h.run('--check');
    assert.equal(r.status, 10, r.stdout + r.stderr);
    assert.match(r.stdout, /Installed: 1\.0\.0 \(stable\)\. Newest on stable: 1\.1\.0\./);
    assert.equal(h.current(), '1.0.0', '--check changes nothing');
  } finally { await h.close(); }
});

test('an update keeps the data, shows the new release and keeps a way back; --rollback goes there with the old data', async () => {
  const h = await harness();
  try {
    await h.install('1.0.0');
    await h.createProject('before');
    await h.publish('1.1.0');
    const update = await h.run();
    assert.equal(update.status, 0, update.stdout + update.stderr);
    assert.match(update.stdout, /Signature \(release-stable\) and checksum are valid/);
    assert.equal(h.current(), '1.1.0');
    assert.equal(basename(readlinkSync(join(h.base, 'previous'))), '1.0.0');
    assert.equal((await h.diag()).version, '1.1.0');
    assert.deepEqual(await h.projects(), ['before'], 'the data came along');
    assert.ok(existsSync(`${h.data}.backup-1.0.0`));
    await h.createProject('after');
    assert.equal((await h.run()).status, 0, 'a second run finds nothing to do');
    const back = await h.run('--rollback');
    assert.equal(back.status, 0, back.stdout + back.stderr);
    assert.equal(h.current(), '1.0.0');
    assert.equal((await h.diag()).version, '1.0.0');
    assert.deepEqual(await h.projects(), ['before'], 'the data is the copy from before the update');
    assert.ok(readdirSync(join(h.dir)).some((n) => n.startsWith('var.after-rollback-')), 'what came in since is kept aside, not destroyed');
    // The release we went back from is still on disk, and updating to it again must work.
    const again = await h.run();
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.equal(h.current(), '1.1.0');
    assert.equal((await h.diag()).version, '1.1.0');
    assert.deepEqual(await h.projects(), ['before'], 'the data is still the restored copy');
  } finally { await h.close(); }
});

for (const [title, options, pattern] of [
  ['a tampered checksum file', { tamper: 'sums' }, /signature of SHA256SUMS does not verify/],
  ['a corrupted tarball', { tamper: 'tarball' }, /checksum of feedbackkit-v1\.1\.0\.tar\.gz does not match/],
  ['a stable release signed with the dev key', { key: 'dev' }, /signed with the dev key, which stable releases must not use|does not verify/],
  ['a bundle whose bundle.json names another release', { mutate: (dir) => writeFileSync(join(dir, 'bundle.json'), readFileSync(join(dir, 'bundle.json'), 'utf8').replace('"1.1.0"', '"9.9.9"')) }, /bundle\.json says 9\.9\.9/],
]) {
  test(`${title} stops the update and leaves the installation as it was`, async () => {
    const h = await harness();
    try {
      await h.install('1.0.0');
      await h.createProject('keep');
      await h.publish('1.1.0', { ...options, key: options.key === 'dev' ? h.dev : undefined });
      const r = await h.run();
      assert.notEqual(r.status, 0, r.stdout);
      assert.match(r.stderr, pattern);
      assert.equal(h.current(), '1.0.0');
      assert.ok(!existsSync(join(h.base, 'releases', '1.1.0')), 'nothing was unpacked into place');
      assert.equal((await h.diag()).version, '1.0.0', 'the old release kept running');
      assert.deepEqual(await h.projects(), ['keep']);
    } finally { await h.close(); }
  });
}

test('a release that does not start is rolled back by the update itself, with the data copy and the way back it had', async () => {
  const h = await harness();
  try {
    await h.install('1.0.0');
    await h.publish('1.1.0');
    assert.equal((await h.run()).status, 0);
    await h.createProject('keep');
    await h.publish('1.2.0', { mutate: (dir) => writeFileSync(join(dir, 'server.mjs'), 'throw new Error("this release is broken");\n') });
    const r = await h.run();
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /did not become healthy\. Restoring 1\.1\.0/);
    assert.match(r.stderr, /1\.1\.0 is running again with its data/);
    assert.equal(h.current(), '1.1.0');
    assert.equal((await h.up('1.1.0')).version, '1.1.0');
    assert.deepEqual(await h.projects(), ['keep']);
    // The failed attempt changed nothing about the way back: 1.0.0 is still the previous release with its data copy.
    assert.equal(basename(readlinkSync(join(h.base, 'previous'))), '1.0.0');
    assert.ok(existsSync(`${h.data}.backup-1.0.0`));
    assert.deepEqual(readdirSync(join(h.base, 'releases')).sort(), ['1.0.0', '1.1.0'], 'the failed release is not kept');
    assert.ok(!existsSync(`${h.data}.backup-1.1.0`), 'the copy made for the failed attempt is gone');
    // And --rollback still works afterwards.
    assert.equal((await h.run('--rollback')).status, 0);
    assert.equal(h.current(), '1.0.0');
  } finally { await h.close(); }
});

test('dev builds are offered on the dev channel only, and only when they are newer', async () => {
  const h = await harness();
  try {
    await h.install('1.0.0');
    await h.publish('1.1.0-dev.1');
    let r = await h.run('--check');
    assert.equal(r.status, 0, 'stable ignores a dev build');
    r = await h.run('--check', '--channel', 'dev');
    assert.equal(r.status, 10, r.stdout + r.stderr);
    assert.match(r.stdout, /Newest on dev: 1\.1\.0-dev\.1/);
    // The dev key is not in the stable trust list unless the channel is dev: a dev build on stable cannot be installed.
    r = await h.run('--channel', 'dev');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(h.current(), '1.1.0-dev.1');
    assert.equal((await h.up('1.1.0-dev.1')).channel, 'dev');
    // A dev install follows the dev channel by itself.
    await h.publish('1.1.0-dev.2');
    assert.equal((await h.run('--check')).status, 10);
  } finally { await h.close(); }
});

test('on the dev channel a stable release signed with the dev key is refused too', async () => {
  const h = await harness();
  try {
    await h.install('1.0.0-dev.1');
    await h.publish('1.0.0', { key: h.dev });
    const r = await h.run('--channel', 'dev');
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(r.stderr, /signed with the dev key, which stable releases must not use/);
    assert.equal(h.current(), '1.0.0-dev.1');
  } finally { await h.close(); }
});

test('a key rotation: a release signed with the old key brings the new key list, then only the new key counts', async () => {
  const h = await harness();
  try {
    await h.install('1.0.0');
    // The new stable key pair, and the key list that releases from now on carry.
    const next = join(h.dir, 'next'); mkdirSync(next);
    const newKey = keypair(next, 'stable');
    const trustNext = join(h.dir, 'trust-next'); mkdirSync(trustNext);
    copyFileSync(`${newKey}.pub`, join(trustNext, 'stable.pub')); copyFileSync(`${h.dev}.pub`, join(trustNext, 'dev.pub'));
    // 1.1.0 is the rotation release: signed with the old key, carrying the new key list.
    await h.publish('1.1.0', { keysDir: trustNext });
    let r = await h.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(h.current(), '1.1.0');
    // 1.2.0 is signed with the new key and installs on the new trust.
    await h.publish('1.2.0', { key: newKey, keysDir: trustNext });
    r = await h.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(h.current(), '1.2.0');
    // A release signed with the old key is refused from now on.
    await h.publish('1.3.0', { key: h.stable, keysDir: trustNext });
    r = await h.run();
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /does not verify/);
    assert.equal(h.current(), '1.2.0');
  } finally { await h.close(); }
});

test('a tarball with more than the release directory is refused and leaves nothing behind', async () => {
  const h = await harness();
  try {
    await h.install('1.0.0');
    await h.publish('1.1.0', { mutate: (dir, parent) => writeFileSync(join(parent, 'extra-file'), 'unexpected') });
    const r = await h.run();
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(r.stderr, /exactly one directory/);
    assert.equal(h.current(), '1.0.0');
    assert.deepEqual(readdirSync(join(h.base, 'releases')).sort(), ['1.0.0'], 'no half-unpacked release is left');
    assert.equal((await h.diag()).version, '1.0.0');
  } finally { await h.close(); }
});
