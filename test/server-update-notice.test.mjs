import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { buildBundle } from '../scripts/build-bundle.mjs';
import { compareVersions, createUpdateCheck, parseVersion, pickLatest, readSwitch } from '../scripts/server-update-check.mjs';

// The check behind the admin notice for a newer release (journey J2): version
// comparison, the on/off switch, the failure path, and the whole thing through a
// real server that asks a fake GitHub.

const root = new URL('..', import.meta.url).pathname;
const temporary = () => mkdtempSync(join(tmpdir(), 'fk-notice-'));
const rel = (tag, extra = {}) => ({ tag_name: tag, draft: false, prerelease: /-dev\./.test(tag), html_url: `https://example.invalid/${tag}`, ...extra });

test('versions compare numerically, and a dev build sorts below the stable release of its version', () => {
  assert.deepEqual(parseVersion('v1.2.3'), [1, 2, 3, Infinity]);
  assert.deepEqual(parseVersion('1.2.3-dev.4'), [1, 2, 3, 4]);
  for (const bad of ['', 'latest', '1.2', '1.2.3-rc.1', 'v1.2.3-dev', '1.2.3.4', ' 1.2.3']) assert.equal(parseVersion(bad), null, bad);
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0, 'not a string comparison');
  assert.ok(compareVersions('1.0.0', '1.0.0-dev.9') > 0);
  assert.ok(compareVersions('1.0.0-dev.10', '1.0.0-dev.9') > 0);
  assert.ok(compareVersions('0.9.9', '1.0.0-dev.1') < 0);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  assert.throws(() => compareVersions('1.2.3', 'nope'));
});

test('a stable install is offered stable releases only, a dev install dev builds as well, and drafts never', () => {
  const list = [rel('v0.3.0-dev.2'), rel('v0.2.0'), rel('v0.3.0-dev.1'), rel('v0.4.0', { draft: true }), rel('v0.2.1', { prerelease: true }), rel('nightly'), null, 'x'];
  assert.equal(pickLatest(list, 'stable'), '0.2.0', 'no pre-release, no dev tag, no draft');
  assert.equal(pickLatest(list, 'dev'), '0.3.0-dev.2', 'the newest of both kinds');
  assert.equal(pickLatest([rel('v0.2.0'), rel('v0.2.0-dev.7')], 'dev'), '0.2.0', 'a stable release beats the dev builds of its version');
  assert.equal(pickLatest(rel('v1.0.0'), 'stable'), '1.0.0', 'the latest-release endpoint answers with one object');
  assert.equal(pickLatest([], 'stable'), null);
  assert.equal(pickLatest([rel('v1.0.0', { draft: true })], 'dev'), null);
});

test('FK_UPDATE_CHECK is on unless it says off, and a typo stops the start', () => {
  for (const on of [undefined, '', ' ', 'on', 'ON']) assert.equal(readSwitch(on), true, String(on));
  for (const off of ['off', 'OFF', ' off ']) assert.equal(readSwitch(off), false, off);
  for (const bad of ['of', 'false', '0', 'no', 'disabled']) assert.throws(() => readSwitch(bad), /on or off/, bad);
});

const answer = (status, body, headers = {}) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });

test('the check says available, current or failed, and a failure carries a short fixed reason', async () => {
  const make = (release, fetchImpl, channel = 'stable') => createUpdateCheck({ release, channel, api: 'https://api.example.invalid/repos/x/y', fetchImpl, now: () => 1_000 });
  const url = (v) => `https://github.com/TruffleCraft/feedbackkit/releases/tag/v${v}`;
  assert.deepEqual(await make('0.2.0', answer(200, rel('v0.3.1')))(), { state: 'available', latest: '0.3.1', url: url('0.3.1'), checkedAt: 1_000 });
  assert.deepEqual(await make('0.3.1', answer(200, rel('v0.3.1')))(), { state: 'current', latest: '0.3.1', url: url('0.3.1'), checkedAt: 1_000 });
  assert.equal((await make('0.4.0', answer(200, rel('v0.3.1')))()).state, 'current', 'newer than anything listed counts as current');
  assert.equal((await make('0.3.0-dev.4', answer(200, [rel('v0.3.1-dev.2'), rel('v0.3.0')]), 'dev')()).latest, '0.3.1-dev.2');

  const failure = async (fetchImpl, release = '0.2.0') => { const r = await make(release, fetchImpl)(); assert.equal(r.state, 'failed'); assert.equal(r.latest, null); assert.equal(r.url, null); return r.reason; };
  assert.equal(await failure(answer(500, 'oops')), 'GitHub answered 500');
  assert.equal(await failure(answer(404, '{}')), 'GitHub answered 404');
  assert.equal(await failure(answer(403, '{}', { 'x-ratelimit-remaining': '0' })), 'GitHub rate limit reached');
  assert.equal(await failure(answer(429, '{}')), 'GitHub rate limit reached');
  assert.equal(await failure(answer(403, '{}')), 'GitHub answered 403', 'a plain refusal is not a rate limit');
  assert.equal(await failure(async () => { throw new TypeError('fetch failed: ECONNREFUSED 10.0.0.7'); }), 'GitHub could not be reached', 'no internal detail leaks into the reason');
  assert.equal(await failure(answer(200, '<html>not json')), 'GitHub sent something unexpected');
  assert.equal(await failure(answer(200, [])), 'GitHub listed no release');
  assert.equal(await failure(answer(200, { tag_name: 'nightly' })), 'GitHub listed no release');
  assert.equal(await failure(answer(200, rel('v1.0.0')), 'local'), 'this release has no version number');
  const slow = createUpdateCheck({ release: '0.2.0', channel: 'stable', timeoutMs: 40, fetchImpl: (_u, { signal }) => new Promise((_ok, reject) => signal.addEventListener('abort', () => reject(signal.reason))) });
  assert.equal((await slow()).reason, 'GitHub did not answer in time', 'a hung answer ends at the timeout');
});

test('the request carries nothing about the installation, and the notes link never comes from the answer', async () => {
  const seen = [];
  const spy = (body) => async (u, init) => { seen.push({ u: String(u), init }); return new Response(JSON.stringify(body)); };
  const secretRelease = '7.7.7-dev.7';
  const check = createUpdateCheck({ release: secretRelease, channel: 'dev', api: 'https://api.example.invalid/repos/x/y/', fetchImpl: spy([rel('v7.7.8', { html_url: 'javascript:alert(1)' })]) });
  const result = await check();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].u, 'https://api.example.invalid/repos/x/y/releases?per_page=30');
  assert.deepEqual(Object.keys(seen[0].init).sort(), ['headers', 'signal']);
  assert.deepEqual(seen[0].init.headers, { 'User-Agent': 'feedbackkit-update-check', Accept: 'application/vnd.github+json' });
  assert.ok(!JSON.stringify(seen[0]).includes('7.7.7'), 'the installed release is not sent');
  assert.equal(result.url, 'https://github.com/TruffleCraft/feedbackkit/releases/tag/v7.7.8', 'the link is built from the validated version, not taken from html_url');
  seen.length = 0;
  await createUpdateCheck({ release: '1.0.0', channel: 'stable', api: 'https://api.example.invalid/repos/x/y', fetchImpl: spy(rel('v1.0.1')) })();
  assert.equal(seen[0].u, 'https://api.example.invalid/repos/x/y/releases/latest');
});

test('one request a day, one an hour after a failure, and one at a time', async () => {
  let t = 1_000_000, calls = 0, mode = 'ok';
  const fetchImpl = async () => { calls++; await new Promise((r) => setImmediate(r)); return mode === 'ok' ? new Response(JSON.stringify(rel('v2.0.0'))) : new Response('no', { status: 503 }); };
  const check = createUpdateCheck({ release: '1.0.0', channel: 'stable', fetchImpl, now: () => t });
  const [a, b, c] = await Promise.all([check(), check(), check()]);
  assert.equal(calls, 1, 'three callers at once share one request');
  assert.equal(a, b); assert.equal(b, c);
  t += 23 * 3_600_000; await check();
  assert.equal(calls, 1, 'still the answer of the day');
  t += 2 * 3_600_000; await check();
  assert.equal(calls, 2, 'a day later it asks again');
  mode = 'down'; t += 25 * 3_600_000; assert.equal((await check()).state, 'failed');
  assert.equal(calls, 3);
  t += 59 * 60_000; await check();
  assert.equal(calls, 3, 'a failure is not retried within the hour');
  mode = 'ok'; t += 2 * 60_000; assert.equal((await check()).state, 'available');
  assert.equal(calls, 4, 'after the hour it asks again and recovers');
});

// ── through a real server ────────────────────────────────────────────────────

async function freePort() {
  const s = createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening');
  const { port } = s.address(); await new Promise((r) => s.close(r)); return port;
}

/** A fake GitHub API: records every request and answers with whatever `answer` holds. */
async function fakeGitHub() {
  const state = { requests: [], status: 200, body: [] };
  const server = createServer((req, res) => {
    state.requests.push({ url: req.url, headers: req.headers });
    res.writeHead(state.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(state.body));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  state.url = `http://127.0.0.1:${server.address().port}/repos/TruffleCraft/feedbackkit`;
  state.close = () => new Promise((r) => server.close(r));
  return state;
}

const TOKEN = 'fictional-test-token-'.repeat(3);

async function run({ entry, cwd, env }, check) {
  const data = temporary(), port = await freePort(), base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [entry], { cwd, env: { PATH: process.env.PATH, HOME: data, HOST: '127.0.0.1', PORT: String(port), FK_PUBLIC_URL: base, FK_DATA_DIR: data, ADMIN_TOKEN: TOKEN, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => (output += d)); child.stderr.on('data', (d) => (output += d));
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      if (child.exitCode !== null) return { exited: child.exitCode, output };
      try { up = (await fetch(`${base}/diag`)).ok; } catch { /* not listening yet */ }
      if (!up) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(up, 'started: ' + output);
    const system = async () => { const r = await fetch(`${base}/api/admin/system`, { headers: { Authorization: `Bearer ${TOKEN}` } }); assert.equal(r.status, 200); return r.json(); };
    await check({ system, base });
    return { exited: null, output };
  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    rmSync(data, { recursive: true, force: true });
  }
}

async function unpacked(release) {
  const out = temporary(), dest = temporary();
  const built = await buildBundle({ root, outDir: out, release, commit: 'abc', epoch: 1_800_000_000 });
  execFileSync('tar', ['-xzf', join(out, built.name), '-C', dest]);
  const dir = join(dest, `feedbackkit-v${release}`);
  return { entry: join(dir, 'server.mjs'), cwd: dir, clean: () => { rmSync(out, { recursive: true, force: true }); rmSync(dest, { recursive: true, force: true }); } };
}

test('a tarball install reports a newer stable release in /api/admin/system, asks GitHub once, and sends nothing about itself', async () => {
  const github = await fakeGitHub(), bundle = await unpacked('1.0.0');
  github.body = rel('v1.1.0');
  try {
    await run({ ...bundle, env: { FK_UPDATE_API: github.url } }, async ({ system }) => {
      const first = await system();
      assert.equal(first.update.state, 'available');
      assert.equal(first.update.latest, '1.1.0');
      assert.equal(first.update.url, 'https://github.com/TruffleCraft/feedbackkit/releases/tag/v1.1.0');
      assert.ok(Math.abs(first.update.checkedAt - Date.now()) < 60_000);
      assert.equal(first.version, '1.0.0');
      assert.equal(first.channel, 'stable');
      assert.equal((await system()).update.state, 'available');
      assert.equal(github.requests.length, 1, 'the second page load is answered from memory');
      assert.equal(github.requests[0].url, '/repos/TruffleCraft/feedbackkit/releases/latest');
      assert.equal(github.requests[0].headers['user-agent'], 'feedbackkit-update-check');
      assert.ok(!Object.keys(github.requests[0].headers).some((h) => ['authorization', 'cookie', 'referer', 'x-forwarded-for'].includes(h)), 'no credentials, cookies or referrer');
      assert.ok(!JSON.stringify(github.requests[0]).includes('1.0.0'), 'the installed release is not in the request');
    });
  } finally { await github.close(); bundle.clean(); }
});

test('a dev install is offered the newest dev build, and an install that is current gets state current', async () => {
  const github = await fakeGitHub(), dev = await unpacked('1.0.0-dev.2'), stable = await unpacked('1.1.0');
  try {
    github.body = [rel('v1.0.0-dev.5'), rel('v1.0.0-dev.4'), rel('v0.9.0')];
    await run({ ...dev, env: { FK_UPDATE_API: github.url } }, async ({ system }) => {
      const s = await system();
      assert.deepEqual({ channel: s.channel, state: s.update.state, latest: s.update.latest }, { channel: 'dev', state: 'available', latest: '1.0.0-dev.5' });
      assert.equal(github.requests[0].url, '/repos/TruffleCraft/feedbackkit/releases?per_page=30');
    });
    github.requests.length = 0; github.body = rel('v1.1.0');
    await run({ ...stable, env: { FK_UPDATE_API: github.url } }, async ({ system }) => {
      const s = await system();
      assert.deepEqual({ state: s.update.state, latest: s.update.latest }, { state: 'current', latest: '1.1.0' });
    });
  } finally { await github.close(); dev.clean(); stable.clean(); }
});

test('FK_UPDATE_CHECK=off removes the notice and makes no request, and a check that fails never touches the gateway', async () => {
  const github = await fakeGitHub(), bundle = await unpacked('1.0.0');
  try {
    github.body = rel('v9.9.9');
    await run({ ...bundle, env: { FK_UPDATE_API: github.url, FK_UPDATE_CHECK: 'off' } }, async ({ system }) => {
      const s = await system();
      assert.ok(!('update' in s), 'no update field');
      assert.equal(s.version, '1.0.0');
    });
    assert.equal(github.requests.length, 0, 'switched off means no request at all');

    github.status = 500;
    await run({ ...bundle, env: { FK_UPDATE_API: github.url } }, async ({ system, base }) => {
      const s = await system();
      assert.equal(s.update.state, 'failed');
      assert.equal(s.update.reason, 'GitHub answered 500');
      assert.equal(s.schema.ok, true, 'the rest of the page is intact');
      assert.equal((await fetch(`${base}/diag`)).status, 200, 'the gateway runs as before');
    });

    const dead = await fakeGitHub(); const deadUrl = dead.url; await dead.close();
    await run({ ...bundle, env: { FK_UPDATE_API: deadUrl } }, async ({ system }) => {
      const s = await system();
      assert.equal(s.update.reason, 'GitHub could not be reached', 'no network: a failed check, not an error page');
    });
  } finally { await github.close(); bundle.clean(); }
});

test('a checkout install has no notice and asks nobody, and a mistyped FK_UPDATE_CHECK stops the start', async () => {
  const github = await fakeGitHub();
  github.body = rel('v9.9.9');
  try {
    await run({ entry: join(root, 'scripts/server.mjs'), cwd: root, env: { FK_UPDATE_API: github.url } }, async ({ system }) => {
      const s = await system();
      assert.ok(!('update' in s), 'a checkout has no bundle.json, so no update field');
      assert.equal(s.channel, 'local');
    });
    assert.equal(github.requests.length, 0);
    const refused = await run({ entry: join(root, 'scripts/server.mjs'), cwd: root, env: { FK_UPDATE_CHECK: 'of' } }, async () => {});
    assert.notEqual(refused.exited, 0);
    assert.match(refused.output, /FK_UPDATE_CHECK must be on or off/);
  } finally { await github.close(); }
});
