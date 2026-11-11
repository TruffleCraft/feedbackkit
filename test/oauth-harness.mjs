// Shared by test/server-oauth.test.mjs and test/server-mcp-e2e.test.mjs: the standalone server's OAuth and MCP side
// without a socket. It builds what scripts/server.mjs builds (SQLite storage, the KV adapter, the bundled app) and
// calls createMcpFetch with real Request objects, so the real workers-oauth-provider and the real MCP handler run.
//
// Who is signing in is the one thing the standalone server cannot answer yet (no accounts). The stub below answers it
// for the tests: a request that carries the header X-Test-Identity is that person. It lives in test code only. The
// production build has no way to receive it (createMcpFetch takes it as an argument, and scripts/server.mjs passes
// none), and a test checks that the built server does not contain it.
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { app, createMcpFetch } from '../dist-server/app.mjs';
import { openStorage } from '../scripts/server-storage.mjs';
import { createKv } from '../scripts/server-kv.mjs';

export const ORIGIN = 'https://gw.test';
export const REDIRECT = 'https://client.example/callback';
export const TOKEN = 'fictional-test-token-'.repeat(3);
export const PERSON = 'robin@example.org';
export const IDENTITY_HEADER = 'X-Test-Identity';
export const REGISTRATIONS_PER_HOUR = Number(/export const REGISTRATIONS_PER_HOUR = (\d+);/.exec(readFileSync(new URL('../src/worker/standalone.ts', import.meta.url), 'utf8'))[1]);
export const ALL_TOOLS = ['fetch', 'get_config', 'get_feedback', 'get_funnel', 'list_feedback', 'list_projects', 'search', 'search_feedback', 'whoami'];

const config = { projectId: 'demo', templates: [{ type: 'bug', label: 'Bug' }], llm: { provider: 'off' }, tracker: { kind: 'github', defaultRepo: 'acme/site', patSecret: 'GITHUB_PAT_default' }, auth: { origins: [] } };

/** The stub: the person named in X-Test-Identity, or nobody. Test code only. */
export const stubIdentity = async (request) => {
  const who = request.headers.get(IDENTITY_HEADER);
  return who ? { email: who, sub: `sub-${who}` } : null;
};

/**
 * A gateway on a temporary SQLite file with one project and one feedback item. `existing` is a directory of an earlier
 * gateway (a restart); `authenticate` is the sign-in (the stub by default, `null` for the server's own, which has none).
 */
export async function gateway({ existing, authenticate = stubIdentity } = {}) {
  const dir = existing ?? mkdtempSync(join(tmpdir(), 'fk-oauth-'));
  const storage = openStorage(join(dir, 'feedbackkit.sqlite'), 'migrations');
  const kv = createKv(storage.sqlite);
  const env = { DB: storage.DB, UPLOADS: storage.UPLOADS, ASSETS: { fetch: async () => new Response('') }, FK_ENV: 'test', WIDGET_VERSION: 't', ADMIN_TOKEN: TOKEN, OAUTH_KV: kv };
  if (!existing) {
    await storage.DB.prepare("INSERT INTO projects (id, public_key, config, config_version, updated_at) VALUES ('demo', 'fk_pub_demo', ?1, 3, 0)").bind(JSON.stringify(config)).run();
    await storage.DB.prepare("INSERT INTO feedback (id, project_id, outcome, payload, issue_url, created_at, client_feedback_id, delivery) VALUES ('fb-1', 'demo', 'created', ?1, NULL, ?2, 'c-1', 'local')")
      .bind(JSON.stringify({ feedbackId: 'c-1', message: 'The save button does nothing' }), Date.now()).run();
  }
  const mcpFetch = authenticate ? createMcpFetch(ORIGIN, { authenticate }) : createMcpFetch(ORIGIN);
  // One context for every request, as scripts/server.mjs has: the server must not let the provider write a grant's props onto it.
  const shared = { waitUntil() {}, passThroughOnException() {} };
  const calls = { count: 0 };
  /** One request to the OAuth/MCP side; `ip` is the client address the server would have set, `as` the signed-in person (null: nobody). */
  const request = (path, init = {}, { ip = '203.0.113.7', as = PERSON } = {}) => {
    calls.count++;
    const headers = new Headers(init.headers);
    headers.set('CF-Connecting-IP', ip);
    if (as !== null && !headers.has(IDENTITY_HEADER)) headers.set(IDENTITY_HEADER, as);
    return mcpFetch(new Request(`${ORIGIN}${path}`, { ...init, headers }), env, shared);
  };
  return { env, kv, storage, dir, request, calls, close({ keep = false } = {}) { storage.close(); if (!keep) rmSync(dir, { recursive: true, force: true }); } };
}

export async function pkce() {
  const verifier = randomBytes(40).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** A browser: it keeps the cookies the consent page sets and sends them back with the form. */
export function browser() {
  const jar = new Map();
  return {
    remember(response) { for (const line of response.headers.getSetCookie()) { const [pair] = line.split(';'); const at = pair.indexOf('='); jar.set(pair.slice(0, at), pair.slice(at + 1)); } },
    cookie() { return [...jar].map(([k, v]) => `${k}=${v}`).join('; '); },
  };
}

export const form = (fields) => new URLSearchParams(fields).toString();

export async function register(gw, extra = {}) {
  const response = await gw.request('/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Test <Agent>', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], ...extra }),
  });
  if (response.status !== 201) throw new Error(`register answered ${response.status}: ${await response.text()}`);
  return (await response.json()).client_id;
}

export function authorizePath(clientId, { scope = 'feedback:read config:read', challenge, resource = `${ORIGIN}/mcp`, redirect = REDIRECT, state = 'st-123', method = 'S256' } = {}) {
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, scope, state, resource });
  if (challenge) { q.set('code_challenge', challenge); q.set('code_challenge_method', method); }
  return `/oauth/authorize?${q}`;
}

/** Opens the consent page like a browser would and returns its handle and the browser that holds the cookie. */
export async function openConsent(gw, path, jar = browser(), options) {
  const response = await gw.request(path, {}, options);
  jar.remember(response);
  const html = await response.text();
  return { response, html, jar, handle: /name="handle" value="([^"]+)"/.exec(html)?.[1] ?? '' };
}

export function postDecision(gw, { handle, jar, decision = 'allow', origin = ORIGIN, headers = {}, options }) {
  const fields = { handle, decision };
  return gw.request('/oauth/authorize', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, Cookie: jar.cookie(), ...headers }, body: form(fields) }, options);
}

/** The whole consent: register, open the page as the signed-in person, click Allow. Returns the code and PKCE verifier. */
export async function authorizeClient(gw, { scope = 'feedback:read config:read', clientId } = {}) {
  clientId ??= await register(gw);
  const { verifier, challenge } = await pkce();
  const { handle, jar } = await openConsent(gw, authorizePath(clientId, { scope, challenge }));
  const done = await postDecision(gw, { handle, jar });
  if (done.status !== 302) throw new Error(`consent answered ${done.status}: ${await done.text()}`);
  const code = new URL(done.headers.get('Location')).searchParams.get('code');
  return { clientId, code, verifier };
}

export function exchange(gw, { clientId, code, verifier, resource = `${ORIGIN}/mcp`, redirect = REDIRECT }) {
  const fields = { grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: clientId, code_verifier: verifier };
  if (resource) fields.resource = resource;
  return gw.request('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(fields) });
}

/** Register, consent and exchange: a working grant. */
export async function connect(gw, options) {
  const granted = await authorizeClient(gw, options);
  const response = await exchange(gw, granted);
  if (response.status !== 200) throw new Error(`token answered ${response.status}: ${await response.text()}`);
  return { ...granted, ...(await response.json()) };
}

/** One JSON-RPC call to /mcp; handles a JSON body and a one-event SSE body. */
export async function rpc(gw, accessToken, method, params = {}, id = 1) {
  const response = await gw.request('/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const text = await response.text();
  const body = response.status === 200 ? JSON.parse(text.startsWith('event:') || text.startsWith('data:') ? text.split('\n').find((l) => l.startsWith('data:')).slice(5) : text) : null;
  return { status: response.status, body, text, response };
}

export const toolNames = async (gw, accessToken) => (await rpc(gw, accessToken, 'tools/list')).body.result.tools.map((t) => t.name).sort();
