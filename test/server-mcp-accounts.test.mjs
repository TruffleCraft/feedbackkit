import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { buildBundle } from '../scripts/build-bundle.mjs';
import { openStorage } from '../scripts/server-storage.mjs';
import { ORIGIN, REDIRECT, TOKEN as ADMIN_TOKEN, authorizePath, browser, form, gateway, pkce, postDecision, register, rpc, exchange } from './oauth-harness.mjs';

// MCP on a standalone server with the account system (ADR-015, second amendment): the account's session cookie is the identity at
// /oauth/authorize, and a scoped API token an owner created is a bearer on /mcp. Real accounts, sessions and tokens in the SQLite
// file, the bundled application, no stub sign-in. The same token cases run against D1 and SQLite in test/durable/mcp-oauth-flow.test.ts;
// here they run through the esbuild bundle, and the consent runs end to end, also against the unpacked release with a process and a socket.

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');

/** An account, optionally the owner claim, a live session and its cookie header. Works on any openStorage database. */
function seedAccount(sqlite, { id = 'acct-1', name = 'Robin', role = 'owner', state = 'active', cookieName = '__Host-fk_session' } = {}) {
  sqlite.prepare('INSERT INTO accounts (id, name, name_key, role, state, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, name, name.toLowerCase(), role, state, 1);
  if (role === 'owner' && !sqlite.prepare('SELECT 1 FROM owner_claim').get()) sqlite.prepare('INSERT INTO owner_claim (singleton, account_id, claimed_at) VALUES (1, ?, 1)').run(id);
  const session = `fk_ses_${b64url(randomBytes(32))}`;
  const now = Date.now();
  sqlite.prepare('INSERT INTO sessions (id, public_id, account_id, created_at, last_seen_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?, NULL)').run(sha256(session), `pub-${id}`, id, now, now, now + 86_400_000);
  return { id, cookie: `${cookieName}=${session}` };
}

function seedToken(sqlite, { accountId = 'acct-1', name = 'litellm', access = 'read', projects = null, expiresAt = Date.now() + 30 * 86_400_000, revokedAt = null } = {}) {
  const token = `fk_tok_${b64url(randomBytes(32))}`;
  const id = `tok-${b64url(randomBytes(6))}`;
  sqlite.prepare('INSERT INTO api_tokens (id, token_hash, prefix, name, account_id, access, projects, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, sha256(token), token.slice(0, 13), name, accountId, access, projects ? JSON.stringify(projects) : null, 1, expiresAt, revokedAt);
  return { token, id };
}

const withGateway = (fn, options) => async (t) => { const gw = await gateway({ authenticate: null, ...options }); try { await fn(gw, t); } finally { gw.close(); } };
const location = (response) => new URL(response.headers.get('Location'));
const grantRows = (gw) => gw.storage.sqlite.prepare("SELECT key FROM _fk_kv WHERE key LIKE 'grant:%'").all();
/** Opens the consent page as a browser would, with the account's session cookie. */
async function consentWith(gw, path, cookie) {
  const jar = browser();
  const response = await gw.request(path, { headers: cookie ? { Cookie: cookie } : {} });
  jar.remember(response);
  const html = await response.text();
  return { response, html, jar, handle: /name="handle" value="([^"]+)"/.exec(html)?.[1] ?? '' };
}

// The harness' stub sign-in is off here ({ authenticate: null }): the server's own seam answers, with the account session.
// Each request still gets the stub's header from the harness; it must make no difference.

// ---- consent with an account's session -------------------------------------------------------------------------

test('without a session nothing is granted and the page says where to sign in; the stub header, an Access header and a bearer make no difference', withGateway(async (gw) => {
  const clientId = await register(gw);
  const { challenge } = await pkce();
  const page = await gw.request(authorizePath(clientId, { challenge }), { headers: { 'Cf-Access-Jwt-Assertion': 'a.b.c', Authorization: `Bearer ${ADMIN_TOKEN}` } });
  assert.equal(page.status, 403);
  assert.equal(page.headers.getSetCookie().length, 0);
  const html = await page.text();
  assert.match(html, /Sign-in required/);
  assert.ok(html.includes(`${ORIGIN}/admin`));
  assert.doesNotMatch(html, /name="handle"|type="password"/);
  assert.equal(gw.storage.sqlite.prepare("SELECT count(*) AS n FROM _fk_kv WHERE key LIKE 'transaction:%'").get().n, 0);
  assert.equal(grantRows(gw).length, 0);
}));

test('a signed-in account approves: the page names it, the grant belongs to it, and the tools work', withGateway(async (gw) => {
  const robin = seedAccount(gw.storage.sqlite);
  const clientId = await register(gw);
  const { verifier, challenge } = await pkce();
  const { response, html, handle, jar } = await consentWith(gw, authorizePath(clientId, { scope: 'feedback:read', challenge }), robin.cookie);
  assert.equal(response.status, 200);
  assert.ok(html.includes('Signed in as <b>Robin</b>'));
  // The form posts with the session cookie and the handle's cookie.
  const done = await postDecision(gw, { handle, jar, headers: { Cookie: `${robin.cookie}; ${jar.cookie()}` } });
  assert.equal(done.status, 302);
  const code = location(done).searchParams.get('code');
  assert.ok(code);
  assert.deepEqual(grantRows(gw).map((r) => r.key.split(':')[1]), ['acct-1'], 'keyed by the account id');
  const tokens = await (await exchange(gw, { clientId, code, verifier })).json();
  const who = (await rpc(gw, tokens.access_token, 'tools/call', { name: 'whoami', arguments: {} })).body.result.structuredContent;
  assert.equal(who.email, 'Robin');
  assert.deepEqual(who.scopes, ['feedback:read']);
  assert.equal((await rpc(gw, tokens.access_token, 'tools/call', { name: 'list_projects', arguments: {} })).body.result.structuredContent.projects[0].id, 'demo');
}));

test('a member approves like an owner; a removed or expired account, a session the database does not know and a session of another origin cookie name do not', withGateway(async (gw) => {
  const clientId = await register(gw);
  const { challenge } = await pkce();
  const open = async (cookie) => (await consentWith(gw, authorizePath(clientId, { challenge }), cookie)).response.status;
  const member = seedAccount(gw.storage.sqlite, { id: 'acct-m', name: 'Sam', role: 'member' });
  assert.equal(await open(member.cookie), 200);
  const gone = seedAccount(gw.storage.sqlite, { id: 'acct-r', name: 'Gone', role: 'member' });
  gw.storage.sqlite.prepare("UPDATE accounts SET state = 'removed' WHERE id = 'acct-r'").run();
  assert.equal(await open(gone.cookie), 403, 'removed account');
  const idle = seedAccount(gw.storage.sqlite, { id: 'acct-i', name: 'Idle', role: 'member' });
  gw.storage.sqlite.prepare('UPDATE sessions SET last_seen_at = 1 WHERE account_id = ?').run('acct-i');
  assert.equal(await open(idle.cookie), 403, 'idle for more than the limit');
  assert.equal(await open(`__Host-fk_session=fk_ses_${'z'.repeat(43)}`), 403, 'unknown session');
  assert.equal(await open(member.cookie.replace('__Host-fk_session', 'fk_session')), 403, 'wrong cookie name for an https gateway');
  assert.equal(grantRows(gw).length, 0);
}));

test('Allow needs the session too, and a form from another origin is blocked even with it', withGateway(async (gw) => {
  const robin = seedAccount(gw.storage.sqlite);
  const clientId = await register(gw);
  const { challenge } = await pkce();
  const { handle, jar } = await consentWith(gw, authorizePath(clientId, { challenge }), robin.cookie);
  const noSession = await postDecision(gw, { handle, jar });
  assert.equal(noSession.status, 403);
  assert.equal(grantRows(gw).length, 0);
  const cross = await postDecision(gw, { handle, jar, origin: 'https://evil.example', headers: { Cookie: `${robin.cookie}; ${jar.cookie()}`, 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(cross.status, 403);
  assert.match(await cross.text(), /Request blocked/);
  assert.equal(grantRows(gw).length, 0);
  assert.equal((await postDecision(gw, { handle, jar, headers: { Cookie: `${robin.cookie}; ${jar.cookie()}` } })).status, 302, 'the page was not spent by the refusals');
}));

test('an OAuth connection ends when the account that approved it is removed, and the connection of another account does not', withGateway(async (gw) => {
  const robin = seedAccount(gw.storage.sqlite);
  const sam = seedAccount(gw.storage.sqlite, { id: 'acct-s', name: 'Sam', role: 'member' });
  const connect = async (account) => {
    const clientId = await register(gw);
    const { verifier, challenge } = await pkce();
    const { handle, jar } = await consentWith(gw, authorizePath(clientId, { challenge }), account.cookie);
    const done = await postDecision(gw, { handle, jar, headers: { Cookie: `${account.cookie}; ${jar.cookie()}` } });
    return (await (await exchange(gw, { clientId, code: location(done).searchParams.get('code'), verifier })).json()).access_token;
  };
  const mine = await connect(robin);
  const hers = await connect(sam);
  assert.equal((await rpc(gw, mine, 'tools/list')).status, 200);
  gw.storage.sqlite.prepare("UPDATE accounts SET state = 'removed' WHERE id = 'acct-1'").run();
  const ended = await rpc(gw, mine, 'tools/list');
  assert.equal(ended.status, 401);
  assert.match(ended.text, /no longer active/);
  assert.equal((await rpc(gw, hers, 'tools/list')).status, 200);
}));

// ---- scoped API tokens as a bearer, through the bundle ---------------------------------------------------------

test('an API token reads through the bundled server: valid read and write tokens work, the legacy ADMIN_TOKEN and made-up tokens do not', withGateway(async (gw) => {
  seedAccount(gw.storage.sqlite);
  for (const access of ['read', 'write']) {
    const { token } = seedToken(gw.storage.sqlite, { access, name: `t-${access}` });
    const tools = await rpc(gw, token, 'tools/list');
    assert.equal(tools.status, 200, access);
    assert.ok(tools.body.result.tools.some((t) => t.name === 'get_config'));
    assert.equal((await rpc(gw, token, 'tools/call', { name: 'list_feedback', arguments: { project: 'demo' } })).body.result.structuredContent.items.length, 1);
  }
  for (const bearer of [ADMIN_TOKEN, `fk_tok_${'x'.repeat(43)}`, 'abc']) assert.equal((await rpc(gw, bearer, 'tools/list')).status, 401, bearer.slice(0, 8));
}));

test('a revoked, an ended and an out-of-account token are refused from the next request on, and the answer says why without the token', withGateway(async (gw) => {
  seedAccount(gw.storage.sqlite);
  seedAccount(gw.storage.sqlite, { id: 'acct-2', name: 'Sam', role: 'member' });
  const live = seedToken(gw.storage.sqlite);
  assert.equal((await rpc(gw, live.token, 'tools/list')).status, 200);
  gw.storage.sqlite.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ?').run(Date.now(), live.id);
  const revoked = await rpc(gw, live.token, 'tools/list');
  assert.equal(revoked.status, 401);
  assert.match(revoked.text, /revoked/);
  assert.ok(!revoked.text.includes(live.token));
  const ended = seedToken(gw.storage.sqlite, { expiresAt: Date.now() - 1000 });
  const endedReply = await rpc(gw, ended.token, 'tools/list');
  assert.equal(endedReply.status, 401);
  assert.match(endedReply.text, /expired/);
  const orphan = seedToken(gw.storage.sqlite, { accountId: 'acct-2' });
  assert.equal((await rpc(gw, orphan.token, 'tools/list')).status, 200);
  gw.storage.sqlite.prepare("UPDATE accounts SET state = 'removed' WHERE id = 'acct-2'").run();
  assert.equal((await rpc(gw, orphan.token, 'tools/list')).status, 401);
}));

test('a token limited to a project sees only it, and a token in the URL counts for nothing', withGateway(async (gw) => {
  seedAccount(gw.storage.sqlite);
  gw.storage.sqlite.prepare("INSERT INTO projects (id, public_key, config, config_version, updated_at) VALUES ('other', 'fk_pub_other', '{}', 1, 0)").run();
  gw.storage.sqlite.prepare("INSERT INTO feedback (id, project_id, outcome, payload, created_at, client_feedback_id, delivery) VALUES ('fb-2', 'other', 'created', '{\"message\":\"secret of the other project\"}', 2, 'c-2', 'local')").run();
  const { token } = seedToken(gw.storage.sqlite, { projects: ['demo'] });
  assert.deepEqual((await rpc(gw, token, 'tools/call', { name: 'list_projects', arguments: {} })).body.result.structuredContent.projects.map((p) => p.id), ['demo']);
  const other = await rpc(gw, token, 'tools/call', { name: 'get_feedback', arguments: { id: 'fb-2' } });
  assert.equal(other.body.result.isError, true);
  assert.ok(!other.text.includes('secret of the other project'));
  const search = await rpc(gw, token, 'tools/call', { name: 'search_feedback', arguments: { query: 'secret' } });
  assert.deepEqual(search.body.result.structuredContent.hits, []);
  const viaUrl = await gw.request(`/mcp?access_token=${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(viaUrl.status, 401);
}));

test('the MCP SDK client connects with a token as its bearer', withGateway(async (gw) => {
  seedAccount(gw.storage.sqlite);
  const { token } = seedToken(gw.storage.sqlite, { name: 'litellm-prod' });
  const sdkFetch = (input, init) => { const url = new URL(typeof input === 'string' ? input : input.url ?? input.href); return gw.request(url.pathname + url.search, init); };
  const client = new Client({ name: 'sdk-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), { authProvider: { token: async () => token }, fetch: sdkFetch }));
  assert.ok((await client.listTools()).tools.length >= 8);
  const who = await client.callTool({ name: 'whoami', arguments: {} });
  assert.equal(who.structuredContent.via, 'api-token');
  assert.equal(who.structuredContent.clientName, 'litellm-prod');
  await client.close();
}));

// ---- the unpacked release, a process and a socket ----------------------------------------------------------------

const root = new URL('..', import.meta.url).pathname;
let release, workDir;
before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'fk-acc-'));
  const built = await buildBundle({ root, outDir: join(workDir, 'out'), release: '4.1.0-dev.1', commit: 'abc', epoch: 1_800_000_000 });
  execFileSync('tar', ['-xzf', join(workDir, 'out', built.name), '-C', workDir]);
  release = join(workDir, 'feedbackkit-v4.1.0-dev.1');
});
after(() => rmSync(workDir, { recursive: true, force: true }));

async function freePort() {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise((r) => reservation.close(r));
  return port;
}

test('the unpacked release with MCP on: an account approves with its session, a token reads, a revoked one stops, and both survive a restart', async () => {
  const data = mkdtempSync(join(tmpdir(), 'fk-acc-data-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const PUBLIC = 'https://feedback.example.test';
  // The database as an operator's has it: an owner with a session and two tokens (the passkey ceremony itself is e2e/accounts-real-server.spec.ts).
  const storage = openStorage(join(data, 'feedbackkit.sqlite'), join(release, 'migrations'));
  const robin = seedAccount(storage.sqlite);
  const good = seedToken(storage.sqlite, { name: 'litellm' });
  const doomed = seedToken(storage.sqlite, { name: 'old' });
  storage.close();
  let child, output = '';
  const start = async () => {
    child = spawn(process.execPath, [join(release, 'server.mjs')], { cwd: release, env: { PATH: process.env.PATH, HOME: data, HOST: '127.0.0.1', PORT: String(port), FK_PUBLIC_URL: PUBLIC, FK_DATA_DIR: data, ADMIN_TOKEN: ADMIN_TOKEN, FK_UPDATE_CHECK: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    for (let i = 0; i < 200; i++) {
      if (child.exitCode !== null) throw new Error(output);
      try { if ((await fetch(`${base}/diag`)).ok) return; } catch { /* not listening yet */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`no start: ${output}`);
  };
  const stop = async () => { if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } };
  const mcp = (token, method = 'tools/list', params = {}) => fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  try {
    await start();
    assert.match(output, /MCP on \(issuer https:\/\/feedback\.example\.test/);

    // The consent, by hand, as a browser does it: register, open the page with the session cookie, click Allow, exchange the code.
    const reg = await (await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Process test', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }) })).json();
    const { verifier, challenge } = await pkce();
    const query = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, scope: 'feedback:read', state: 's', code_challenge: challenge, code_challenge_method: 'S256', resource: `${PUBLIC}/mcp` });
    const signedOut = await fetch(`${base}/oauth/authorize?${query}`);
    assert.equal(signedOut.status, 403);
    assert.match(await signedOut.text(), /Sign-in required/);
    const page = await fetch(`${base}/oauth/authorize?${query}`, { headers: { Cookie: robin.cookie } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes('Signed in as <b>Robin</b>'));
    const handle = /name="handle" value="([^"]+)"/.exec(html)[1];
    const consentCookie = page.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const allowed = await fetch(`${base}/oauth/authorize`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: PUBLIC, Cookie: `${robin.cookie}; ${consentCookie}` }, body: form({ handle, decision: 'allow' }) });
    assert.equal(allowed.status, 302);
    const code = new URL(allowed.headers.get('Location')).searchParams.get('code');
    const tokens = await (await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier, resource: `${PUBLIC}/mcp` }) })).json();
    assert.ok(tokens.access_token);
    assert.equal((await mcp(tokens.access_token)).status, 200);
    // An API token, through the same door.
    assert.equal((await mcp(good.token)).status, 200);
    assert.equal((await mcp(doomed.token)).status, 200);
    const sqlite = openStorage(join(data, 'feedbackkit.sqlite'), join(release, 'migrations'));
    sqlite.sqlite.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ?').run(Date.now(), doomed.id);
    sqlite.close();
    const revoked = await mcp(doomed.token);
    assert.equal(revoked.status, 401, 'a revocation counts from the next request, with no restart');
    assert.ok(!(await revoked.text()).includes(doomed.token));

    await stop();
    await start();
    assert.equal((await mcp(tokens.access_token)).status, 200, 'the OAuth connection survives a restart');
    assert.equal((await mcp(good.token)).status, 200, 'and so does the token');
    assert.equal((await mcp(doomed.token)).status, 401);
    assert.ok(!output.includes(good.token) && !output.includes(doomed.token) && !output.includes(tokens.access_token), 'no token in the process output');
    assert.ok(!output.includes(robin.cookie.split('=')[1]), 'no session in the process output');
  } finally { await stop(); rmSync(data, { recursive: true, force: true }); }
});
