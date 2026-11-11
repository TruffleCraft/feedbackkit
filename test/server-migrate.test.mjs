import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { Refusal, exportFromCloudflare, importIntoServer, main, namesFromWranglerToml, parseArgs, secretNames } from '../scripts/feedbackkit-migrate.mjs';
import { openStorage } from '../scripts/server-storage.mjs';
import { buildBundle } from '../scripts/build-bundle.mjs';

// The tool that moves a Cloudflare gateway into the standalone server (journey J19). These tests build
// D1-style dumps of every schema version from the repo's own migrations, with fictional rows, and run
// the real import. The real wrangler against a real local D1 and R2 is in server-migrate-e2e.test.mjs.

const root = new URL('..', import.meta.url).pathname;
const migrations = join(root, 'migrations');
const temporary = () => mkdtempSync(join(tmpdir(), 'fk-migrate-'));
const sha = (data) => createHash('sha256').update(data).digest('hex');
const png = (n, seed = 1) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n, seed)]);
const webp = (n, seed = 2) => Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(n, seed)]);
const quiet = () => {};

/** A D1-style dump (what `wrangler d1 export` writes) of the repo's schema at `version`, with rows. */
function dump(version, rows) {
  const db = new DatabaseSync(':memory:');
  for (const name of readdirSync(migrations).filter((n) => n.endsWith('.sql')).sort()) if (Number(name.split('_')[0]) <= version) db.exec(readFileSync(join(migrations, name), 'utf8'));
  for (const [table, list] of Object.entries(rows)) {
    const have = db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
    for (const row of list) {
      const cols = Object.keys(row).filter((c) => have.includes(c));
      db.prepare(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c]));
    }
  }
  const lit = (v) => (v === null ? 'NULL' : typeof v === 'number' || typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? `X'${Buffer.from(v).toString('hex')}'` : `'${String(v).replace(/'/g, "''")}'`);
  const out = ['PRAGMA defer_foreign_keys=TRUE;', 'CREATE TABLE IF NOT EXISTS "d1_migrations"(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);', `INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(1,'0001_init.sql','2026-11-11 10:00:00');`];
  const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all();
  for (const t of tables) {
    out.push(`${t.sql};`);
    for (const row of db.prepare(`SELECT * FROM "${t.name}"`).all()) out.push(`INSERT INTO "${t.name}" (${Object.keys(row).map((c) => `"${c}"`).join(',')}) VALUES(${Object.values(row).map(lit).join(',')});`);
  }
  out.push('DELETE FROM sqlite_sequence;');
  for (const s of db.prepare('SELECT name, seq FROM sqlite_sequence').all()) out.push(`INSERT INTO "sqlite_sequence" ("name","seq") VALUES('${s.name}',${s.seq});`);
  for (const i of db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").all()) out.push(`${i.sql};`);
  db.close();
  return out.join('\n') + '\n';
}

const config = (id, extra = {}) => JSON.stringify({ projectId: id, locale: 'en', delivery: 'local', auth: { origins: [`https://${id}.example`] }, llm: { provider: 'off', model: '' }, storage: { kind: 'r2' }, templates: [{ type: 'bug', label: 'Bug', fields: [] }], ...extra });
const feedbackRow = (n, over = {}) => ({ id: `fb-${n}`, project_id: 'harborline', outcome: 'created', payload: JSON.stringify({ v: 1, feedbackId: `00000000-0000-4000-8000-00000000000${n}`, message: `Fictional report ${n}` }), issue_url: null, created_at: 1_790_000_000_000 + n, type: 'bug', title: `Report ${n}`, ...over });

const rowsV4 = (extraFeedback = []) => ({
  meta: [{ key: 'delivery_capability', value: '3' }],
  projects: [
    { id: 'harborline', public_key: 'fk_pub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', config: config('harborline'), config_version: 2, updated_at: 1_790_000_000_000 },
    { id: 'pantry', public_key: 'fk_pub_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', config: config('pantry', { delivery: 'issue', tracker: { kind: 'github', defaultRepo: 'pantry/app', patSecret: 'GITHUB_PAT_pantry' } }), config_version: 1, updated_at: 1_790_000_000_001 },
  ],
  counters: [{ key: 'fb:harborline:abc', window_start: 1, count: 5 }],
  dedup: [{ feedback_id: '00000000-0000-4000-8000-000000000001', response: '{"v":1,"status":"created"}', created_at: 1_790_000_000_001 }],
  events: [{ project_id: 'harborline', name: 'opened', ts: 1_790_000_000_002 }, { project_id: 'harborline', name: 'completed', ts: 1_790_000_000_003 }],
  assets: [
    { key: 'harborline/aaaa-1111.png', project_id: 'harborline', feedback_id: '00000000-0000-4000-8000-000000000001', kind: 'screenshot', expires_at: null, created_at: 1_790_000_000_001, deleted: 0 },
    { key: 'harborline/bbbb-2222.webp', project_id: 'harborline', feedback_id: '00000000-0000-4000-8000-000000000002', kind: 'upload', expires_at: 1_800_000_000_000, created_at: 1_790_000_000_002, deleted: 0 },
    { key: 'harborline/cccc-3333.png', project_id: 'harborline', feedback_id: '00000000-0000-4000-8000-000000000002', kind: 'upload', expires_at: 1_700_000_000_000, created_at: 1_690_000_000_002, deleted: 1 },
  ],
  feedback: [
    feedbackRow(1, { delivery: 'local', disposition: 'done', note: 'Fixed.', handled_at: 1_790_000_100_000, claim_token: 'tok', claim_until: 1_790_000_999_999 }),
    feedbackRow(2, { delivery: 'local', disposition: 'open' }),
    feedbackRow(3, { project_id: 'pantry', outcome: 'issue_failed', delivery: 'issue', delivery_state: 'failed', last_error: 'tracker credential not configured', retry_count: 1, issue_draft: '{"title":"x"}' }),
    ...extraFeedback,
  ],
});

/** Writes an export directory the way `feedbackkit-migrate export` does. */
function writeExport(dir, { version = 4, rows = rowsV4(), objects = { 'harborline/aaaa-1111.png': png(5000), 'harborline/bbbb-2222.webp': webp(3000) }, missing = [], tamper = {} } = {}) {
  mkdirSync(join(dir, 'objects'), { recursive: true });
  const sql = dump(version, rows);
  writeFileSync(join(dir, 'd1.sql'), tamper.sql ? sql + tamper.sql : sql);
  const list = [];
  for (const [key, data] of Object.entries(objects)) {
    mkdirSync(dirname(join(dir, 'objects', key)), { recursive: true });
    writeFileSync(join(dir, 'objects', key), tamper.object === key ? Buffer.concat([data, Buffer.from('x')]) : data);
    list.push({ key, bytes: data.length, sha256: sha(data) });
  }
  const manifest = { format: 1, exportedAt: '2026-11-11T10:00:00.000Z', source: { kind: 'local', database: 'feedbackkit', bucket: 'b' }, d1: { file: 'd1.sql', bytes: sql.length, sha256: sha(sql) }, schemaVersion: version, deliveryCapability: 3, rows: {}, objectsIncluded: true, objects: list, missing };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  return manifest;
}

const open = (dataDir) => new DatabaseSync(join(dataDir, 'feedbackkit.sqlite'), { readOnly: true });
const imp = (from, dataDir, extra = {}) => importIntoServer({ from, dataDir, root, log: quiet, ...extra });

test('an import moves projects, public keys, revisions, reports, inbox state, attachments and the capability, and leaves the counters behind', async () => {
  const [from, data] = [temporary(), temporary()];
  try {
    writeExport(from);
    const summary = await imp(from, data);
    assert.deepEqual(summary.rows, { projects: 2, feedback: 3, assets: 3, events: 2, dedup: 1 });
    assert.deepEqual({ count: summary.attachments.count, bytes: summary.attachments.bytes }, { count: 2, bytes: 8000 + 8 + 12 });
    assert.deepEqual(summary.secrets, ['ADMIN_TOKEN', 'GITHUB_PAT_pantry']);
    const db = open(data);
    assert.deepEqual(db.prepare('SELECT id, public_key, config_version FROM projects ORDER BY id').all().map((r) => ({ ...r })), [
      { id: 'harborline', public_key: 'fk_pub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', config_version: 2 },
      { id: 'pantry', public_key: 'fk_pub_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', config_version: 1 },
    ]);
    const done = db.prepare("SELECT disposition, note, handled_at, claim_token, claim_until, delivery FROM feedback WHERE id = 'fb-1'").get();
    assert.deepEqual({ ...done }, { disposition: 'done', note: 'Fixed.', handled_at: 1_790_000_100_000, claim_token: null, claim_until: null, delivery: 'local' }, 'inbox state arrives, a delivery claim does not');
    assert.deepEqual({ ...db.prepare("SELECT delivery_state, last_error, retry_count, issue_draft FROM feedback WHERE id = 'fb-3'").get() }, { delivery_state: 'failed', last_error: 'tracker credential not configured', retry_count: 1, issue_draft: '{"title":"x"}' });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM counters').get().n, 0, 'rate-limit counters do not move');
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'delivery_capability'").get().value, '3');
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '4');
    assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get().seq, 2, 'event ids carry on');
    db.close();
    // The server's own storage reads the attachments with their type.
    const storage = openStorage(join(data, 'feedbackkit.sqlite'), migrations);
    const object = await storage.UPLOADS.get('harborline/bbbb-2222.webp');
    assert.equal(object.httpMetadata.contentType, 'image/webp');
    assert.equal(sha(Buffer.from(object.body)), sha(webp(3000)));
    assert.equal(await storage.UPLOADS.get('harborline/cccc-3333.png'), null, 'a deleted asset has no object');
    storage.close();
  } finally { for (const d of [from, data]) rmSync(d, { recursive: true, force: true }); }
});

test('a dry run says what would move and writes nothing', async () => {
  const [from, data] = [temporary(), join(temporary(), 'not-created-yet')];
  try {
    writeExport(from);
    const lines = [];
    const summary = await imp(from, data, { dryRun: true, log: (l) => lines.push(l) });
    assert.equal(summary.dryRun, true);
    assert.match(lines.join('\n'), /Moves: 2 projects, 3 feedback, 3 assets, 2 events, 1 dedup; 2 attachments/);
    assert.match(lines.join('\n'), /Set these on the new host.*GITHUB_PAT_pantry/);
    assert.ok(!existsSync(data), 'no data directory, no database');
  } finally { rmSync(from, { recursive: true, force: true }); rmSync(dirname(data), { recursive: true, force: true }); }
});

test('an export of an older schema is brought up with the server\'s own migrations, backfills included', async () => {
  const [from, data] = [temporary(), temporary()];
  try {
    const rows = {
      meta: [],
      projects: [{ id: 'harborline', public_key: 'fk_pub_cccccccccccccccccccccccccccccccc', config: config('harborline'), config_version: 1, updated_at: 1 }],
      feedback: [
        feedbackRow(1, { issue_url: 'https://github.com/example/app/issues/7' }),
        feedbackRow(2, { outcome: 'issue_failed' }),
        feedbackRow(3, {}),
      ],
    };
    writeExport(from, { version: 1, rows, objects: {} });
    const summary = await imp(from, data);
    assert.deepEqual(summary.migrationsApplied, ['0002_admin.sql', '0003_feedback_identity.sql', '0004_delivery.sql']);
    const db = open(data);
    const by = Object.fromEntries(db.prepare('SELECT id, client_feedback_id, delivery, delivery_state, disposition FROM feedback').all().map((r) => [r.id, { ...r }]));
    assert.equal(by['fb-1'].client_feedback_id, '00000000-0000-4000-8000-000000000001', 'the v3 backfill ran');
    assert.deepEqual([by['fb-1'].delivery, by['fb-1'].delivery_state], ['issue', 'delivered'], 'the v4 backfill ran');
    assert.deepEqual([by['fb-2'].delivery, by['fb-2'].delivery_state], ['issue', 'failed']);
    assert.deepEqual([by['fb-3'].delivery, by['fb-3'].delivery_state, by['fb-3'].disposition], [null, null, 'open'], 'a row without proof of its destination stays unknown');
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '4');
    db.close();
  } finally { for (const d of [from, data]) rmSync(d, { recursive: true, force: true }); }
});

async function refused(promise, pattern) {
  await assert.rejects(promise, (e) => e instanceof Refusal && pattern.test(e.message), `expected a refusal like ${pattern}`);
}

test('the import refuses what it cannot move safely and leaves the destination as it was', async () => {
  const dir = temporary();
  try {
    const exportWith = (name, options) => { const from = join(dir, name); writeExport(from, options); return from; };
    const empty = join(dir, 'empty-data');

    // a schema or a delivery capability newer than this release
    const newer = rowsV4();
    newer.meta = [{ key: 'delivery_capability', value: '3' }];
    const newerSchema = exportWith('newer-schema', { rows: newer });
    writeFileSync(join(newerSchema, 'd1.sql'), readFileSync(join(newerSchema, 'd1.sql'), 'utf8').replace("INSERT INTO \"meta\" (\"key\",\"value\") VALUES('schema_version','4')", "INSERT INTO \"meta\" (\"key\",\"value\") VALUES('schema_version','99')"));
    const m = JSON.parse(readFileSync(join(newerSchema, 'manifest.json'), 'utf8')); m.d1.sha256 = sha(readFileSync(join(newerSchema, 'd1.sql'), 'utf8')); writeFileSync(join(newerSchema, 'manifest.json'), JSON.stringify(m));
    await refused(imp(newerSchema, empty), /schema 99 and this release supports 4/);
    const highCapability = rowsV4(); highCapability.meta = [{ key: 'delivery_capability', value: '9' }];
    await refused(imp(exportWith('high-capability', { rows: highCapability }), empty), /delivery capability 9 and this release provides 3/);
    assert.ok(!existsSync(empty), 'nothing was created');

    // a damaged or edited export
    await refused(imp(exportWith('edited-sql', { tamper: { sql: "\nDELETE FROM projects;\n" } }), empty), /d1\.sql does not match the checksum/);
    await refused(imp(exportWith('edited-object', { tamper: { object: 'harborline/aaaa-1111.png' } }), empty), /does not match its checksum/);
    const lost = exportWith('lost-object', {}); rmSync(join(lost, 'objects/harborline/aaaa-1111.png'));
    await refused(imp(lost, empty), /listed in the manifest but missing/);
    const wrongType = exportWith('wrong-type', { objects: { 'harborline/aaaa-1111.png': webp(100), 'harborline/bbbb-2222.webp': webp(3000) } });
    await refused(imp(wrongType, empty), /is not a png image/);
    const traversal = exportWith('traversal', { objects: { 'harborline/aaaa-1111.png': png(10), 'harborline/bbbb-2222.webp': webp(10) } });
    const manifest = JSON.parse(readFileSync(join(traversal, 'manifest.json'), 'utf8')); manifest.objects[0].key = '../../etc/x.png'; writeFileSync(join(traversal, 'manifest.json'), JSON.stringify(manifest));
    await refused(imp(traversal, empty), /unexpected shape/);
    await refused(imp(join(dir, 'nothing-here'), empty), /has no manifest\.json/);
    const futureFormat = exportWith('future-format', {}); const fm = JSON.parse(readFileSync(join(futureFormat, 'manifest.json'), 'utf8')); fm.format = 2; writeFileSync(join(futureFormat, 'manifest.json'), JSON.stringify(fm));
    await refused(imp(futureFormat, empty), /format 2/);

    // an attachment the database lists that the export does not account for
    const rows = rowsV4();
    await refused(imp(exportWith('unaccounted', { rows, objects: { 'harborline/aaaa-1111.png': png(10) } }), empty), /neither in the export nor listed as missing, for example harborline\/bbbb-2222\.webp/);
    assert.ok(!existsSync(empty), 'every refusal came before anything was written');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a destination that holds data is refused, and --replace-existing replaces it and keeps a copy', async () => {
  const [from, data] = [temporary(), temporary()];
  try {
    writeExport(from);
    const storage = openStorage(join(data, 'feedbackkit.sqlite'), migrations);
    await storage.DB.prepare("INSERT INTO projects (id, public_key, config, config_version, updated_at) VALUES ('old', 'fk_pub_old00000000000000000000000000000', '{}', 1, 1)").run();
    await storage.UPLOADS.put('old/x.png', png(10), { httpMetadata: { contentType: 'image/png' } });
    storage.close();

    await refused(imp(from, data), /already holds data \(projects, _fk_objects\)/);
    const unchanged = open(data);
    assert.equal(unchanged.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 1);
    unchanged.close();
    const dry = await imp(from, data, { dryRun: true, replaceExisting: true });
    assert.deepEqual(dry.destinationHadData, ['projects', '_fk_objects']);

    const summary = await imp(from, data, { replaceExisting: true });
    assert.ok(summary.backup && existsSync(summary.backup), 'the old database is kept');
    const kept = new DatabaseSync(summary.backup, { readOnly: true });
    assert.equal(kept.prepare("SELECT COUNT(*) AS n FROM projects WHERE id = 'old'").get().n, 1);
    kept.close();
    const db = open(data);
    assert.deepEqual(db.prepare('SELECT id FROM projects ORDER BY id').all().map((r) => r.id), ['harborline', 'pantry']);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM _fk_objects').get().n, 2, 'the old object is gone');
    db.close();
  } finally { for (const d of [from, data]) rmSync(d, { recursive: true, force: true }); }
});

test('the import checks what it wrote and rolls everything back when the copy does not match the export', async () => {
  const from = temporary();
  try {
    writeExport(from);
    // A trigger in the destination stands in for any fault that changes data on its way in.
    const cases = [
      ['a row that changes', "CREATE TRIGGER fault AFTER INSERT ON projects BEGIN UPDATE projects SET config = '{}' WHERE id = NEW.id; END", /projects: the rows differ from the export/],
      ['a row that disappears', "CREATE TRIGGER fault AFTER INSERT ON events BEGIN DELETE FROM events WHERE id = NEW.id; END", /events: 0 rows, expected 2/],
      ['an attachment that changes', "CREATE TRIGGER fault AFTER INSERT ON _fk_objects BEGIN UPDATE _fk_objects SET data = x'00' WHERE key = NEW.key; END", /attachment harborline\/aaaa-1111\.png: missing or its checksum differs/],
    ];
    for (const [name, trigger, pattern] of cases) {
      const data = temporary();
      try {
        const storage = openStorage(join(data, 'feedbackkit.sqlite'), migrations);
        storage.sqlite.exec(trigger);
        storage.close();
        await assert.rejects(imp(from, data), (e) => !(e instanceof Refusal) && /the copy does not match the export, nothing was written/.test(e.message) && pattern.test(e.message), name);
        const db = open(data);
        assert.deepEqual(['projects', 'feedback', 'assets', 'events', 'dedup', '_fk_objects'].map((t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n), [0, 0, 0, 0, 0, 0], `${name}: nothing was written`);
        db.close();
      } finally { rmSync(data, { recursive: true, force: true }); }
    }
  } finally { rmSync(from, { recursive: true, force: true }); }
});

test('attachments missing in the bucket are reported and kept as rows, and an export without attachments says so', async () => {
  const [from, data] = [temporary(), temporary()];
  try {
    writeExport(from, { objects: { 'harborline/aaaa-1111.png': png(10) }, missing: [{ key: 'harborline/bbbb-2222.webp', error: 'not found' }] });
    const lines = [];
    const summary = await imp(from, data, { log: (l) => lines.push(l) });
    assert.equal(summary.attachments.missingInBucket, 1);
    assert.match(lines.join('\n'), /1 attachment was listed in the database but not found in the bucket/);
    const db = open(data);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 3);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM _fk_objects').get().n, 1);
    db.close();
  } finally { for (const d of [from, data]) rmSync(d, { recursive: true, force: true }); }
  const [bare, data2] = [temporary(), temporary()];
  try {
    const manifest = writeExport(bare, { objects: {} });
    writeFileSync(join(bare, 'manifest.json'), JSON.stringify({ ...manifest, objectsIncluded: false }));
    const lines = [];
    const summary = await imp(bare, data2, { log: (l) => lines.push(l) });
    assert.equal(summary.attachments.included, false);
    assert.match(lines.join('\n'), /without attachments/);
  } finally { for (const d of [bare, data2]) rmSync(d, { recursive: true, force: true }); }
});

test('the names of the secrets the new host needs come from the project settings, never their values', () => {
  const projects = [
    { config: JSON.stringify({ llm: { provider: 'openrouter' }, tracker: { patSecret: 'GITHUB_PAT_a', project: { patSecret: 'GITHUB_PAT_projects' } }, turnstile: { secret: 'TURNSTILE_SECRET_site' } }) },
    { config: JSON.stringify({ llm: { provider: 'off' } }) },
    { config: 'not json' },
  ];
  assert.deepEqual(secretNames(projects), ['ADMIN_TOKEN', 'GITHUB_PAT_a', 'GITHUB_PAT_projects', 'LLM_API_KEY', 'TURNSTILE_SECRET_site']);
  assert.deepEqual(secretNames([]), ['ADMIN_TOKEN']);
});

test('the command line reads its options, names the bucket from wrangler.toml, and exits 2 on a refusal', async (t) => {
  assert.deepEqual(parseArgs(['import', '--from', 'x', '--dry-run', '--data-dir', '/d']), { _: ['import'], from: 'x', 'dry-run': true, 'data-dir': '/d' });
  assert.throws(() => parseArgs(['export', '--out']), /needs a value/);
  const toml = `name = "feedbackkit"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "my-db"\ndatabase_id = "x"\n\n[[r2_buckets]]\nbinding = "UPLOADS"\nbucket_name = "my-bucket"\n`;
  assert.deepEqual(namesFromWranglerToml(toml), { bucket: 'my-bucket', database: 'my-db' });
  assert.deepEqual(namesFromWranglerToml('name = "x"'), { bucket: null, database: null });
  const messages = [];
  t.mock.method(console, 'error', (m) => messages.push(m));
  assert.equal(await main(['import', '--from', join(temporary(), 'none')], { log: quiet }), 2);
  assert.match(messages[0], /^Refused: .*no manifest\.json/);
  assert.equal(await main(['frobnicate'], { log: quiet }), 2);
  assert.equal(await main([], { log: quiet }), 0);
});

test('the release tarball carries the command, and it imports with Node alone, reading its limits from bundle.json', async () => {
  const [out, dest, from, data] = [temporary(), temporary(), temporary(), temporary()];
  try {
    const built = await buildBundle({ root, outDir: out, release: '4.5.6', commit: 'abc', epoch: 1_800_000_000 });
    execFileSync('tar', ['-xzf', join(out, built.name), '-C', dest]);
    const dir = join(dest, 'feedbackkit-v4.5.6');
    const manifest = JSON.parse(readFileSync(join(dir, 'bundle.json'), 'utf8'));
    assert.ok(manifest.files.includes('feedbackkit-migrate.mjs'));
    assert.equal(readFileSync(join(dir, 'feedbackkit-migrate.mjs'), 'utf8').split('\n')[0], '#!/usr/bin/env node');
    writeExport(from);
    const env = { PATH: process.env.PATH, HOME: data };
    // Started through a link, as /opt/feedbackkit/current is: the command must still run.
    const link = join(dest, 'current');
    symlinkSync(dir, link);
    const ran = (args) => spawnSync(process.execPath, [join(link, 'feedbackkit-migrate.mjs'), ...args], { cwd: dir, env, encoding: 'utf8' });
    const dry = ran(['import', '--from', from, '--data-dir', join(data, 'db'), '--dry-run']);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /Moves: 2 projects, 3 feedback/);
    assert.ok(!existsSync(join(data, 'db')));
    const real = ran(['import', '--from', from, '--data-dir', join(data, 'db'), '--json']);
    assert.equal(real.status, 0, real.stderr);
    assert.deepEqual(JSON.parse(real.stdout).rows, { projects: 2, feedback: 3, assets: 3, events: 2, dedup: 1 });
    // The bundle's own record decides what is too new, not the repository's source.
    const newer = JSON.parse(readFileSync(join(dir, 'bundle.json'), 'utf8'));
    writeFileSync(join(dir, 'bundle.json'), JSON.stringify({ ...newer, schemaVersion: 3 }));
    const refusedRun = ran(['import', '--from', from, '--data-dir', join(data, 'other')]);
    assert.equal(refusedRun.status, 2);
    assert.match(refusedRun.stderr, /Refused: the export has schema 4 and this release supports 3/);
  } finally { for (const d of [out, dest, from, data]) rmSync(d, { recursive: true, force: true }); }
});

// ── export, with a stand-in for wrangler (the real one runs in server-migrate-e2e.test.mjs) ──────

/** A wrangler stand-in: `d1 export` copies a prepared dump, `r2 object get` writes a file or fails. */
function fakeWrangler(dir, { sql, objects, failExport = false, flaky = false }) {
  writeFileSync(join(dir, 'dump.sql'), sql);
  mkdirSync(join(dir, 'bucket'), { recursive: true });
  for (const [key, data] of Object.entries(objects)) { mkdirSync(dirname(join(dir, 'bucket', key)), { recursive: true }); writeFileSync(join(dir, 'bucket', key), data); }
  const script = join(dir, 'wrangler.mjs');
  writeFileSync(script, `import { copyFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const a = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, a.join(' ') + '\\n');
const at = (flag) => a[a.indexOf(flag) + 1];
if (a[0] === 'd1' && a[1] === 'export') {
  if (${failExport}) { console.error('You are not logged in'); process.exit(1); }
  copyFileSync(${JSON.stringify(join(dir, 'dump.sql'))}, at('--output'));
} else if (a[0] === 'r2' && a[1] === 'object' && a[2] === 'get') {
  const [bucket, ...key] = a[3].split('/');
  const source = join(${JSON.stringify(join(dir, 'bucket'))}, ...key);
  if (bucket !== 'my-bucket' || !existsSync(source)) { console.error('The specified key does not exist.'); process.exit(1); }
  if (${flaky}) {
    const mark = join(${JSON.stringify(dir)}, 'tried-' + key.join('-'));
    if (!existsSync(mark)) { appendFileSync(mark, 'x'); console.error('database is locked: SQLITE_BUSY'); console.error('Logs were written to "/tmp/x.log"'); process.exit(1); }
  }
  mkdirSync(dirname(at('--file')), { recursive: true });
  copyFileSync(source, at('--file'));
} else process.exit(2);
`);
  return `${process.execPath} ${script}`;
}

test('export reads the dump and every attachment, records what is missing, and writes a manifest the import accepts', async () => {
  const dir = temporary();
  try {
    const objects = { 'harborline/aaaa-1111.png': png(5000), 'harborline/bbbb-2222.webp': webp(3000) };
    const wrangler = fakeWrangler(dir, { sql: dump(4, rowsV4()), objects });
    const out = join(dir, 'out'), lines = [];
    const manifest = await exportFromCloudflare({ out, bucket: 'my-bucket', wrangler, log: (l) => lines.push(l) });
    assert.deepEqual(manifest.rows, { projects: 2, feedback: 3, assets: 3, events: 2, dedup: 1 });
    assert.deepEqual(manifest.objects.map((o) => o.key), ['harborline/aaaa-1111.png', 'harborline/bbbb-2222.webp']);
    assert.equal(manifest.objects[0].sha256, sha(objects['harborline/aaaa-1111.png']));
    assert.equal(manifest.schemaVersion, 4);
    assert.match(readFileSync(join(dir, 'calls.log'), 'utf8'), /^d1 export feedbackkit --remote --output .*d1\.sql -y$/m, 'it reads the remote database by default, and only exports');
    assert.deepEqual(readFileSync(join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean).map((l) => l.split(' ').slice(0, 3).join(' ')).sort(), ['d1 export feedbackkit', 'r2 object get', 'r2 object get']);
    // The import takes it as it is.
    const data = join(dir, 'data');
    await imp(out, data);
    assert.equal(open(data).prepare('SELECT COUNT(*) AS n FROM feedback').get().n, 3);

    // An object the bucket lacks is listed, not fatal.
    rmSync(join(dir, 'bucket/harborline/bbbb-2222.webp'));
    const partial = await exportFromCloudflare({ out: join(dir, 'out2'), bucket: 'my-bucket', wrangler, log: quiet });
    assert.deepEqual(partial.missing.map((m) => m.key), ['harborline/bbbb-2222.webp']);
    assert.equal(partial.objects.length, 1);
    // No object at all means the bucket name or the login is wrong.
    const wrongBucket = await exportFromCloudflare({ out: join(dir, 'out3'), bucket: 'not-mine', wrangler, log: quiet }).catch((e) => e);
    assert.match(wrongBucket.message, /no attachment could be downloaded.*"not-mine".*does not exist/);
    // --no-objects exports the database only.
    const bare = await exportFromCloudflare({ out: join(dir, 'out4'), objects: false, wrangler, log: quiet });
    assert.deepEqual([bare.objectsIncluded, bare.objects.length], [false, 0]);
    // An export directory that has files is never reused.
    await assert.rejects(exportFromCloudflare({ out, bucket: 'my-bucket', wrangler, log: quiet }), /is not empty/);
    // The bucket is required unless attachments are skipped.
    await assert.rejects(exportFromCloudflare({ out: join(dir, 'out5'), wrangler, log: quiet }), /bucket name is needed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('export tries an object again when wrangler fails for another reason than a missing key, and says what went wrong', async () => {
  const dir = temporary();
  try {
    const objects = { 'harborline/aaaa-1111.png': png(100), 'harborline/bbbb-2222.webp': webp(100) };
    const wrangler = fakeWrangler(dir, { sql: dump(4, rowsV4()), objects, flaky: true });
    const manifest = await exportFromCloudflare({ out: join(dir, 'out'), bucket: 'my-bucket', wrangler, local: true, log: quiet });
    assert.deepEqual([manifest.objects.length, manifest.missing.length], [2, 0], 'each object failed once and then came');
    const calls = readFileSync(join(dir, 'calls.log'), 'utf8').split('\n').filter((l) => l.startsWith('r2 object get'));
    assert.equal(calls.length, 4);
    // A key that is not in the bucket is not tried again, and the reason is the useful line.
    rmSync(join(dir, 'bucket/harborline/bbbb-2222.webp'));
    const partial = await exportFromCloudflare({ out: join(dir, 'out2'), bucket: 'my-bucket', wrangler, local: true, log: quiet });
    assert.deepEqual(partial.missing, [{ key: 'harborline/bbbb-2222.webp', error: 'The specified key does not exist.' }]);
    assert.equal(readFileSync(join(dir, 'calls.log'), 'utf8').split('\n').filter((l) => l.includes('bbbb-2222')).length, 3, 'two attempts in the first export, one in the second: a key that is not in the bucket is not tried again');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('export reads the bucket and database names from wrangler.toml, and a failing wrangler stops it with its message', async () => {
  const dir = temporary();
  try {
    writeFileSync(join(dir, 'wrangler.toml'), `[[d1_databases]]\nbinding = "DB"\ndatabase_name = "my-db"\n[[r2_buckets]]\nbinding = "UPLOADS"\nbucket_name = "my-bucket"\n`);
    const wrangler = fakeWrangler(dir, { sql: dump(4, rowsV4()), objects: { 'harborline/aaaa-1111.png': png(10), 'harborline/bbbb-2222.webp': webp(10) } });
    const manifest = await exportFromCloudflare({ out: join(dir, 'out'), config: join(dir, 'wrangler.toml'), local: true, wrangler, log: quiet });
    assert.equal(manifest.source.database, 'my-db');
    assert.equal(manifest.source.bucket, 'my-bucket');
    assert.match(readFileSync(join(dir, 'calls.log'), 'utf8'), /d1 export my-db --local --output .* -y -c .*wrangler\.toml/);
    const failing = fakeWrangler(temporary(), { sql: '', objects: {}, failExport: true });
    await assert.rejects(exportFromCloudflare({ out: join(dir, 'out-fail'), bucket: 'b', wrangler: failing, log: quiet }), /wrangler d1 export failed.*You are not logged in/s);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
