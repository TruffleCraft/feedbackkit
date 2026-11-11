// pnpm admin:link (the Cloudflare path of S14) against a stand-in for wrangler that
// runs the statements on a SQLite database with the real migrations and answers
// in wrangler's JSON shape. The link it prints must be one the gateway accepts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openStorage } from '../scripts/server-storage.mjs';
import { buildLink } from '../scripts/admin-link.mjs';
import { openLink } from '../dist-server/auth.mjs';

const temporary = () => mkdtempSync(join(tmpdir(), 'fk-adminlink-'));

// A wrangler stand-in: `d1 execute <db> --remote --json --command <sql>` runs each statement on FK_FAKE_DB.
function fakeWrangler(dir) {
  const file = join(dir, 'wrangler');
  writeFileSync(file, `#!${process.execPath}
const { DatabaseSync } = require('node:sqlite');
const args = process.argv.slice(2);
const sql = args[args.indexOf('--command') + 1];
const db = new DatabaseSync(process.env.FK_FAKE_DB);
const out = [];
for (const statement of sql.split(';\\n')) {
  const s = statement.trim(); if (!s) continue;
  if (/^select/i.test(s)) out.push({ results: db.prepare(s).all(), success: true, meta: { changes: 0 } });
  else out.push({ results: [], success: true, meta: { changes: Number(db.prepare(s).run().changes) } });
}
console.log(JSON.stringify(out));
`);
  chmodSync(file, 0o755);
  return file;
}

function run(dir, args, db) {
  const r = spawnSync(process.execPath, ['scripts/admin-link.mjs', ...args], { env: { PATH: process.env.PATH, FK_WRANGLER: join(dir, 'wrangler'), FK_FAKE_DB: db }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

const setup = () => {
  const dir = temporary();
  const db = join(dir, 'db.sqlite');
  openStorage(db, 'migrations').close();
  fakeWrangler(dir);
  return { dir, db, done: () => rmSync(dir, { recursive: true, force: true }) };
};
const rows = (db, sql) => { const d = new DatabaseSync(db); try { return d.prepare(sql).all().map((r) => ({ ...r })); } finally { d.close(); } };
const asEnv = (db) => { const s = new DatabaseSync(db); return { s, env: { DB: { prepare: (sql) => { const st = (v = []) => ({ bind: (...b) => st(b), first: async () => s.prepare(sql).get(...v) ?? null, all: async () => ({ results: s.prepare(sql).all(...v) }), run: async () => ({ meta: { changes: Number(s.prepare(sql).run(...v).changes) } }) }); return st(); } } } }; };

test('the link for the first owner is stored hashed, printed alone on stdout and accepted by the gateway', async () => {
  const t = setup();
  try {
    const r = run(t.dir, ['--url', 'https://feedbackkit.example.org'], t.db);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^https:\/\/feedbackkit\.example\.org\/admin\/setup#fk_link_[A-Za-z0-9_-]{43}$/);
    const token = r.out.split('#')[1];
    const [row] = rows(t.db, 'SELECT * FROM setup_links');
    assert.deepEqual({ id: row.id, purpose: row.purpose, account: row.account_id, by: row.created_by, ttl: row.expires_at - row.created_at }, { id: createHash('sha256').update(token).digest('hex'), purpose: 'bootstrap', account: null, by: 'cloudflare', ttl: 30 * 60_000 });
    assert.ok(!JSON.stringify(rows(t.db, 'SELECT * FROM setup_links')).includes(token));
    const { s, env } = asEnv(t.db);
    assert.deepEqual(await openLink(env, token), { id: row.id, purpose: 'bootstrap', accountId: null, expiresAt: row.expires_at });
    s.close();
  } finally { t.done(); }
});

test('it refuses once an owner exists, and recovery then needs a name only when there are several owners', () => {
  const t = setup();
  try {
    const d = new DatabaseSync(t.db);
    d.prepare("INSERT INTO accounts (id, name, name_key, role, state, created_at) VALUES ('a1', 'Robin', 'robin', 'owner', 'active', 1)").run();
    d.prepare('INSERT INTO owner_claim (singleton, account_id, claimed_at) VALUES (1, \'a1\', 1)').run();
    d.close();
    const first = run(t.dir, ['--url', 'https://gw.example.org'], t.db);
    assert.equal(first.code, 1);
    assert.match(first.err, /An owner already exists/);
    assert.equal(rows(t.db, 'SELECT * FROM setup_links').length, 0);

    const rec = run(t.dir, ['--url', 'https://gw.example.org', '--recovery'], t.db);
    assert.equal(rec.code, 0, rec.err);
    const [row] = rows(t.db, 'SELECT * FROM setup_links');
    assert.deepEqual({ purpose: row.purpose, account: row.account_id }, { purpose: 'recovery', account: 'a1' });

    const d2 = new DatabaseSync(t.db);
    d2.prepare("INSERT INTO accounts (id, name, name_key, role, state, created_at) VALUES ('a2', 'Sam O''Neil', 'sam o''neil', 'owner', 'active', 2)").run();
    d2.close();
    const several = run(t.dir, ['--url', 'https://gw.example.org', '--recovery'], t.db);
    assert.equal(several.code, 1);
    assert.match(several.err, /Name the user with --user\. Owners: Robin, Sam O'Neil/);
    const named = run(t.dir, ['--url', 'https://gw.example.org', '--recovery', '--user', "sam o'neil", '--minutes', '10'], t.db);
    assert.equal(named.code, 0, named.err);
    const links = rows(t.db, 'SELECT account_id, expires_at - created_at AS ttl FROM setup_links ORDER BY account_id');
    assert.deepEqual(links, [{ account_id: 'a1', ttl: 30 * 60_000 }, { account_id: 'a2', ttl: 600_000 }]);
    assert.match(run(t.dir, ['--url', 'https://gw.example.org', '--recovery', '--user', 'Nobody'], t.db).err, /No active user named "Nobody"/);
    assert.match(run(t.dir, ['--url', 'https://gw.example.org', '--recovery', '--account', 'Nobody'], t.db).err, /No active user named "Nobody"/, '--account is the old name of --user');
    // The default revokes the account's API tokens at redemption; --keep-tokens writes the opt-out into the link.
    const keep = (db) => rows(db, "SELECT keep_tokens FROM setup_links WHERE account_id = 'a2'")[0].keep_tokens;
    assert.equal(keep(t.db), 0);
    assert.match(run(t.dir, ['--url', 'https://gw.example.org', '--recovery', '--user', "sam o'neil", '--keep-tokens'], t.db).err, /keeps the API tokens/);
    assert.equal(keep(t.db), 1);
    assert.equal(run(t.dir, ['--url', 'https://gw.example.org', '--keep-tokens'], t.db).code, 1, '--keep-tokens needs --recovery');
  } finally { t.done(); }
});

test('--print-sql prints the statements and runs nothing; bad input is refused', () => {
  const t = setup();
  try {
    const r = run(t.dir, ['--url', 'https://gw.example.org', '--print-sql'], t.db);
    assert.equal(r.code, 0);
    assert.match(r.out, /^DELETE FROM setup_links[\s\S]*;\nINSERT INTO setup_links[\s\S]*WHERE NOT EXISTS \(SELECT 1 FROM owner_claim\);$/);
    assert.match(r.err, /https:\/\/gw\.example\.org\/admin\/setup#fk_link_/);
    assert.equal(rows(t.db, 'SELECT * FROM setup_links').length, 0);
    assert.equal(run(t.dir, [], t.db).code, 1);
    assert.equal(run(t.dir, ['--url', 'https://gw.example.org/path'], t.db).code, 1);
    assert.equal(run(t.dir, ['--url', 'https://gw.example.org', '--minutes', '500'], t.db).code, 1);
    assert.equal(run(t.dir, ['--url', 'https://gw.example.org', '--user', 'Robin'], t.db).code, 1);
  } finally { t.done(); }
});

test('a name with a quote cannot break out of the statement', () => {
  const { statements } = buildLink({ url: 'https://gw.example.org', recovery: true, account: "x' OR '1'='1", minutes: 30 }, 1000, 'fk_link_fixed');
  assert.ok(statements[1].includes("a.name_key = 'x'' or ''1''=''1'"));
});
