import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { Client, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client';
import { buildBundle } from '../scripts/build-bundle.mjs';
import { planMcp, isLoopbackHost } from '../scripts/server-mcp.mjs';
import { openStorage } from '../scripts/server-storage.mjs';
import { createKv } from '../scripts/server-kv.mjs';

// The standalone server end to end, the way an agent meets it: the unpacked release tarball (server.mjs, Node alone,
// no node_modules), a real socket, and the MCP SDK's own client doing discovery, registration, PKCE, the token
// exchange and the tool calls. The one step no program can do is the person in the browser, so the test plays the
// browser: it opens the consent page, types the admin token and clicks Allow with the same HTTP a browser sends.

const root = new URL('..', import.meta.url).pathname;
const token = 'fictional-test-token-'.repeat(3);
const temporary = () => mkdtempSync(join(tmpdir(), 'fk-mcp-'));
let release, workDir;

before(async () => {
  workDir = temporary();
  const out = join(workDir, 'out');
  const built = await buildBundle({ root, outDir: out, release: '4.0.0-dev.1', commit: 'abc', epoch: 1_800_000_000 });
  execFileSync('tar', ['-xzf', join(out, built.name), '-C', workDir]);
  release = join(workDir, 'feedbackkit-v4.0.0-dev.1');
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

/** Starts the unpacked server. Resolves with the running server, or with the exit and its output when it stops on its own. */
async function start(env, { data = temporary() } = {}) {
  const port = env.PORT ? Number(env.PORT) : await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [join(release, 'server.mjs')], {
    cwd: release,
    env: { PATH: process.env.PATH, HOME: data, HOST: '127.0.0.1', PORT: String(port), FK_PUBLIC_URL: base, FK_DATA_DIR: data, ADMIN_TOKEN: token, FK_UPDATE_CHECK: 'off', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) return { exited: true, code: child.exitCode, output, data };
    try { if ((await fetch(`${base}/diag`)).ok) break; } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  if (child.exitCode !== null) return { exited: true, code: child.exitCode, output, data };
  return { exited: false, base, port, data, output: () => output, async stop() { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } } };
}

const admin = (server, path, method = 'GET', body) => fetch(server.base + path, { method, headers: { Authorization: `Bearer ${token}`, Origin: server.base, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

async function seedProject(server) {
  const config = { projectId: 'example', locale: 'en', delivery: 'local', auth: { origins: [server.base] }, llm: { provider: 'off', model: '' }, templates: [{ type: 'feedback', label: 'Feedback', fields: [] }] };
  assert.equal((await admin(server, '/api/admin/projects', 'POST', { config })).status, 201);
  assert.equal((await admin(server, '/api/admin/projects/example/test-report', 'POST', {})).status, 200);
}

/** An OAuth client for the MCP SDK that keeps its state in memory and hands the authorization URL to the test. */
function oauthClient(base, scope) {
  const state = { tokens: undefined, info: undefined, verifier: undefined, authorizationUrl: undefined, discovery: undefined };
  return {
    state,
    provider: {
      get redirectUrl() { return 'http://127.0.0.1:9/callback'; },
      get clientMetadata() { return { client_name: 'SDK test client', redirect_uris: ['http://127.0.0.1:9/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope }; },
      clientInformation: () => state.info,
      saveClientInformation: (info) => { state.info = info; },
      tokens: () => state.tokens,
      saveTokens: (tokens) => { state.tokens = tokens; },
      redirectToAuthorization: (url) => { state.authorizationUrl = url; },
      saveCodeVerifier: (v) => { state.verifier = v; },
      codeVerifier: () => state.verifier,
      // The SDK binds the callback to the authorization server it discovered (SEP-2352); keeping the state lets it check the issuer.
      saveDiscoveryState: (value) => { state.discovery = value; },
      discoveryState: () => state.discovery,
    },
  };
}

/** The person in the browser: opens the consent URL, types the admin token, clicks Allow (or Cancel). Returns the callback parameters. */
async function browse(authorizationUrl, { adminToken = token, decision = 'allow' } = {}) {
  const page = await fetch(authorizationUrl);
  assert.equal(page.status, 200, 'the consent page');
  const html = await page.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)[1];
  const cookie = page.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const origin = new URL(authorizationUrl).origin;
  const fields = { handle, decision };
  if (adminToken !== null) fields.admin_token = adminToken;
  const done = await fetch(`${origin}/oauth/authorize`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, Cookie: cookie }, body: new URLSearchParams(fields) });
  return { status: done.status, location: done.headers.get('Location') ? new URL(done.headers.get('Location')) : null, body: await done.text() };
}

async function connect(base, oauth) {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: oauth.provider });
  const client = new Client({ name: 'sdk-test', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

test('the MCP SDK client discovers, registers, passes consent, reads feedback and is refused outside its scope', async () => {
  const server = await start({ FK_MCP: 'on' });
  try {
    assert.equal(server.exited, false, server.output);
    assert.match(server.output(), /MCP on \(issuer http:\/\/127\.0\.0\.1:\d+, resource http:\/\/127\.0\.0\.1:\d+\/mcp\)/);
    await seedProject(server);

    const oauth = oauthClient(server.base, 'feedback:read');
    // Without a token the SDK finds the authorization server through the 401 and the resource metadata, registers itself, and asks for the consent URL.
    const transport = new StreamableHTTPClientTransport(new URL(`${server.base}/mcp`), { authProvider: oauth.provider });
    await assert.rejects(new Client({ name: 'sdk-test', version: '1.0.0' }).connect(transport), UnauthorizedError);
    assert.ok(oauth.state.info?.client_id, 'registered through /oauth/register');
    const authorizationUrl = oauth.state.authorizationUrl;
    assert.equal(authorizationUrl.origin, server.base);
    assert.equal(authorizationUrl.pathname, '/oauth/authorize');
    assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authorizationUrl.searchParams.get('resource'), `${server.base}/mcp`);
    assert.ok(!authorizationUrl.toString().includes(token), 'the token is not in the URL');

    // A wrong admin token: no code, and the SDK has nothing to finish.
    const wrong = await browse(authorizationUrl, { adminToken: 'not-the-admin-token' });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.location, null);
    // The right one: the redirect carries the code, state and issuer.
    const allowed = await browse(authorizationUrl);
    assert.equal(allowed.status, 302);
    assert.ok(allowed.location.searchParams.get('code'));
    assert.equal(allowed.location.searchParams.get('iss'), server.base);
    await transport.finishAuth(allowed.location.searchParams);
    assert.ok(oauth.state.tokens.access_token && oauth.state.tokens.refresh_token);

    const { client } = await connect(server.base, oauth);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['fetch', 'get_feedback', 'get_funnel', 'list_feedback', 'list_projects', 'search', 'search_feedback', 'whoami']);
    const projects = await client.callTool({ name: 'list_projects', arguments: {} });
    assert.equal(projects.structuredContent.projects[0].id, 'example');
    const items = await client.callTool({ name: 'list_feedback', arguments: { project: 'example' } });
    assert.equal(items.structuredContent.items.length, 1);
    const who = await client.callTool({ name: 'whoami', arguments: {} });
    assert.deepEqual({ email: who.structuredContent.email, scopes: who.structuredContent.scopes, gateway: who.structuredContent.gateway }, { email: 'admin', scopes: ['feedback:read'], gateway: server.base });
    await assert.rejects(client.callTool({ name: 'get_config', arguments: { project: 'example' } }), /not found/i, 'outside the granted scope');
    await client.close();
  } finally { await server.stop?.(); }
});

test('the grant survives a restart on the same address', async () => {
  const port = await freePort();
  const data = temporary();
  const env = { FK_MCP: 'on', FK_PUBLIC_URL: `http://127.0.0.1:${port}`, PORT: String(port) };
  let server = await start(env, { data });
  try {
    await seedProject(server);
    const oauth = oauthClient(server.base, 'feedback:read config:read');
    const transport = new StreamableHTTPClientTransport(new URL(`${server.base}/mcp`), { authProvider: oauth.provider });
    await assert.rejects(new Client({ name: 'sdk-test', version: '1.0.0' }).connect(transport), UnauthorizedError);
    await transport.finishAuth((await browse(oauth.state.authorizationUrl)).location.searchParams);
    await server.stop();
    server = await start(env, { data });
    assert.equal(server.exited, false, server.output);
    const { client } = await connect(server.base, oauth);
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), ['fetch', 'get_config', 'get_feedback', 'get_funnel', 'list_feedback', 'list_projects', 'search', 'search_feedback', 'whoami']);
    const config = await client.callTool({ name: 'get_config', arguments: { project: 'example' } });
    assert.equal(config.structuredContent.projectId, 'example');
    await client.close();
  } finally { await server.stop?.(); rmSync(data, { recursive: true, force: true }); }
});

test('with an https FK_PUBLIC_URL MCP is on by itself, and issuer and resource come from it, never from the Host header', async () => {
  const server = await start({ FK_PUBLIC_URL: 'https://feedback.example.test' });
  try {
    assert.equal(server.exited, false, server.output);
    assert.match(server.output(), /MCP on \(issuer https:\/\/feedback\.example\.test, resource https:\/\/feedback\.example\.test\/mcp\)/);
    const meta = await (await fetch(`${server.base}/.well-known/oauth-authorization-server`, { headers: { Host: 'evil.example' } })).json();
    assert.equal(meta.issuer, 'https://feedback.example.test');
    assert.equal(meta.token_endpoint, 'https://feedback.example.test/oauth/token');
    const resource = await (await fetch(`${server.base}/.well-known/oauth-protected-resource/mcp`, { headers: { Host: 'evil.example' } })).json();
    assert.equal(resource.resource, 'https://feedback.example.test/mcp');
    // The 401 challenge points at the public address too.
    const challenge = (await fetch(`${server.base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Host: 'evil.example' }, body: '{}' })).headers.get('WWW-Authenticate');
    assert.ok(challenge.includes('https://feedback.example.test/.well-known/oauth-protected-resource/mcp'), challenge);
  } finally { await server.stop?.(); }
});

test('FK_MCP=off, or an http address without FK_MCP, leaves every OAuth and MCP path at 404 with the way to turn it on', async () => {
  for (const env of [{ FK_PUBLIC_URL: 'https://feedback.example.test', FK_MCP: 'off' }, {}]) {
    const server = await start(env);
    try {
      assert.equal(server.exited, false, server.output);
      assert.match(server.output(), /MCP off \(/);
      for (const [path, method] of [['/mcp', 'POST'], ['/oauth/authorize', 'GET'], ['/oauth/token', 'POST'], ['/oauth/register', 'POST'], ['/.well-known/oauth-authorization-server', 'GET'], ['/.well-known/oauth-protected-resource/mcp', 'GET']]) {
        const response = await fetch(server.base + path, { method });
        assert.equal(response.status, 404, path);
        const body = await response.json();
        assert.equal(body.error, 'not_found');
        assert.match(body.error_description, /FK_PUBLIC_URL/);
      }
      // Everything else is untouched.
      assert.equal((await fetch(`${server.base}/diag`)).status, 200);
      assert.equal((await fetch(`${server.base}/api/admin/projects`)).status, 401);
    } finally { await server.stop?.(); }
  }
});

test('unsafe combinations stop the start with the reason', async () => {
  const refused = async (env, pattern) => {
    const server = await start(env);
    if (!server.exited) await server.stop();
    assert.equal(server.exited, true, `started although it should not: ${JSON.stringify(env)}`);
    assert.notEqual(server.code, 0);
    assert.match(server.output, pattern);
  };
  await refused({ FK_MCP: 'on', FK_PUBLIC_URL: 'http://feedback.example.test' }, /FK_MCP=on needs an https FK_PUBLIC_URL/);
  await refused({ FK_MCP: 'on', HOST: '0.0.0.0' }, /HOST=0\.0\.0\.0 listens on other addresses/);
  await refused({ FK_MCP: 'sometimes' }, /FK_MCP must be on, off or unset/);
});

test('the start sweep removes expired OAuth rows and keeps live ones, with MCP on or off', async () => {
  for (const mcp of ['on', 'off']) {
    const data = temporary();
    try {
      // A database as an earlier run left it: one grant that has run out, one that has not.
      const storage = openStorage(join(data, 'feedbackkit.sqlite'), join(release, 'migrations'));
      const kv = createKv(storage.sqlite);
      await kv.put('token:admin:g1:t1', '{}', { expirationTtl: 3600 });
      await kv.put('grant:admin:g1', '{}', { expirationTtl: 3600 });
      storage.sqlite.prepare("UPDATE _fk_kv SET expires_at = 1 WHERE key = 'token:admin:g1:t1'").run();
      storage.close();
      const server = await start({ FK_MCP: mcp }, { data });
      assert.equal(server.exited, false, server.output);
      await server.stop();
      const after = openStorage(join(data, 'feedbackkit.sqlite'), join(release, 'migrations'));
      assert.deepEqual(after.sqlite.prepare('SELECT key FROM _fk_kv ORDER BY key').all().map((r) => r.key), ['grant:admin:g1'], `FK_MCP=${mcp}`);
      after.close();
    } finally { rmSync(data, { recursive: true, force: true }); }
  }
});

test('planMcp: the whole table', () => {
  const plan = (url, setting, host) => planMcp({ origin: new URL(url), setting, host });
  assert.deepEqual(plan('https://fb.example.test', undefined).enabled, true);
  assert.deepEqual(plan('https://fb.example.test', '').enabled, true);
  assert.deepEqual(plan('https://fb.example.test', 'ON ').enabled, true);
  assert.deepEqual(plan('https://fb.example.test', 'off').enabled, false);
  assert.deepEqual(plan('http://localhost:8787', undefined).enabled, false);
  assert.deepEqual(plan('http://localhost:8787', 'on', '127.0.0.1').enabled, true);
  assert.deepEqual(plan('http://127.0.0.1:8787', 'on', 'localhost').enabled, true);
  assert.deepEqual(plan('http://[::1]:8787', 'on', '::1').enabled, true);
  assert.deepEqual(plan('https://fb.example.test', 'on', '0.0.0.0').enabled, true, 'behind https the listen address is the proxy\'s business');
  assert.throws(() => plan('http://fb.example.test', 'on'), /needs an https/);
  assert.throws(() => plan('http://192.168.1.5:8787', 'on'), /needs an https/);
  assert.throws(() => plan('http://localhost:8787', 'on', '0.0.0.0'), /clear text/);
  assert.throws(() => plan('https://fb.example.test', 'maybe'), /on, off or unset/);
  assert.equal(isLoopbackHost('127.0.0.2'), true);
  assert.equal(isLoopbackHost('localhost.evil.test'), false);
  assert.equal(isLoopbackHost('128.0.0.1'), false);
});
