import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { main } from '../scripts/feedbackkit-migrate.mjs';

// Journey J19 end to end, with the real wrangler on a LOCAL D1 and R2 (miniflare): a Worker is filled with
// fictional data through its own HTTP API, `feedbackkit-migrate export` reads it with wrangler, `import`
// writes the standalone database, and the standalone server started on the result answers like the Worker
// did. No Cloudflare account, no network, no real project is touched.

const root = new URL('..', import.meta.url).pathname;
const wrangler = join(root, 'node_modules/.bin/wrangler');
const TOKEN = 'fictional-migrate-admin-token-0123456789';
const sha = (data) => createHash('sha256').update(data).digest('hex');
const temporary = () => mkdtempSync(join(tmpdir(), 'fk-cfmove-'));

async function freePort() {
  const s = createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening');
  const { port } = s.address(); await new Promise((r) => s.close(r)); return port;
}

function runWrangler(args, cwd, env) {
  return new Promise((done) => {
    const child = spawn(wrangler, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => (output += d)); child.stderr.on('data', (d) => (output += d));
    child.on('close', (code) => done({ code, output }));
  });
}

async function startServer(command, args, { cwd, env, base }) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => (output += d)); child.stderr.on('data', (d) => (output += d));
  for (let i = 0; i < 600; i++) {
    if (child.exitCode !== null) throw new Error(`exited early:\n${output.slice(-1500)}`);
    try { if ((await fetch(`${base}/diag`)).ok) return child; } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill('SIGTERM');
  throw new Error(`did not start:\n${output.slice(-1500)}`);
}
const stop = async (child) => { if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } };

test('a Worker on a local D1 and R2 moves into the standalone server, and the server answers as the Worker did', { timeout: 300_000 }, async (t) => {
  const dir = temporary();
  const project = join(dir, 'worker'), exportDir = join(dir, 'export'), data = join(dir, 'data');
  mkdirSync(project, { recursive: true });
  const env = { ...process.env, CI: '1', NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(dir, 'wrangler-logs'), XDG_CONFIG_HOME: join(dir, 'xdg'), HOME: dir };
  let worker, standalone;
  try {
    // A wrangler project for the real Worker code, with local D1 and R2 only.
    writeFileSync(join(project, 'wrangler.toml'), `name = "feedbackkit"
main = "${root}src/worker/index.ts"
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]
[assets]
directory = "${root}dist"
binding = "ASSETS"
[[d1_databases]]
binding = "DB"
database_name = "feedbackkit"
database_id = "00000000-0000-0000-0000-000000000000"
migrations_dir = "${root}migrations"
[[r2_buckets]]
binding = "UPLOADS"
bucket_name = "fk-fictional-bucket"
[vars]
FK_ENV = "production"
FK_RELEASE = "0.0.0-local"
FK_CHANNEL = "local"
WIDGET_VERSION = "test"
`);
    writeFileSync(join(project, '.dev.vars'), `ADMIN_TOKEN=${TOKEN}\n`);
    const migrated = await runWrangler(['d1', 'migrations', 'apply', 'feedbackkit', '--local'], project, env);
    assert.equal(migrated.code, 0, migrated.output);
    const capability = await runWrangler(['d1', 'execute', 'feedbackkit', '--local', '--command', "INSERT INTO meta (key, value) VALUES ('delivery_capability', '3') ON CONFLICT(key) DO UPDATE SET value = excluded.value"], project, env);
    assert.equal(capability.code, 0, capability.output);

    const port = await freePort(), inspector = await freePort(), base = `http://127.0.0.1:${port}`;
    worker = await startServer(wrangler, ['dev', '--local', '--port', String(port), '--ip', '127.0.0.1', '--inspector-port', String(inspector)], { cwd: project, env, base });

    // ── fill the Worker with fictional data through its own API ──
    const admin = (path, method = 'GET', body) => fetch(base + path, { method, headers: { Authorization: `Bearer ${TOKEN}`, Origin: base, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const harbor = { projectId: 'harborline', locale: 'en', delivery: 'local', auth: { origins: ['https://harborline.example'] }, llm: { provider: 'off', model: '' }, storage: { kind: 'r2', publicBaseUrl: 'https://r2.harborline.example', retentionDays: 90 }, templates: [{ type: 'bug', label: 'Bug', fields: [] }, { type: 'idea', label: 'Idea', fields: [] }] };
    const pantry = { projectId: 'pantry-planner', locale: 'en', delivery: 'issue', tracker: { kind: 'github', defaultRepo: 'pantry/app', patSecret: 'GITHUB_PAT_pantry' }, auth: { origins: ['https://pantry.example'] }, llm: { provider: 'off', model: '' }, storage: { kind: 'r2' }, templates: [{ type: 'bug', label: 'Bug', fields: [] }] };
    const keys = {};
    for (const config of [harbor, pantry]) {
      const created = await admin('/api/admin/projects', 'POST', { config });
      assert.equal(created.status, 201, await created.clone().text());
      keys[config.projectId] = (await created.json()).publicKey;
    }
    const origin = { harborline: 'https://harborline.example', 'pantry-planner': 'https://pantry.example' };
    const pictures = { screenshot: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(150_000)]), upload: Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), randomBytes(40_000)]) };
    const uploaded = {};
    const upload = async (name, kind, feedbackId) => {
      const r = await fetch(`${base}/api/upload?project=${keys.harborline}&feedbackId=${feedbackId}&kind=${kind}`, { method: 'POST', headers: { Origin: origin.harborline }, body: pictures[kind] });
      assert.equal(r.status, 200, await r.clone().text());
      uploaded[(await r.json()).key] = sha(pictures[kind]);
    };
    const report = async (name, message, type, attachmentKeys = [], feedbackId = randomUUID()) => {
      const r = await fetch(`${base}/api/feedback?project=${keys[name]}`, { method: 'POST', headers: { Origin: origin[name], 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 1, feedbackId, type, message, pageUrl: `${origin[name]}/page`, attachmentKeys, deviceInfo: { browser: 'Chrome', os: 'macOS', viewport: { w: 1280, h: 800 }, language: 'en' }, consoleErrors: [] }) });
      assert.ok(r.status < 500 || name !== 'harborline', await r.clone().text());
      return r.json();
    };
    const [first, second] = [randomUUID(), randomUUID()];
    await upload('shot', 'screenshot', first);
    await upload('file', 'upload', second);
    const [keyA, keyB] = Object.keys(uploaded);
    await report('harborline', 'The booking page shows the wrong time zone after I pick a slot.', 'bug', [keyA], first);
    await report('harborline', 'Please let me export my bookings as a calendar file.', 'idea', [keyB], second);
    for (let i = 3; i <= 5; i++) await report('harborline', `Fictional report number ${i} about the harbor map.`, 'bug');
    assert.equal((await report('pantry-planner', 'The shopping list loses an item when I reorder it.', 'bug')).status, 'issue_failed', 'no token is set, so the delivery fails and is saved');
    const current = await (await admin('/api/admin/projects/harborline/config')).json();
    const { publicKey: _key, configVersion, ...rest } = current;
    assert.equal((await admin('/api/admin/projects/harborline/config', 'PUT', { config: { ...rest, appearance: { heading: 'Tell us what happened', accent: '#7c3aed', theme: 'dark' } }, expectedVersion: configVersion })).status, 200);
    const inbox = (await (await admin('/api/admin/projects/harborline/feedback')).json()).items;
    assert.equal((await admin(`/api/admin/feedback/${inbox[0].id}`, 'PATCH', { disposition: 'done', note: 'Fixed in the next release.' })).status, 200);
    assert.equal((await admin(`/api/admin/feedback/${inbox[1].id}`, 'PATCH', { disposition: 'dismissed' })).status, 200);
    assert.equal((await admin('/api/admin/projects/harborline/test-report', 'POST', {})).status, 200);
    for (const name of ['opened', 'typed', 'submitted', 'completed']) await fetch(`${base}/api/events`, { method: 'POST', headers: { Origin: origin.harborline, 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 1, project: keys.harborline, name }) });

    // What the Worker says now, to compare with what the standalone server says later.
    const ask = async (get) => ({
      projects: (await (await get('/api/admin/projects')).json()).projects.map((p) => ({ id: p.id, publicKey: p.publicKey, configVersion: p.configVersion })),
      config: await Promise.all(['harborline', 'pantry-planner'].map(async (id) => (await get(`/api/admin/projects/${id}/config`)).json())),
      feedback: await Promise.all(['harborline', 'pantry-planner'].map(async (id) => (await get(`/api/admin/projects/${id}/feedback`)).json())),
      funnel: (await (await get('/api/admin/projects/harborline/funnel')).json()).steps ?? null,
    });
    const publicConfig = async (b, key, o) => (await fetch(`${b}/api/config?project=${key}`, { headers: { Origin: o } })).json();
    const before = await ask((path) => admin(path));
    const publicBefore = await publicConfig(base, keys.harborline, origin.harborline);
    assert.equal(before.feedback[0].items.length, 6, 'five reports and a test report');
    await stop(worker); worker = undefined;

    // ── export with the real wrangler, then import ──
    const wranglerCommand = wrangler;
    const lines = [];
    const exit = await main(['export', '--local', '--config', join(project, 'wrangler.toml'), '--wrangler', wranglerCommand, '--out', exportDir], { log: (l) => lines.push(l) });
    assert.equal(exit, 0, lines.join('\n'));
    const manifest = JSON.parse(readFileSync(join(exportDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.source.bucket, 'fk-fictional-bucket', 'the bucket name came from wrangler.toml');
    assert.deepEqual(manifest.rows, { projects: 2, feedback: 7, assets: 2, events: 4, dedup: 6 }, 'six submissions, one test report, two uploads, four funnel events');
    assert.deepEqual(manifest.objects.map((o) => [o.key, o.sha256]).sort(), Object.entries(uploaded).sort(), 'the attachments left the bucket byte for byte');
    assert.equal(manifest.schemaVersion, 4);

    const dry = []; assert.equal(await main(['import', '--from', exportDir, '--data-dir', data, '--dry-run'], { log: (l) => dry.push(l) }), 0);
    assert.match(dry.join('\n'), /Dry run: .* is empty\. Nothing was written\./);
    assert.match(dry.join('\n'), /Set these on the new host.*ADMIN_TOKEN, GITHUB_PAT_pantry/);
    assert.equal(await main(['import', '--from', exportDir, '--data-dir', data], { log: () => {} }), 0);
    const refusals = [];
    t.mock.method(console, 'error', (m) => refusals.push(m));
    assert.equal(await main(['import', '--from', exportDir, '--data-dir', data], { log: () => {} }), 2, 'a second import into the same directory is refused');
    assert.match(refusals[0], /already holds data/);
    t.mock.restoreAll();

    // ── the standalone server on the result ──
    const sport = await freePort(), sbase = `http://127.0.0.1:${sport}`;
    standalone = await startServer(process.execPath, [join(root, 'scripts/server.mjs')], { cwd: root, env: { PATH: process.env.PATH, HOME: dir, HOST: '127.0.0.1', PORT: String(sport), FK_PUBLIC_URL: sbase, FK_DATA_DIR: data, ADMIN_TOKEN: TOKEN }, base: sbase });
    const diag = await (await fetch(`${sbase}/diag`)).json();
    assert.equal(diag.schema.ok, true);
    const sadmin = (path) => fetch(sbase + path, { headers: { Authorization: `Bearer ${TOKEN}`, Origin: sbase } });
    const after = await ask(sadmin);
    assert.deepEqual(after.projects, before.projects, 'projects, public keys and settings revisions');
    assert.deepEqual(after.config, before.config, 'the stored settings');
    assert.deepEqual(after.feedback, before.feedback, 'reports with their delivery state, error, disposition, note and attachments');
    assert.deepEqual(after.funnel, before.funnel, 'the funnel');
    assert.deepEqual(await publicConfig(sbase, keys.harborline, origin.harborline), publicBefore, 'the widget config the embedded snippet loads, through the old project key');
    for (const [key, digest] of Object.entries(uploaded)) {
      const image = await sadmin(`/admin/assets/${key}`);
      assert.equal(image.status, 200, key);
      assert.equal(sha(Buffer.from(await image.arrayBuffer())), digest, `${key} downloads byte for byte`);
      assert.match(image.headers.get('content-type'), /^image\/(png|webp)$/);
    }
    const system = await (await sadmin('/api/admin/system')).json();
    assert.equal(system.schema.ok, true);
    assert.equal(system.secrets.githubPat, false, 'secrets are not in D1: the new host must set GITHUB_PAT_pantry');
    const pantryRow = after.feedback[1].items[0];
    assert.deepEqual([pantryRow.outcome, pantryRow.deliveryState, pantryRow.retryable], ['issue_failed', 'failed', true], 'a failed delivery is still retryable once the secret is set');
  } finally {
    await stop(worker); await stop(standalone);
    rmSync(dir, { recursive: true, force: true });
  }
});
