import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { AuthorizationError } from "@cloudflare/workers-oauth-provider";
import { workerFetch } from "../../src/worker/oauth/provider.js";
import { grantedScopes } from "../../src/worker/oauth/authorize.js";
import type { AuthProps } from "../../src/worker/mcp/scopes.js";
import type { Env } from "../../src/worker/env.js";
import { resetStorage } from "./reset.js";

// ADR-015 on both runtimes. The real OAuth provider and the real MCP server run once in workerd against Cloudflare KV
// and D1 (vitest.workers.config.ts) and once on Node against the standalone server's SQLite (vitest.conformance.config.ts).
// The assertions are the same, so a difference between the runtimes fails one of the runs.
//
// The sign-in step is the one thing that differs by design (Access on the Worker, the admin token on the standalone
// server), so this suite replaces it with a handler that approves at once; test/mcp-oauth.test.ts covers the Access
// consent page and test/server-oauth.test.mjs the admin-token one. Expiry is not here either: workerd's clock cannot
// be moved, so test/server-oauth.test.mjs moves it on SQLite.

const GW = "https://gw.test";
const REDIRECT = "https://client.example/callback";
const gw = { ...env, ADMIN_TOKEN: "s3cret", FK_ENV: "test" } as unknown as Env;
const ctx = () => ({ waitUntil() {}, passThroughOnException() {} }) as unknown as ExecutionContext;

// Approves every valid request as a fixed test user, and shows a provider error the way the real consent page does.
const approve = new Hono<{ Bindings: Env }>();
approve.get("/oauth/authorize", async (c) => {
  const oauth = c.env.OAUTH_PROVIDER!;
  try {
    const request = await oauth.parseAuthRequest(c.req.raw);
    const scopes = grantedScopes(request.scope);
    const props: AuthProps = { email: "tester@example.org", sub: "tester", clientId: request.clientId, clientName: "Test agent", scopes };
    const { redirectTo } = await oauth.completeAuthorization({ request, userId: "tester", metadata: {}, scope: scopes, props });
    return new Response(null, { status: 302, headers: { Location: redirectTo } });
  } catch (e) {
    if (e instanceof AuthorizationError) return e.redirectTo ? new Response(null, { status: 302, headers: { Location: e.redirectTo } }) : new Response(e.description, { status: 400 });
    throw e;
  }
});

const call = (path: string, init: RequestInit = {}) => workerFetch(approve, new Request(`${GW}${path}`, init), gw, ctx(), { clientIdMetadataDocuments: false });
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const formBody = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const post = { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" } };

async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(40)));
  return { verifier, challenge: b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))) };
}

async function register(): Promise<string> {
  const res = await call("/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Test agent", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

const authorizePath = (clientId: string, challenge: string, o: { scope?: string; resource?: string; redirect?: string } = {}) =>
  `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: o.redirect ?? REDIRECT, scope: o.scope ?? "feedback:read config:read", state: "st-1", code_challenge: challenge, code_challenge_method: "S256", resource: o.resource ?? `${GW}/mcp` })}`;

async function grant(scope = "feedback:read config:read") {
  const clientId = await register();
  const { verifier, challenge } = await pkce();
  const res = await call(authorizePath(clientId, challenge, { scope }));
  expect(res.status).toBe(302);
  const code = new URL(res.headers.get("Location")!).searchParams.get("code")!;
  const tok = await call("/oauth/token", { ...post, body: formBody({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: `${GW}/mcp` }) });
  expect(tok.status).toBe(200);
  return { clientId, code, verifier, ...((await tok.json()) as { access_token: string; refresh_token: string; scope: string; expires_in: number }) };
}

async function rpc(token: string, method: string, params: unknown = {}) {
  const res = await call("/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  const data = text.startsWith("event:") || text.startsWith("data:") ? text.split("\n").find((l) => l.startsWith("data:"))!.slice(5) : text;
  return { status: res.status, headers: res.headers, body: res.status === 200 ? JSON.parse(data) : null };
}
const tools = async (token: string) => ((await rpc(token, "tools/list")).body.result.tools as { name: string }[]).map((t) => t.name).sort();
const ALL = ["fetch", "get_config", "get_feedback", "get_funnel", "list_feedback", "list_projects", "search", "search_feedback", "whoami"];

async function emptyKv() {
  let cursor: string | undefined;
  do {
    const page = await env.OAUTH_KV!.list({ cursor });
    await Promise.all(page.keys.map((k) => env.OAUTH_KV!.delete(k.name)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

beforeEach(async () => {
  await emptyKv();
  await resetStorage();
  const config = { projectId: "demo", templates: [{ type: "bug", label: "Bug" }], llm: { provider: "off" }, tracker: { kind: "github", defaultRepo: "acme/site", patSecret: "GITHUB_PAT_default" }, auth: { origins: [] } };
  await env.DB.prepare("INSERT INTO projects (id, public_key, config, config_version, updated_at) VALUES ('demo', 'fk_pub_demo', ?1, 3, 0)").bind(JSON.stringify(config)).run();
  await env.DB.prepare("INSERT INTO feedback (id, project_id, outcome, payload, created_at, client_feedback_id, delivery) VALUES ('fb-1', 'demo', 'created', ?1, 1, 'c-1', 'local')")
    .bind(JSON.stringify({ feedbackId: "c-1", message: "The save button does nothing" }))
    .run();
});

describe("discovery and registration", () => {
  it("publishes issuer, endpoints, scopes and the resource of this origin", async () => {
    const meta = (await (await call("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
    expect(meta).toMatchObject({ issuer: GW, authorization_endpoint: `${GW}/oauth/authorize`, token_endpoint: `${GW}/oauth/token`, registration_endpoint: `${GW}/oauth/register`, scopes_supported: ["feedback:read", "config:read"], code_challenge_methods_supported: ["S256"] });
    const resource = (await (await call("/.well-known/oauth-protected-resource/mcp")).json()) as Record<string, unknown>;
    expect(resource).toMatchObject({ resource: `${GW}/mcp`, authorization_servers: [GW] });
  });

  it("registers a client and refuses a plain-http redirect to a remote host", async () => {
    expect(await register()).toBeTruthy();
    const bad = await call("/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "x", redirect_uris: ["http://client.example/cb"], token_endpoint_auth_method: "none" }) });
    expect(bad.status).toBe(400);
  });
});

describe("authorize request checks", () => {
  it("refuses a redirect URI the client did not register, without redirecting to it", async () => {
    const clientId = await register();
    const res = await call(authorizePath(clientId, (await pkce()).challenge, { redirect: "https://evil.example/cb" }));
    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();
  });

  it("refuses an unknown client and a missing PKCE challenge, and a resource of another gateway", async () => {
    const { challenge } = await pkce();
    expect((await call(authorizePath("unknown-client", challenge))).status).toBe(400);
    const clientId = await register();
    const noPkce = await call(`/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, state: "s", resource: `${GW}/mcp` })}`);
    expect(new URL(noPkce.headers.get("Location")!).searchParams.get("error")).toBe("invalid_request");
    const wrong = await call(authorizePath(clientId, challenge, { resource: "https://other.test/mcp" }));
    expect(new URL(wrong.headers.get("Location")!).searchParams.get("error")).toBe("invalid_target");
  });
});

describe("token endpoint", () => {
  it("exchanges a code with the right verifier for access and refresh tokens", async () => {
    const g = await grant("feedback:read");
    expect(g.scope).toBe("feedback:read");
    expect(g.expires_in).toBe(3600);
    expect(g.access_token).toBeTruthy();
    expect(g.refresh_token).toBeTruthy();
  });

  it("refuses a wrong verifier, a replayed code, a foreign redirect URI and a resource of another gateway", async () => {
    const clientId = await register();
    const attempt = async (over: Record<string, string>, challengeOf?: string) => {
      const { verifier, challenge } = await pkce();
      const res = await call(authorizePath(clientId, challengeOf ?? challenge));
      const code = new URL(res.headers.get("Location")!).searchParams.get("code")!;
      return call("/oauth/token", { ...post, body: formBody({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: `${GW}/mcp`, ...over }) });
    };
    const wrongVerifier = await attempt({ code_verifier: (await pkce()).verifier });
    expect(wrongVerifier.status).toBe(400);
    expect(((await wrongVerifier.json()) as { error: string }).error).toBe("invalid_grant");
    expect((await attempt({ redirect_uri: "https://client.example/other" })).status).toBe(400);
    const mismatch = await attempt({ resource: "https://other.test/mcp" });
    expect(mismatch.status).toBe(400);
    expect(((await mismatch.json()) as { error: string }).error).toBe("invalid_target");
    const g = await grant();
    const replay = await call("/oauth/token", { ...post, body: formBody({ grant_type: "authorization_code", code: g.code, redirect_uri: REDIRECT, client_id: g.clientId, code_verifier: g.verifier, resource: `${GW}/mcp` }) });
    expect(replay.status).toBe(400);
  });

  it("refreshes: a new access token that works, and a refresh token two rotations old is dead", async () => {
    const g = await grant();
    const refresh = (token: string) => call("/oauth/token", { ...post, body: formBody({ grant_type: "refresh_token", refresh_token: token, client_id: g.clientId }) });
    const one = (await (await refresh(g.refresh_token)).json()) as { access_token: string; refresh_token: string };
    expect(one.refresh_token).not.toBe(g.refresh_token);
    expect((await rpc(one.access_token, "tools/list")).status).toBe(200);
    expect((await refresh(one.refresh_token)).status).toBe(200);
    expect((await refresh(g.refresh_token)).status).toBe(400);
  });

  it("revokes: the access token stops at once, the refresh token stops refreshing", async () => {
    const g = await grant();
    const revoke = (token: string) => call("/oauth/token", { ...post, body: formBody({ token, client_id: g.clientId }) });
    expect((await rpc(g.access_token, "tools/list")).status).toBe(200);
    expect((await revoke(g.access_token)).status).toBe(200);
    expect((await rpc(g.access_token, "tools/list")).status).toBe(401);
    expect((await revoke(g.refresh_token)).status).toBe(200);
    expect((await call("/oauth/token", { ...post, body: formBody({ grant_type: "refresh_token", refresh_token: g.refresh_token, client_id: g.clientId }) })).status).toBe(400);
  });
});

describe("/mcp", () => {
  it("answers 401 without a token or with a made-up one, naming the resource metadata, and 405 for GET", async () => {
    const none = await call("/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(none.status).toBe(401);
    expect(none.headers.get("WWW-Authenticate")).toContain(`resource_metadata="${GW}/.well-known/oauth-protected-resource/mcp"`);
    expect((await rpc("abc:def:ghi", "tools/list")).status).toBe(401);
    const g = await grant();
    expect((await call("/mcp", { headers: { Authorization: `Bearer ${g.access_token}` } })).status).toBe(405);
  });

  it("lists the tools the granted scopes allow", async () => {
    expect(await tools((await grant("feedback:read")).access_token)).toEqual(ALL.filter((n) => n !== "get_config"));
    expect(await tools((await grant("config:read")).access_token)).toEqual(["get_config", "whoami"]);
    expect(await tools((await grant("feedback:read config:read")).access_token)).toEqual(ALL);
    expect(await tools((await grant("openid admin:write")).access_token)).toEqual(ALL.filter((n) => n !== "get_config"));
  });

  it("returns stored data from a read tool, and refuses a tool outside the scope", async () => {
    const feedback = await grant("feedback:read");
    const projects = await rpc(feedback.access_token, "tools/call", { name: "list_projects", arguments: {} });
    expect(projects.body.result.structuredContent.projects[0].id).toBe("demo");
    const items = await rpc(feedback.access_token, "tools/call", { name: "list_feedback", arguments: { project: "demo" } });
    expect(items.body.result.structuredContent.items[0].message).toBe("The save button does nothing");
    const outside = await rpc(feedback.access_token, "tools/call", { name: "get_config", arguments: { project: "demo" } });
    expect(outside.body.error.code).toBe(-32602);
    const config = await grant("config:read");
    const read = await rpc(config.access_token, "tools/call", { name: "get_config", arguments: { project: "demo" } });
    expect(read.body.result.structuredContent.projectId).toBe("demo");
    expect((await rpc(config.access_token, "tools/call", { name: "list_projects", arguments: {} })).body.error.code).toBe(-32602);
  });

  it("whoami reports the identity the sign-in step stored, the client and the scopes", async () => {
    const g = await grant("feedback:read");
    const who = (await rpc(g.access_token, "tools/call", { name: "whoami", arguments: {} })).body.result.structuredContent;
    expect(who).toMatchObject({ email: "tester@example.org", clientName: "Test agent", scopes: ["feedback:read"], gateway: GW, grant: { accessTokenTtlSeconds: 3600, refreshTokenTtlSeconds: 2592000 } });
  });

  it("serves two grants at once without mixing their scopes", async () => {
    const a = await grant("feedback:read");
    const b = await grant("config:read");
    const jobs: Promise<[string, string[]]>[] = [];
    for (let i = 0; i < 20; i++) {
      jobs.push(tools(a.access_token).then((t) => ["a", t] as [string, string[]]));
      jobs.push(tools(b.access_token).then((t) => ["b", t] as [string, string[]]));
    }
    for (const [who, names] of await Promise.all(jobs)) expect(names).toEqual(who === "a" ? ALL.filter((n) => n !== "get_config") : ["get_config", "whoami"]);
  });
});
