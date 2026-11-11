import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
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
import { ORIGIN, PERSON, gateway } from './oauth-harness.mjs';

// The standalone server's MCP side, from the outside. Two halves.
//
// The MCP SDK's own client does the whole OAuth flow (discovery, registration, PKCE, consent, token, tools) against the
// bundled application with a stub sign-in, because a standalone server has no sign-in for approving a connection yet:
// accounts are not built, and the stub exists in test code only (test/oauth-harness.mjs).
//
// The unpacked release tarball, started with Node alone, is the other half: what an operator gets. MCP is off by default,
// says so at start and in /diag, serves only plumbing when FK_MCP=on, and approves nothing, because nobody can sign in.

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

/** An OAuth client for the MCP SDK that keeps its state in memory and hands the authorization URL to the test. */
function oauthClient(scope) {
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

/**
 * The SDK client's whole OAuth flow against the bundled app with the stub sign-in: 401, discovery, registration, consent, token.
 * Returns the OAuth state and a fetch that goes straight into the server and keeps every MCP request it carries.
 */
async function signIn(gw, scope) {
  const sent = [];
  const sdkFetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? input.href);
    if (url.pathname === '/mcp' && init?.body) sent.push({ headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(init.body) });
    return gw.request(url.pathname + url.search, init);
  };
  const oauth = oauthClient(scope);
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), { authProvider: oauth.provider, fetch: sdkFetch });
  await assert.rejects(new Client({ name: 'sdk-test', version: '1.0.0' }).connect(transport), UnauthorizedError);
  assert.ok(oauth.state.info?.client_id, 'registered through /oauth/register');
  const authorizationUrl = oauth.state.authorizationUrl;
  assert.equal(authorizationUrl.origin, ORIGIN);
  assert.equal(authorizationUrl.pathname, '/oauth/authorize');
  assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorizationUrl.searchParams.get('resource'), `${ORIGIN}/mcp`);

  // The person in the browser: opens the consent page, clicks Allow. Returns the callback parameters.
  const page = await gw.request(authorizationUrl.pathname + authorizationUrl.search);
  assert.equal(page.status, 200);
  const handle = /name="handle" value="([^"]+)"/.exec(await page.text())[1];
  const cookie = page.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const allowed = await gw.request('/oauth/authorize', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN, Cookie: cookie }, body: new URLSearchParams({ handle, decision: 'allow' }) });
  assert.equal(allowed.status, 302);
  const callback = new URL(allowed.headers.get('Location'));
  assert.ok(callback.searchParams.get('code'));
  assert.equal(callback.searchParams.get('iss'), ORIGIN);
  await transport.finishAuth(callback.searchParams);
  assert.ok(oauth.state.tokens.access_token && oauth.state.tokens.refresh_token);
  sent.length = 0;
  return { oauth, sdkFetch, sent };
}

// The SDK client speaks the 2025 handshake unless it is told otherwise (versionNegotiation), so the same flow runs three
// ways: the default, a client that asks the server with server/discover first, and one pinned to 2026-07-28.
for (const [label, negotiation, era] of [['the default (2025 initialize handshake)', undefined, 'legacy'], ["versionNegotiation 'auto' (server/discover first)", { mode: 'auto' }, 'modern'], ['versionNegotiation pinned to 2026-07-28', { mode: { pin: '2026-07-28' } }, 'modern']]) {
  test(`the MCP SDK client with ${label} discovers, registers, passes consent, reads feedback and is refused outside its scope (bundled app, stub sign-in)`, async () => {
    const gw = await gateway();
    try {
      const { oauth, sdkFetch, sent } = await signIn(gw, 'feedback:read');
      const client = new Client({ name: 'sdk-test', version: '1.0.0' }, negotiation ? { versionNegotiation: negotiation } : {});
      await client.connect(new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), { authProvider: oauth.provider, fetch: sdkFetch }));
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      assert.deepEqual(names, ['fetch', 'get_feedback', 'get_funnel', 'list_feedback', 'list_projects', 'search', 'search_feedback', 'whoami']);
      assert.equal((await client.callTool({ name: 'list_projects', arguments: {} })).structuredContent.projects[0].id, 'demo');
      assert.equal((await client.callTool({ name: 'list_feedback', arguments: { project: 'demo' } })).structuredContent.items.length, 1);
      const who = await client.callTool({ name: 'whoami', arguments: {} });
      assert.deepEqual({ email: who.structuredContent.email, scopes: who.structuredContent.scopes, gateway: who.structuredContent.gateway }, { email: PERSON, scopes: ['feedback:read'], gateway: ORIGIN });
      await assert.rejects(client.callTool({ name: 'get_config', arguments: { project: 'demo' } }), /not found/i, 'outside the granted scope');
      await client.close();

      const methods = sent.map((r) => r.body.method);
      if (era === 'legacy') {
        assert.equal(methods[0], 'initialize', 'the 2025 handshake');
        assert.ok(!sent.some((r) => r.headers['mcp-method']), 'no 2026 metadata headers');
      } else {
        assert.ok(!methods.includes('initialize'), 'no handshake');
        assert.ok(methods.includes('server/discover') || label.includes('pinned'), 'auto asks the server first');
        for (const r of sent) {
          // Every request carries what 2026-07-28 requires: the version and the method in headers, and the version and the capabilities in _meta.
          assert.equal(r.headers['mcp-protocol-version'], '2026-07-28', r.body.method);
          assert.equal(r.headers['mcp-method'], r.body.method);
          assert.equal(r.body.params._meta['io.modelcontextprotocol/protocolVersion'], '2026-07-28');
          assert.ok(r.body.params._meta['io.modelcontextprotocol/clientCapabilities']);
          if (r.body.method === 'tools/call') assert.equal(r.headers['mcp-name'], r.body.params.name);
        }
        assert.ok(methods.includes('tools/call') && methods.includes('tools/list'));
      }
    } finally { gw.close(); }
  });
}

test('MCP is off by default: the start log and /diag say why, and every OAuth and MCP path answers 404 with a hint', async () => {
  for (const env of [{}, { FK_PUBLIC_URL: 'https://feedback.example.test' }, { FK_MCP: 'off', FK_PUBLIC_URL: 'https://feedback.example.test' }]) {
    const server = await start(env);
    try {
      assert.equal(server.exited, false, server.output);
      assert.match(server.output(), /MCP off \(/);
      const diag = await (await fetch(`${server.base}/diag`)).json();
      assert.match(diag.mcp, /^off \(/);
      for (const [path, method] of [['/mcp', 'POST'], ['/oauth/authorize', 'GET'], ['/oauth/token', 'POST'], ['/oauth/register', 'POST'], ['/.well-known/oauth-authorization-server', 'GET'], ['/.well-known/oauth-protected-resource/mcp', 'GET']]) {
        const response = await fetch(server.base + path, { method });
        assert.equal(response.status, 404, path);
        const body = await response.json();
        assert.equal(body.error, 'not_found');
        assert.match(body.error_description, /accounts are not built/);
      }
      // Everything else is untouched.
      assert.equal((await fetch(`${server.base}/diag`)).status, 200);
      assert.equal((await fetch(`${server.base}/api/admin/projects`)).status, 401);
    } finally { await server.stop?.(); }
  }
});

test('FK_MCP=on serves the plumbing and approves nothing: issuer and resource from FK_PUBLIC_URL, a 401 challenge, registration, and a consent page that refuses everyone', async () => {
  const server = await start({ FK_MCP: 'on', FK_PUBLIC_URL: 'https://feedback.example.test' });
  try {
    assert.equal(server.exited, false, server.output);
    assert.match(server.output(), /MCP on, but no connection can be approved yet: accounts are not built \(issuer https:\/\/feedback\.example\.test, resource https:\/\/feedback\.example\.test\/mcp\)/);
    assert.match((await (await fetch(`${server.base}/diag`)).json()).mcp, /^on, but no connection can be approved yet/);
    // A hostile Host header moves nothing.
    const meta = await (await fetch(`${server.base}/.well-known/oauth-authorization-server`, { headers: { Host: 'evil.example' } })).json();
    assert.equal(meta.issuer, 'https://feedback.example.test');
    assert.equal(meta.token_endpoint, 'https://feedback.example.test/oauth/token');
    assert.equal(meta.client_id_metadata_document_supported, false);
    const resource = await (await fetch(`${server.base}/.well-known/oauth-protected-resource/mcp`, { headers: { Host: 'evil.example' } })).json();
    assert.equal(resource.resource, 'https://feedback.example.test/mcp');
    const challenge = (await fetch(`${server.base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Host: 'evil.example' }, body: '{}' })).headers.get('WWW-Authenticate');
    assert.ok(challenge.includes('https://feedback.example.test/.well-known/oauth-protected-resource/mcp'), challenge);
    // A client can register, but nobody can approve it, whatever the request claims to be.
    const registered = await fetch(`${server.base}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'probe', redirect_uris: ['https://client.example/cb'], token_endpoint_auth_method: 'none' }) });
    assert.equal(registered.status, 201);
    const { client_id } = await registered.json();
    const q = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: 'https://client.example/cb', scope: 'feedback:read', state: 's', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', resource: 'https://feedback.example.test/mcp' });
    for (const headers of [{}, { 'X-Test-Identity': PERSON }, { Authorization: `Bearer ${token}`, 'Cf-Access-Jwt-Assertion': 'a.b.c' }]) {
      const page = await fetch(`${server.base}/oauth/authorize?${q}`, { headers });
      assert.equal(page.status, 403);
      assert.equal(page.headers.getSetCookie().length, 0);
      assert.match(await page.text(), /Connecting apps is not available yet/);
    }
    const post = await fetch(`${server.base}/oauth/authorize`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: server.base.replace(/^http:\/\/127\.0\.0\.1:\d+/, 'https://feedback.example.test') }, body: new URLSearchParams({ handle: 'x', decision: 'allow', admin_token: token }) });
    assert.equal(post.status, 403);
  } finally { await server.stop?.(); }
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
  // Off unless asked for, whatever the address says: nobody can approve a connection yet.
  assert.equal(plan('https://fb.example.test', undefined).enabled, false);
  assert.equal(plan('https://fb.example.test', '').enabled, false);
  assert.equal(plan('http://localhost:8787', undefined).enabled, false);
  assert.match(plan('https://fb.example.test', undefined).note, /accounts, which are not built yet/);
  assert.equal(plan('https://fb.example.test', 'off').enabled, false);
  assert.equal(plan('https://fb.example.test', 'ON ').enabled, true);
  assert.match(plan('https://fb.example.test', 'on').note, /^on, but no connection can be approved yet/);
  assert.equal(plan('http://localhost:8787', 'on', '127.0.0.1').enabled, true);
  assert.equal(plan('http://127.0.0.1:8787', 'on', 'localhost').enabled, true);
  assert.equal(plan('http://[::1]:8787', 'on', '::1').enabled, true);
  assert.equal(plan('https://fb.example.test', 'on', '0.0.0.0').enabled, true, 'behind https the listen address is the proxy\'s business');
  assert.throws(() => plan('http://fb.example.test', 'on'), /needs an https/);
  assert.throws(() => plan('http://192.168.1.5:8787', 'on'), /needs an https/);
  assert.throws(() => plan('http://localhost:8787', 'on', '0.0.0.0'), /clear text/);
  assert.throws(() => plan('https://fb.example.test', 'maybe'), /on, off or unset/);
  assert.equal(isLoopbackHost('127.0.0.2'), true);
  assert.equal(isLoopbackHost('localhost.evil.test'), false);
  assert.equal(isLoopbackHost('128.0.0.1'), false);
});
