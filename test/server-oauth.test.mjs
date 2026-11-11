import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMcpFetch } from '../dist-server/app.mjs';
import {
  ALL_TOOLS, IDENTITY_HEADER, ORIGIN, PERSON, REDIRECT, REGISTRATIONS_PER_HOUR, TOKEN,
  authorizeClient, authorizePath, browser, connect, exchange, form, gateway, openConsent, pkce, postDecision, register, rpc, toolNames,
} from './oauth-harness.mjs';

// The standalone server's OAuth and MCP side (ADR-015, amendment of 2026-11-11), through the real
// workers-oauth-provider and the real MCP handler on Node. Before this change every one of these paths answered 404.
// The cases mirror test/mcp-oauth.test.ts and test/mcp-tools.test.ts (the Worker's).
//
// Who signs in is answered by the account system on a standalone server (test/server-mcp-accounts.test.mjs runs it with real
// accounts and sessions). Here the sign-in is a stub that exists in test code only (test/oauth-harness.mjs), so that the OAuth
// protocol is tested on its own.

const withGateway = (fn, options) => async (t) => { const gw = await gateway(options); try { await fn(gw, t); } finally { gw.close(); } };
const location = (response) => new URL(response.headers.get('Location'));
const refresh = (gw, refreshToken, clientId) => gw.request('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }) });
const grantRows = (gw) => gw.storage.sqlite.prepare("SELECT key FROM _fk_kv WHERE key LIKE 'grant:%'").all();
const transactionRows = (gw) => gw.storage.sqlite.prepare("SELECT key FROM _fk_kv WHERE key LIKE 'transaction:%'").all();

// ---- without a sign-in ---------------------------------------------------------------------------------------------

test('without a sign-in nothing is granted: no page, no handle, no cookie, no stored transaction, no grant, whatever the request carries', withGateway(async (gw) => {
  const clientId = await register(gw);
  const { challenge } = await pkce();
  for (const as of [null, 'ignored@example.org']) {
    const page = await gw.request(authorizePath(clientId, { challenge }), {}, { as });
    assert.equal(page.status, 403);
    assert.equal(page.headers.getSetCookie().length, 0);
    const html = await page.text();
    assert.match(html, /Sign-in required/);
    assert.ok(html.includes(`${ORIGIN}/admin`), 'the page says where to sign in');
    assert.match(html, /passkey/);
    assert.doesNotMatch(html, /name="handle"|name="admin_token"|type="password"/);
    assert.equal((await gw.request('/oauth/authorize', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN }, body: form({ handle: 'x', decision: 'allow' }) }, { as })).status, 403);
  }
  assert.equal(transactionRows(gw).length, 0);
  assert.equal(grantRows(gw).length, 0);
}, { authenticate: null }));

test('the stub identity is not in the production build', () => {
  const built = readFileSync(new URL('../dist-server/app.mjs', import.meta.url), 'utf8');
  assert.ok(!built.includes(IDENTITY_HEADER), 'the stub header is not in dist-server/app.mjs');
  assert.ok(!built.includes('stubIdentity'));
  assert.ok(!built.includes('X-Test'));
});

// ---- discovery, registration ----------------------------------------------------------------------------------

test('metadata names the public origin, publishes DCR only and the two read scopes', withGateway(async (gw) => {
  const server = await (await gw.request('/.well-known/oauth-authorization-server')).json();
  assert.equal(server.issuer, ORIGIN);
  assert.equal(server.authorization_endpoint, `${ORIGIN}/oauth/authorize`);
  assert.equal(server.token_endpoint, `${ORIGIN}/oauth/token`);
  assert.equal(server.registration_endpoint, `${ORIGIN}/oauth/register`);
  assert.deepEqual(server.scopes_supported, ['feedback:read', 'config:read']);
  assert.deepEqual(server.code_challenge_methods_supported, ['S256']);
  // A client id that is a URL would make the server fetch it; Node has no way to keep that off private addresses.
  assert.equal(server.client_id_metadata_document_supported, false);
  const resource = await (await gw.request('/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(resource.resource, `${ORIGIN}/mcp`);
  assert.deepEqual(resource.authorization_servers, [ORIGIN]);
}));

test('a request that names another origin never reaches the provider, so a Host header cannot move issuer or resource', withGateway(async (gw) => {
  for (const url of ['https://evil.example/.well-known/oauth-authorization-server', 'http://gw.test/.well-known/oauth-authorization-server', 'https://gw.test:8443/mcp']) {
    const response = await createMcpFetch(ORIGIN)(new Request(url), gw.env, { waitUntil() {} });
    assert.equal(response.status, 400, url);
  }
}));

test('/mcp without a token is 401 and points at the resource metadata; a made-up token is 401; GET is 405', withGateway(async (gw) => {
  const none = await gw.request('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(none.status, 401);
  assert.match(none.headers.get('WWW-Authenticate'), new RegExp(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`));
  assert.equal((await rpc(gw, 'abc:def:ghi', 'tools/list')).status, 401);
  const { access_token } = await connect(gw);
  assert.equal((await gw.request('/mcp', { headers: { Authorization: `Bearer ${access_token}` } })).status, 405);
}));

test('dynamic client registration works, refuses a bad redirect URI and is limited per client address', withGateway(async (gw) => {
  const clientId = await register(gw);
  assert.match(clientId, /\S/);
  const plain = await gw.request('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'x', redirect_uris: ['http://client.example/cb'], token_endpoint_auth_method: 'none' }) });
  assert.equal(plain.status, 400, 'an http redirect to a remote host is refused');
  assert.equal((await gw.request('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 400);
  // The limit counts per address: one address runs out, another does not.
  const again = (ip) => gw.request('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'n', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }) }, ip ? { ip } : undefined);
  for (let i = 0; i < REGISTRATIONS_PER_HOUR - 3; i++) assert.equal((await again()).status, 201);
  const over = await again();
  assert.equal(over.status, 429);
  assert.equal((await over.json()).error, 'temporarily_unavailable');
  assert.equal((await again('203.0.113.99')).status, 201);
}));

test('a client id that is a URL is not fetched: no Client ID Metadata Document, no outbound request', withGateway(async (gw, t) => {
  const outbound = t.mock.method(globalThis, 'fetch', async () => { throw new Error('the server must not fetch client-chosen URLs'); });
  const { challenge } = await pkce();
  const response = await gw.request(authorizePath('https://client.example/client.json', { challenge }));
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('Location'), null);
  assert.equal(outbound.mock.callCount(), 0);
}));

// ---- the consent page ------------------------------------------------------------------------------------------

test('the consent page names the signed-in person, sets the single-use handle and cookie, and asks for no token', withGateway(async (gw) => {
  const clientId = await register(gw);
  const { challenge } = await pkce();
  const { response, html, handle, jar } = await openConsent(gw, authorizePath(clientId, { challenge }));
  assert.equal(response.status, 200);
  assert.match(html, /Connect Test &lt;Agent&gt;/, 'the name the client chose is escaped');
  assert.ok(!html.includes('<Agent>'));
  assert.ok(html.includes(`Signed in as <b>${PERSON}</b>`));
  assert.match(html, /<form method="post" action="\/oauth\/authorize">/);
  assert.doesNotMatch(html, /type="password"|admin_token/, 'the page asks for no secret');
  assert.match(html, /Read projects, feedback and funnel numbers/);
  assert.match(html, /Read project configuration/);
  assert.match(html, /client\.example/);
  assert.doesNotMatch(html, /<script/i);
  assert.ok(handle.length > 20);
  assert.match(jar.cookie(), /^__Host-oauth-consent/);
  assert.match(response.headers.getSetCookie()[0], /Secure/i);
  const csp = response.headers.get('Content-Security-Policy');
  assert.match(csp, /style-src 'nonce-[0-9a-f]+'/);
  assert.match(csp, /form-action 'self' https:\/\/client\.example/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(response.headers.get('Referrer-Policy'), 'same-origin');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(grantRows(gw).length, 0, 'viewing the page grants nothing');
}));

test('a wrong redirect URI, an unknown client, a missing PKCE challenge and a wrong resource never show the form', withGateway(async (gw) => {
  const clientId = await register(gw);
  const { challenge } = await pkce();
  const evil = await gw.request(authorizePath(clientId, { challenge, redirect: 'https://evil.example/cb' }));
  assert.equal(evil.status, 400);
  assert.equal(evil.headers.get('Location'), null, 'never redirect to a URI the client did not register');
  assert.doesNotMatch(await evil.text(), /name="handle"/);
  const unknown = await gw.request(authorizePath('unknown-client', { challenge }));
  assert.equal(unknown.status, 400);
  assert.equal(unknown.headers.get('Location'), null);
  const noPkce = await gw.request(authorizePath(clientId, {}));
  assert.equal(noPkce.status, 302);
  assert.equal(location(noPkce).searchParams.get('error'), 'invalid_request');
  assert.equal(location(noPkce).searchParams.get('state'), 'st-123');
  const plainMethod = await gw.request(authorizePath(clientId, { challenge, method: 'plain' }));
  assert.equal(plainMethod.status, 302);
  assert.equal(location(plainMethod).searchParams.get('error'), 'invalid_request');
  const wrongResource = await gw.request(authorizePath(clientId, { challenge, resource: 'https://other.test/mcp' }));
  assert.equal(wrongResource.status, 302);
  assert.equal(location(wrongResource).searchParams.get('error'), 'invalid_target');
  assert.equal(grantRows(gw).length, 0);
}));

test('Allow grants the requested scopes to the signed-in person: the code goes back to the client with its state', withGateway(async (gw) => {
  const clientId = await register(gw);
  const { challenge } = await pkce();
  const { handle, jar } = await openConsent(gw, authorizePath(clientId, { scope: 'feedback:read', challenge }));
  const done = await postDecision(gw, { handle, jar });
  assert.equal(done.status, 302);
  const to = location(done);
  assert.equal(`${to.origin}${to.pathname}`, REDIRECT);
  assert.equal(to.searchParams.get('state'), 'st-123');
  assert.ok(to.searchParams.get('code'));
  assert.deepEqual(grantRows(gw).map((r) => r.key.split(':')[1]), [encodeURIComponent(PERSON)], 'the grant belongs to the person who approved it');
}));

test('Allow without a sign-in is refused and does not spend the page: the signed-in person can still use it', withGateway(async (gw) => {
  const clientId = await register(gw);
  const { challenge } = await pkce();
  const { handle, jar } = await openConsent(gw, authorizePath(clientId, { challenge }));
  const refused = await postDecision(gw, { handle, jar, options: { as: null } });
  assert.equal(refused.status, 403);
  assert.equal(refused.headers.get('Location'), null);
  assert.equal(grantRows(gw).length, 0);
  assert.equal((await postDecision(gw, { handle, jar })).status, 302);
  assert.equal(grantRows(gw).length, 1);
}));

test('Cancel denies: the client gets access_denied and no grant exists', withGateway(async (gw) => {
  const clientId = await register(gw);
  const { challenge } = await pkce();
  const { handle, jar } = await openConsent(gw, authorizePath(clientId, { challenge }));
  const response = await postDecision(gw, { handle, jar, decision: 'cancel' });
  assert.equal(response.status, 302);
  assert.equal(location(response).searchParams.get('error'), 'access_denied');
  assert.equal(location(response).searchParams.get('state'), 'st-123');
  assert.equal(grantRows(gw).length, 0);
  assert.equal((await postDecision(gw, { handle, jar })).status, 400, 'the declined page is spent');
}));

test('the handle works once: a replay is refused', withGateway(async (gw) => {
  const clientId = await register(gw);
  const { challenge } = await pkce();
  const { handle, jar } = await openConsent(gw, authorizePath(clientId, { challenge }));
  assert.equal((await postDecision(gw, { handle, jar })).status, 302);
  const replay = await postDecision(gw, { handle, jar });
  assert.equal(replay.status, 400);
  assert.match(await replay.text(), /This page has expired/);
  assert.equal(grantRows(gw).length, 1);
}));

test('a handle from another browser, a handle without its cookie and a made-up handle grant nothing', withGateway(async (gw) => {
  const clientId = await register(gw);
  const { challenge } = await pkce();
  const mine = await openConsent(gw, authorizePath(clientId, { challenge }));
  const theirs = await openConsent(gw, authorizePath(clientId, { challenge }));
  assert.equal((await postDecision(gw, { handle: mine.handle, jar: theirs.jar })).status, 400);
  assert.equal((await postDecision(gw, { handle: theirs.handle, jar: mine.jar })).status, 400);
  assert.equal((await postDecision(gw, { handle: mine.handle, jar: browser() })).status, 400, 'no cookie at all');
  assert.equal((await postDecision(gw, { handle: 'A'.repeat(43), jar: mine.jar })).status, 400);
  assert.equal((await postDecision(gw, { handle: '', jar: mine.jar })).status, 400);
  assert.equal(grantRows(gw).length, 0);
  assert.equal((await postDecision(gw, { handle: mine.handle, jar: mine.jar })).status, 302, 'the pair that belongs together still works');
}));

test('a form posted from another origin, or from an opaque one, is blocked before anything else is looked at', withGateway(async (gw) => {
  const clientId = await register(gw);
  const { challenge } = await pkce();
  const { handle, jar } = await openConsent(gw, authorizePath(clientId, { challenge }));
  const cross = await postDecision(gw, { handle, jar, origin: 'https://evil.example', headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(cross.status, 403);
  assert.match(await cross.text(), /Request blocked/);
  assert.equal((await postDecision(gw, { handle, jar, origin: 'null', headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal(grantRows(gw).length, 0);
  assert.equal((await postDecision(gw, { handle, jar })).status, 302);
}));

// ---- token endpoint: PKCE, exchange, refresh, revoke -----------------------------------------------------------

test('token exchange: the right verifier gives access and refresh tokens, a wrong one, a replayed code and a foreign redirect do not', withGateway(async (gw) => {
  const a = await authorizeClient(gw);
  const wrong = await exchange(gw, { ...a, verifier: (await pkce()).verifier });
  assert.equal(wrong.status, 400);
  assert.equal((await wrong.json()).error, 'invalid_grant');
  const b = await authorizeClient(gw);
  assert.equal((await exchange(gw, { ...b, redirect: 'https://client.example/other' })).status, 400);
  const c = await authorizeClient(gw);
  const ok = await exchange(gw, c);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.token_type, 'bearer');
  assert.equal(body.scope, 'feedback:read config:read');
  assert.equal(body.expires_in, 3600);
  assert.equal(body.resource, `${ORIGIN}/mcp`);
  assert.ok(body.access_token && body.refresh_token);
  assert.equal((await exchange(gw, c)).status, 400, 'a code is spent once');
}));

test('the token request must name the resource of this gateway; any other resource is invalid_target', withGateway(async (gw) => {
  const a = await authorizeClient(gw);
  const mismatch = await exchange(gw, { ...a, resource: 'https://other.test/mcp' });
  assert.equal(mismatch.status, 400);
  assert.equal((await mismatch.json()).error, 'invalid_target');
}));

test('refresh gives a new access token that works, rotates the refresh token, and a token two rotations old is dead', withGateway(async (gw) => {
  const grant = await connect(gw);
  const first = await refresh(gw, grant.refresh_token, grant.clientId);
  assert.equal(first.status, 200);
  const one = await first.json();
  assert.notEqual(one.refresh_token, grant.refresh_token);
  assert.notEqual(one.access_token, grant.access_token);
  assert.equal((await rpc(gw, one.access_token, 'tools/list')).status, 200);
  const second = await refresh(gw, one.refresh_token, grant.clientId);
  assert.equal(second.status, 200);
  assert.equal((await refresh(gw, grant.refresh_token, grant.clientId)).status, 400);
  assert.equal((await refresh(gw, 'not:a:token', grant.clientId)).status, 400);
}));

test('revoking an access token ends it at once; revoking a refresh token ends the refresh', withGateway(async (gw) => {
  const grant = await connect(gw);
  const revoke = (token) => gw.request('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ token, client_id: grant.clientId }) });
  assert.equal((await rpc(gw, grant.access_token, 'tools/list')).status, 200);
  assert.equal((await revoke(grant.access_token)).status, 200);
  assert.equal((await rpc(gw, grant.access_token, 'tools/list')).status, 401);
  assert.equal((await revoke(grant.refresh_token)).status, 200);
  assert.equal((await refresh(gw, grant.refresh_token, grant.clientId)).status, 400);
}));

test('an expired access token is 401 and its refresh token still works; an expired refresh token and its grant are gone, and the sweep removes the rows', withGateway(async (gw, t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const grant = await connect(gw);
  assert.equal((await rpc(gw, grant.access_token, 'tools/list')).status, 200);
  t.mock.timers.tick(3600 * 1000 - 1000);
  assert.equal((await rpc(gw, grant.access_token, 'tools/list')).status, 200, 'still valid a second before it expires');
  t.mock.timers.tick(2000);
  const expired = await rpc(gw, grant.access_token, 'tools/list');
  assert.equal(expired.status, 401);
  assert.match(expired.response.headers.get('WWW-Authenticate'), /invalid_token/);
  const renewed = await refresh(gw, grant.refresh_token, grant.clientId);
  assert.equal(renewed.status, 200, 'a refresh token outlives the access token');
  const again = await renewed.json();
  assert.equal((await rpc(gw, again.access_token, 'tools/list')).status, 200);
  t.mock.timers.tick(30 * 24 * 3600 * 1000 + 1000);
  assert.equal((await refresh(gw, again.refresh_token, grant.clientId)).status, 400, 'the grant ran out after 30 days');
  assert.equal((await rpc(gw, again.access_token, 'tools/list')).status, 401);
  assert.ok(gw.storage.sqlite.prepare('SELECT count(*) AS n FROM _fk_kv').get().n > 0, 'expired rows are still stored until the sweep');
  gw.kv.sweepExpired();
  assert.equal(gw.storage.sqlite.prepare("SELECT count(*) AS n FROM _fk_kv WHERE key LIKE 'grant:%' OR key LIKE 'token:%'").get().n, 0);
}));

test('a grant survives a restart: the same database, a new gateway', async () => {
  const first = await gateway();
  let second;
  try {
    const grant = await connect(first);
    first.close({ keep: true });
    second = await gateway({ existing: first.dir });
    assert.equal((await rpc(second, grant.access_token, 'tools/list')).status, 200);
    const renewed = await refresh(second, grant.refresh_token, grant.clientId);
    assert.equal(renewed.status, 200);
  } finally { second?.close(); }
});

// ---- /mcp ------------------------------------------------------------------------------------------------------

test('tools/list follows the granted scopes: feedback:read, config:read, both', withGateway(async (gw) => {
  const feedbackOnly = await connect(gw, { scope: 'feedback:read' });
  assert.deepEqual(await toolNames(gw, feedbackOnly.access_token), ALL_TOOLS.filter((n) => n !== 'get_config'));
  const configOnly = await connect(gw, { scope: 'config:read' });
  assert.deepEqual(await toolNames(gw, configOnly.access_token), ['get_config', 'whoami']);
  const both = await connect(gw, { scope: 'feedback:read config:read' });
  assert.deepEqual(await toolNames(gw, both.access_token), ALL_TOOLS);
  const none = await connect(gw, { scope: 'openid admin:write' });
  assert.deepEqual(await toolNames(gw, none.access_token), ALL_TOOLS.filter((n) => n !== 'get_config'), 'a request for none of our scopes gets the smallest grant');
}));

test('a read tool returns the stored data, and a tool outside the granted scope is refused', withGateway(async (gw) => {
  const feedbackOnly = await connect(gw, { scope: 'feedback:read' });
  const projects = await rpc(gw, feedbackOnly.access_token, 'tools/call', { name: 'list_projects', arguments: {} });
  assert.equal(projects.status, 200);
  assert.equal(projects.body.result.structuredContent.projects[0].id, 'demo');
  const listed = await rpc(gw, feedbackOnly.access_token, 'tools/call', { name: 'list_feedback', arguments: { project: 'demo' } });
  assert.equal(listed.body.result.structuredContent.items[0].message, 'The save button does nothing');
  const found = await rpc(gw, feedbackOnly.access_token, 'tools/call', { name: 'search_feedback', arguments: { query: 'save button' } });
  assert.equal(found.body.result.structuredContent.hits.length, 1);
  const outside = await rpc(gw, feedbackOnly.access_token, 'tools/call', { name: 'get_config', arguments: { project: 'demo' } });
  assert.equal(outside.body.error.code, -32602);
  assert.match(outside.body.error.message, /not found/);
  assert.ok(!outside.text.includes('templates'), 'nothing of the config came back');
  const configOnly = await connect(gw, { scope: 'config:read' });
  const config = await rpc(gw, configOnly.access_token, 'tools/call', { name: 'get_config', arguments: { project: 'demo' } });
  assert.equal(config.body.result.structuredContent.projectId, 'demo');
  assert.match(config.text, /patSecret/, 'secret names, never values');
  const noFeedback = await rpc(gw, configOnly.access_token, 'tools/call', { name: 'list_projects', arguments: {} });
  assert.equal(noFeedback.body.error.code, -32602);
}));

test('whoami tells who approved it, the client name and the scopes', withGateway(async (gw) => {
  const grant = await connect(gw, { scope: 'feedback:read' });
  const who = (await rpc(gw, grant.access_token, 'tools/call', { name: 'whoami', arguments: {} })).body.result.structuredContent;
  assert.equal(who.email, PERSON);
  assert.equal(who.clientName, 'Test <Agent>');
  assert.deepEqual(who.scopes, ['feedback:read']);
  assert.equal(who.gateway, ORIGIN);
  assert.deepEqual(who.grant, { accessTokenTtlSeconds: 3600, refreshTokenTtlSeconds: 2592000 });
}));

test('concurrent calls of different grants never see each other\'s scopes (the request context is not shared)', withGateway(async (gw) => {
  const feedbackOnly = await connect(gw, { scope: 'feedback:read' });
  const configOnly = await connect(gw, { scope: 'config:read' });
  const jobs = [];
  for (let i = 0; i < 40; i++) {
    jobs.push(toolNames(gw, feedbackOnly.access_token).then((names) => ['feedback', names]));
    jobs.push(toolNames(gw, configOnly.access_token).then((names) => ['config', names]));
  }
  for (const [kind, names] of await Promise.all(jobs)) {
    assert.deepEqual(names, kind === 'feedback' ? ALL_TOOLS.filter((n) => n !== 'get_config') : ['get_config', 'whoami']);
  }
}));

test('the request context the server passes in is never written to: a grant\'s props cannot reach another request through it', withGateway(async (gw) => {
  const grant = await connect(gw, { scope: 'feedback:read' });
  const shared = { waitUntil() {}, passThroughOnException() {} };
  const call = (path, init) => createMcpFetch(ORIGIN)(new Request(`${ORIGIN}${path}`, init), gw.env, shared);
  const response = await call('/mcp', { method: 'POST', headers: { Authorization: `Bearer ${grant.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
  assert.equal(response.status, 200);
  await response.text();
  assert.deepEqual(Reflect.ownKeys(shared).sort(), ['passThroughOnException', 'waitUntil']);
}));

test('MCP calls are limited per grant and hour, like on the Worker', withGateway(async (gw) => {
  const grant = await connect(gw, { scope: 'feedback:read' });
  const limit = Number(/export const MCP_CALLS_PER_HOUR = (\d+);/.exec(readFileSync(new URL('../src/worker/mcp/server.ts', import.meta.url), 'utf8'))[1]);
  // Fill the counter directly instead of making a thousand calls; the key is the hashed grant, so call once to learn it.
  assert.equal((await rpc(gw, grant.access_token, 'tools/list')).status, 200);
  gw.storage.sqlite.prepare("UPDATE counters SET count = ? WHERE key LIKE 'mcp:%'").run(limit);
  const over = await rpc(gw, grant.access_token, 'tools/list');
  assert.equal(over.status, 429);
  assert.ok(Number(over.response.headers.get('Retry-After')) >= 1);
}));
