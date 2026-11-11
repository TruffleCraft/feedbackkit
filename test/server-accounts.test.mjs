// Gate 2 on the standalone server: it starts without ADMIN_TOKEN, the host command
// (feedbackkit-admin) issues the one-time links, the release carries the command,
// and the failed-login throttle never refuses a valid credential, with and
// without a proxy in front (FK_TRUSTED_PROXY_HOPS). Needs `pnpm build:widget &&
// pnpm build:server` first, like the other server tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { openStorage } from '../scripts/server-storage.mjs';
import { parseEnvFile } from '../scripts/server-admin.mjs';
import { codeDeliveryCapability, codeSchemaVersion } from '../scripts/delivery-capability.mjs';
import { buildBundle } from '../scripts/build-bundle.mjs';

const temporary = () => mkdtempSync(join(tmpdir(), 'fk-accounts-'));
const sha = (text) => createHash('sha256').update(text).digest('hex');

async function freePort() {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise((r) => reservation.close(r));
  return port;
}

async function launch(dir, extraEnv = {}, { admin = null } = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), FK_PUBLIC_URL: base, FK_DATA_DIR: dir, FK_ENV_FILE: '/nonexistent', ...extraEnv };
  delete env.ADMIN_TOKEN;
  if (admin) env.ADMIN_TOKEN = admin;
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
  return { base, env, output: () => output, ready, exited, stop: async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await exited; } } };
}

/** The host command, as the tarball's feedbackkit-admin runs it: node server.mjs admin ... */
function admin(dir, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, ['scripts/server.mjs', 'admin', ...args], { env: { ...process.env, FK_DATA_DIR: dir, FK_PUBLIC_URL: 'https://gw.example.org', FK_ENV_FILE: '/nonexistent', ...extraEnv }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

const seedOwner = (dir, name = 'Robin') => {
  const store = openStorage(join(dir, 'feedbackkit.sqlite'), 'migrations');
  const id = crypto.randomUUID();
  const n = store.sqlite.prepare('SELECT COUNT(*) AS n FROM accounts').get().n;
  store.sqlite.prepare("INSERT INTO accounts (id, name, name_key, role, state, created_at) VALUES (?, ?, ?, 'owner', 'active', ?)").run(id, name, name.toLowerCase(), n + 1);
  if (!store.sqlite.prepare('SELECT 1 FROM owner_claim').get()) store.sqlite.prepare('INSERT INTO owner_claim (singleton, account_id, claimed_at) VALUES (1, ?, 1)').run(id);
  store.close();
  return id;
};

test('the environment file format of systemd is read as the service reads it', () => {
  assert.deepEqual(parseEnvFile('# comment\nFK_DATA_DIR=/var/lib/feedbackkit\nFK_PUBLIC_URL="https://gw.example.org"\n  export PORT=8787\nLLM=\'a b\'\n\nbroken line\n'), { FK_DATA_DIR: '/var/lib/feedbackkit', FK_PUBLIC_URL: 'https://gw.example.org', PORT: '8787', LLM: 'a b' });
});

test('the server starts without ADMIN_TOKEN, says how to create the first owner, and refuses a short ADMIN_TOKEN', async () => {
  const dir = temporary();
  const server = await launch(dir);
  try {
    assert.ok(await server.ready, server.output());
    assert.match(server.output(), /No owner exists yet\. Create the first owner with: feedbackkit-admin setup-link/);
    const state = await (await fetch(`${server.base}/api/auth/state`)).json();
    assert.deepEqual({ owner: state.ownerExists, rp: state.rpId, origin: state.origin }, { owner: false, rp: '127.0.0.1', origin: server.base });
    assert.equal((await fetch(`${server.base}/api/admin/projects`)).status, 401);
  } finally { await server.stop(); }
  const weak = await launch(dir, {}, { admin: 'too-short' });
  try {
    assert.equal(await weak.exited, 1);
    assert.match(weak.output(), /ADMIN_TOKEN is set but shorter than 32 characters/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('with an owner in the database ADMIN_TOKEN is ignored and the server says so', async () => {
  const dir = temporary();
  seedOwner(dir);
  const token = 'fictional-legacy-token-'.repeat(2);
  const server = await launch(dir, {}, { admin: token });
  try {
    assert.ok(await server.ready, server.output());
    assert.match(server.output(), /ADMIN_TOKEN is set but ignored: this instance has an owner/);
    const res = await fetch(`${server.base}/api/admin/projects`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).code, 'FK_ADMIN_TOKEN_RETIRED');
  } finally { await server.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('feedbackkit-admin: setup-link prints the link alone on stdout, replaces an unused one, and stops once an owner exists', () => {
  const dir = temporary();
  try {
    const store = openStorage(join(dir, 'feedbackkit.sqlite'), 'migrations');
    store.close();
    const first = admin(dir, ['setup-link']);
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /^https:\/\/gw\.example\.org\/admin\/setup#fk_link_[A-Za-z0-9_-]{43}$/);
    assert.ok(!first.err.includes(first.out.split('#')[1]), 'the token is not on stderr');
    const second = admin(dir, ['setup-link', '--minutes', '5']);
    assert.equal(second.code, 0);
    const check = openStorage(join(dir, 'feedbackkit.sqlite'), 'migrations');
    const rows = check.sqlite.prepare("SELECT id, purpose, created_by, expires_at - created_at AS ttl FROM setup_links").all();
    check.close();
    assert.equal(rows.length, 1, 'the second link replaced the first');
    assert.deepEqual({ purpose: rows[0].purpose, by: rows[0].created_by, ttl: rows[0].ttl, hashed: rows[0].id === sha(second.out.split('#')[1]) }, { purpose: 'bootstrap', by: 'host', ttl: 300_000, hashed: true });
    assert.ok(!JSON.stringify(rows).includes(second.out.split('#')[1]), 'only the hash is stored');
    seedOwner(dir);
    const refused = admin(dir, ['setup-link']);
    assert.equal(refused.code, 1);
    assert.equal(refused.out, '');
    assert.match(refused.err, /An owner already exists/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('feedbackkit-admin: recovery-link needs an owner, picks the only one, asks for a name when there are several, and rejects an unknown one', () => {
  const dir = temporary();
  try {
    openStorage(join(dir, 'feedbackkit.sqlite'), 'migrations').close();
    assert.match(admin(dir, ['recovery-link']).err, /no owner yet/i);
    seedOwner(dir, 'Robin');
    const one = admin(dir, ['recovery-link']);
    assert.equal(one.code, 0, one.err);
    assert.match(one.out, /^https:\/\/gw\.example\.org\/admin\/setup#fk_link_/);
    assert.match(one.err, /new passkey for Robin/);
    seedOwner(dir, 'Sam');
    const several = admin(dir, ['recovery-link']);
    assert.equal(several.code, 1);
    assert.match(several.err, /Name the user with --user\. Owners: Robin, Sam/);
    assert.equal(admin(dir, ['recovery-link', '--user', 'sam']).code, 0);
    assert.equal(admin(dir, ['recovery-link', '--account', 'sam']).code, 0, '--account is the old name of --user');
    assert.match(admin(dir, ['recovery-link', '--user', 'Nobody']).err, /No active user named "Nobody"/);
    assert.match(admin(dir, ['recovery-link', '--account', 'Nobody']).err, /No active user named "Nobody"/);
    const list = admin(dir, ['users']);
    const oldName = admin(dir, ['accounts']);
    assert.equal(oldName.code, 0, oldName.err);
    assert.equal(oldName.out, list.out, '`accounts` is the old name of `users` and prints the same');
    assert.match(list.out, /Robin\towner\tactive\t0 passkeys\topen link until /);
    assert.match(list.out, /Sam\towner\tactive/);
    assert.ok(!/fk_link_/.test(list.out), 'the list shows no secret');
    assert.equal(admin(dir, ['bogus']).code, 1);
    // Recovery revokes the account's API tokens unless --keep-tokens says otherwise, and says which it does.
    const flag = () => { const s = openStorage(join(dir, 'feedbackkit.sqlite'), 'migrations'); try { return s.sqlite.prepare("SELECT keep_tokens FROM setup_links WHERE purpose = 'recovery' ORDER BY created_at DESC LIMIT 1").get().keep_tokens; } finally { s.close(); } };
    const revoking = admin(dir, ['recovery-link', '--user', 'Robin']);
    assert.match(revoking.err, /revokes the API tokens of that user/);
    assert.equal(flag(), 0);
    const keeping = admin(dir, ['recovery-link', '--user', 'Robin', '--keep-tokens']);
    assert.match(keeping.err, /keeps the API tokens of that user/);
    assert.equal(flag(), 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('feedbackkit-admin: reads FK_DATA_DIR and FK_PUBLIC_URL from the environment file, and never creates a database', () => {
  const dir = temporary();
  try {
    const file = join(dir, 'feedbackkit.env');
    writeFileSync(file, `FK_DATA_DIR=${join(dir, 'data')}\nFK_PUBLIC_URL=https://from-file.example.org\n`);
    const missing = spawnSync(process.execPath, ['scripts/server.mjs', 'admin', 'setup-link'], { env: { PATH: process.env.PATH, FK_ENV_FILE: file }, encoding: 'utf8' });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /No database at .*data\/feedbackkit\.sqlite/);
    assert.ok(!existsSync(join(dir, 'data')), 'no directory was created');
    openStorage(join(dir, 'data', 'feedbackkit.sqlite'), 'migrations').close();
    const ok = spawnSync(process.execPath, ['scripts/server.mjs', 'admin', 'setup-link'], { env: { PATH: process.env.PATH, FK_ENV_FILE: file }, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /^https:\/\/from-file\.example\.org\/admin\/setup#fk_link_/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the release carries feedbackkit-admin, and it works from the unpacked tarball with Node alone', async () => {
  const out = temporary(), dest = temporary(), data = temporary();
  try {
    const built = await buildBundle({ root: process.cwd(), outDir: out, release: '3.2.1', commit: 'abc', epoch: 1_800_000_000 });
    execFileSync('tar', ['-xzf', join(out, built.name), '-C', dest]);
    const dir = join(dest, 'feedbackkit-v3.2.1');
    const manifest = JSON.parse(readFileSync(join(dir, 'bundle.json'), 'utf8'));
    assert.ok(manifest.files.includes('feedbackkit-admin'));
    assert.equal(statSync(join(dir, 'feedbackkit-admin')).mode & 0o111, 0o111, 'executable');
    assert.deepEqual({ schema: manifest.schemaVersion, capability: manifest.deliveryCapability }, { schema: codeSchemaVersion(), capability: codeDeliveryCapability() });
    assert.equal(codeDeliveryCapability(), 4, 'accounts raised the capability, so a release below it refuses this data');
    // The command creates a database only through the server, so start it once to have one, like a real install.
    const port = await freePort();
    const env = { PATH: process.env.PATH, HOME: data, HOST: '127.0.0.1', PORT: String(port), FK_PUBLIC_URL: `http://127.0.0.1:${port}`, FK_DATA_DIR: data, FK_ENV_FILE: '/nonexistent' };
    const server = spawn(process.execPath, [join(dir, 'server.mjs')], { env, stdio: 'ignore' });
    try {
      for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/diag`)).ok) break; } catch { /* wait */ } await new Promise((r) => setTimeout(r, 50)); }
      const link = spawnSync(join(dir, 'feedbackkit-admin'), ['setup-link'], { env, encoding: 'utf8' });
      assert.equal(link.status, 0, link.stderr);
      assert.match(link.stdout.trim(), new RegExp(`^http://127\\.0\\.0\\.1:${port}/admin/setup#fk_link_`));
      // Through a symlink, as an operator installs it into /usr/local/bin.
      execFileSync('ln', ['-s', join(dir, 'feedbackkit-admin'), join(dest, 'fk-admin')]);
      assert.equal(spawnSync(join(dest, 'fk-admin'), ['users'], { env, encoding: 'utf8' }).status, 0);
    } finally { server.kill('SIGTERM'); await once(server, 'exit'); }
  } finally { for (const d of [out, dest, data]) rmSync(d, { recursive: true, force: true }); }
});

// ── The failed-login throttle on the real server, with and without a proxy ───────────

function seedToken(dir) {
  const store = openStorage(join(dir, 'feedbackkit.sqlite'), 'migrations');
  const account = crypto.randomUUID();
  store.sqlite.prepare("INSERT INTO accounts (id, name, name_key, role, state, created_at) VALUES (?, 'Robin', 'robin', 'owner', 'active', 1)").run(account);
  store.sqlite.prepare('INSERT INTO owner_claim (singleton, account_id, claimed_at) VALUES (1, ?, 1)').run(account);
  const token = `fk_tok_${randomBytes(32).toString('base64url')}`;
  store.sqlite.prepare("INSERT INTO api_tokens (id, token_hash, prefix, name, account_id, access, projects, created_at, expires_at) VALUES (?, ?, ?, 'ci', ?, 'read', NULL, 1, ?)").run(crypto.randomUUID(), sha(token), token.slice(0, 13), account, Date.now() + 86_400_000);
  store.close();
  return token;
}

const get = (server, token, forwardedFor) => fetch(`${server.base}/api/admin/projects`, { headers: { Authorization: `Bearer ${token}`, ...(forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {}) } });

test('behind a proxy that is configured (FK_TRUSTED_PROXY_HOPS=1), one client failing does not block another client or its own valid token', async () => {
  const dir = temporary();
  const token = seedToken(dir);
  const server = await launch(dir, { FK_TRUSTED_PROXY_HOPS: '1' });
  try {
    assert.ok(await server.ready, server.output());
    const statuses = [];
    for (let i = 0; i < 40; i++) statuses.push((await get(server, `fk_tok_${String(i).padStart(43, 'z')}`, '198.51.100.7')).status);
    assert.ok(statuses.includes(429), 'the attacker address is throttled: ' + statuses.join(','));
    assert.equal((await get(server, token, '198.51.100.7')).status, 200, 'a valid token from the throttled address still works');
    assert.equal((await get(server, token, '198.51.100.8')).status, 200, 'another client behind the proxy is untouched');
    // The client cannot pick its own address by adding entries on the left.
    assert.equal((await get(server, 'fk_tok_' + 'y'.repeat(43), '203.0.113.9, 198.51.100.7')).status, 429);
  } finally { await server.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('behind a proxy without the setting, every client shares one address and a valid token still works', async () => {
  const dir = temporary();
  const token = seedToken(dir);
  const server = await launch(dir); // FK_TRUSTED_PROXY_HOPS unset: the socket peer is the only address
  try {
    assert.ok(await server.ready, server.output());
    for (let i = 0; i < 40; i++) await get(server, `fk_tok_${String(i).padStart(43, 'z')}`, `198.51.100.${i}`);
    const other = await get(server, 'fk_tok_' + 'y'.repeat(43), '192.0.2.1');
    assert.equal(other.status, 429, 'failures share the proxy address');
    assert.match(other.headers.get('retry-after'), /^\d+$/);
    assert.equal((await get(server, token, '192.0.2.1')).status, 200, 'but a valid token is never refused');
    assert.match(server.output(), /X-Forwarded-For arrived but FK_TRUSTED_PROXY_HOPS is 0/);
  } finally { await server.stop(); rmSync(dir, { recursive: true, force: true }); }
});
