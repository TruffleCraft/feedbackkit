// `feedbackkit-admin import`: a project from a config file, written by the host
// without a signed-in owner. It must behave like POST /api/admin/config/import,
// because it runs the same function (src/worker/admin/config-import.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { openStorage } from '../scripts/server-storage.mjs';
import { runAdmin } from '../scripts/server-admin.mjs';

const config = (extra = {}) => ({
  projectId: 'shop',
  templates: [{ type: 'bug', label: 'Bug', fields: [{ key: 'what', label: 'What happened', kind: 'longtext', required: true }], delivery: 'local' }],
  llm: { provider: 'openrouter', model: 'm' },
  auth: { origins: ['https://shop.example.org'] },
  ...extra,
});

/** A data directory with a migrated database. The service records its delivery capability at start; `capability` stands in for that. */
function dataDir({ capability = 4 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fk-import-'));
  const store = openStorage(join(dir, 'feedbackkit.sqlite'), 'migrations');
  if (capability) store.sqlite.prepare("INSERT INTO meta (key, value) VALUES ('delivery_capability', ?)").run(String(capability));
  store.close();
  return dir;
}

const projects = (dir) => {
  const store = openStorage(join(dir, 'feedbackkit.sqlite'), 'migrations');
  try { return store.sqlite.prepare('SELECT id, public_key, config, config_version FROM projects ORDER BY id').all().map((r) => ({ ...r })); } finally { store.close(); }
};

/** runAdmin in this process, with stdout, stderr and stdin captured. */
async function admin(dir, args, { input } = {}) {
  const out = [], err = [];
  const code = await runAdmin(args, {
    root: process.cwd(),
    processEnv: { FK_DATA_DIR: dir, FK_PUBLIC_URL: 'https://gw.example.org', FK_ENV_FILE: '/nonexistent' },
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    readInput: () => Buffer.from(input ?? ''),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const lines = (out) => Object.fromEntries(out.split('\n').map((l) => l.split('=')));

test('import: --dry-run checks the config, says what would happen and writes nothing', async () => {
  const dir = dataDir();
  try {
    const file = join(dir, 'shop.json');
    writeFileSync(file, JSON.stringify(config()));
    const dry = await admin(dir, ['import', file, '--dry-run']);
    assert.equal(dry.code, 0, dry.err);
    assert.deepEqual(lines(dry.out), { projectId: 'shop', configVersion: '1' }, 'no public key exists yet');
    assert.match(dry.err, /Dry run, nothing was written\. This would create project shop at config version 1 with a new public key\./);
    assert.match(dry.err, /bug -> local\. The config needs delivery capability 1; this database records 4\./);
    assert.deepEqual(projects(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('import: creates the project, keeps its public key on re-import and bumps configVersion, like the route', async () => {
  const dir = dataDir();
  try {
    const file = join(dir, 'shop.json');
    writeFileSync(file, JSON.stringify(config()));
    const first = await admin(dir, ['import', file]);
    assert.equal(first.code, 0, first.err);
    const created = lines(first.out);
    assert.match(created.publicKey, /^fk_pub_[0-9a-f]{12}$/);
    assert.deepEqual({ projectId: created.projectId, configVersion: created.configVersion }, { projectId: 'shop', configVersion: '1' });
    assert.match(first.err, /Created project shop at config version 1/);
    assert.ok(first.err.includes(`data-project="${created.publicKey}"`) && first.err.includes(`https://gw.example.org/t/${created.publicKey}`), 'the snippet goes to stderr');

    // From stdin, with the fields of an admin export: a different publicKey does not rotate the stored one, configVersion is dropped.
    const again = await admin(dir, ['import', '-'], { input: JSON.stringify({ ...config({ locale: 'de' }), publicKey: 'fk_pub_other1234', configVersion: 9 }) });
    assert.equal(again.code, 0, again.err);
    assert.deepEqual(lines(again.out), { projectId: 'shop', publicKey: created.publicKey, configVersion: '2' });
    assert.match(again.err, /Updated project shop at config version 2/);
    const [row] = projects(dir);
    assert.deepEqual({ key: row.public_key, version: row.config_version }, { key: created.publicKey, version: 2 });
    assert.deepEqual(JSON.parse(row.config), config({ locale: 'de' }), 'publicKey and configVersion are not stored in the blob');

    const dry = await admin(dir, ['import', file, '--dry-run']);
    assert.deepEqual(lines(dry.out), { projectId: 'shop', publicKey: created.publicKey, configVersion: '3' });
    assert.match(dry.err, /would update project shop at config version 3\./);
    assert.equal(projects(dir)[0].config_version, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('import: a pinned publicKey is used for a new project and refused when another project holds it', async () => {
  const dir = dataDir();
  try {
    const pinned = await admin(dir, ['import', '-'], { input: JSON.stringify({ ...config(), publicKey: 'fk_pub_pinned01' }) });
    assert.equal(pinned.code, 0, pinned.err);
    assert.equal(lines(pinned.out).publicKey, 'fk_pub_pinned01');
    const other = JSON.stringify({ ...config({ projectId: 'blog' }), publicKey: 'fk_pub_pinned01' });
    for (const args of [['import', '-', '--dry-run'], ['import', '-']]) {
      const taken = await admin(dir, args, { input: other });
      assert.equal(taken.code, 1, args.join(' '));
      assert.equal(taken.out, '');
      assert.match(taken.err, /Import refused: publicKey already in use by another project/);
    }
    assert.deepEqual(projects(dir).map((p) => p.id), ['shop']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('import: refuses what the route refuses, prints nothing on stdout and exits 1', async () => {
  const dir = dataDir({ capability: 0 });
  try {
    const refused = async (input, pattern, args = ['import', '-']) => {
      const r = await admin(dir, args, { input });
      assert.equal(r.code, 1, `${input}: ${r.err}`);
      assert.equal(r.out, '');
      assert.match(r.err, pattern);
    };
    // A shape this database's recorded capability does not cover: the 422 of the route, with the numbers.
    await refused(JSON.stringify(config()), /Import refused: .*need delivery capability 1; the live stable release provides 0/);
    await refused(JSON.stringify(config()), /need delivery capability 1/, ['import', '-', '--dry-run']);
    await refused(JSON.stringify({ projectId: 'shop', templates: [] }), /Import refused: config failed validation\n {2}templates/);
    await refused(JSON.stringify({ ...config(), publicKey: 'short' }), /publicKey must be 8-64 chars/);
    await refused('[1, 2]', /config must be a JSON object/);
    await refused('{"projectId":', /The config is not valid JSON/);
    await refused('x'.repeat(512 * 1024 + 1), /larger than 512 KiB/);
    await refused('', /Could not read .*no such file/, ['import', join(dir, 'missing.json')]);
    await refused('', /import takes one config file/, ['import']);
    await refused('', /--dry-run belongs to import/, ['users', '--dry-run']);
    assert.deepEqual(projects(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Against the running server: the host writes, the service serves it, and the route sees the same row ──

async function freePort() {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise((r) => reservation.close(r));
  return port;
}

test('import on the host while the service runs: the widget config is served and the route updates the same project', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fk-import-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const adminToken = 'a'.repeat(40); // before the first owner the route still takes ADMIN_TOKEN
  const env = { PATH: process.env.PATH, HOME: dir, HOST: '127.0.0.1', PORT: String(port), FK_PUBLIC_URL: base, FK_DATA_DIR: dir, FK_ENV_FILE: '/nonexistent', ADMIN_TOKEN: adminToken };
  const server = spawn(process.execPath, ['scripts/server.mjs'], { env, stdio: 'ignore' });
  try {
    let up = false;
    for (let i = 0; i < 200 && !up; i++) { try { up = (await fetch(`${base}/diag`)).ok; } catch { /* not listening yet */ } if (!up) await new Promise((r) => setTimeout(r, 50)); }
    assert.ok(up, 'the server started');

    const host = spawnSync(process.execPath, ['scripts/server.mjs', 'admin', 'import', '-'], { env, input: JSON.stringify(config()), encoding: 'utf8' });
    assert.equal(host.status, 0, host.stderr);
    const { publicKey } = lines(host.stdout.trim());
    const served = await fetch(`${base}/api/config?project=${publicKey}`);
    assert.equal(served.status, 200);

    const viaRoute = await fetch(`${base}/api/admin/config/import`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(config()) });
    assert.equal(viaRoute.status, 200);
    const body = await viaRoute.json();
    assert.deepEqual({ projectId: body.projectId, publicKey: body.publicKey, configVersion: body.configVersion }, { projectId: 'shop', publicKey, configVersion: 2 });

    // The same invalid config is refused by both, with the same message.
    const bad = { projectId: 'shop', templates: [] };
    const routeBad = await (await fetch(`${base}/api/admin/config/import`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(bad) })).json();
    const hostBad = spawnSync(process.execPath, ['scripts/server.mjs', 'admin', 'import', '-'], { env, input: JSON.stringify(bad), encoding: 'utf8' });
    assert.equal(hostBad.status, 1);
    assert.ok(hostBad.stderr.includes(`Import refused: ${routeBad.error}`));
    for (const issue of routeBad.issues) assert.ok(hostBad.stderr.includes(issue), issue);
  } finally { server.kill('SIGTERM'); await once(server, 'exit'); rmSync(dir, { recursive: true, force: true }); }
});
