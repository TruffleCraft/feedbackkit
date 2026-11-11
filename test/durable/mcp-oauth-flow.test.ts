import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { AuthorizationError } from "@cloudflare/workers-oauth-provider";
import { workerFetch } from "../../src/worker/oauth/provider.js";
import { createApiToken, revokeApiToken } from "../../src/worker/auth/tokens.js";
import { AUTH_FAIL_IP_LIMIT } from "../../src/worker/auth/throttle.js";
import { MCP_CALLS_PER_HOUR } from "../../src/worker/mcp/server.js";
import { grantedScopes } from "../../src/worker/oauth/authorize.js";
import type { AuthProps } from "../../src/worker/mcp/scopes.js";
import type { Env } from "../../src/worker/env.js";
import { resetStorage } from "./reset.js";

// ADR-015 on both runtimes. The real OAuth provider and the real MCP server run once in workerd against Cloudflare KV
// and D1 (vitest.workers.config.ts) and once on Node against the standalone server's SQLite (vitest.conformance.config.ts).
// The assertions are the same, so a difference between the runtimes fails one of the runs.
//
// The sign-in step is the one thing that differs by runtime (Access on the Worker, the account session on both), so
// this suite replaces it with a handler that approves at once; test/mcp-oauth.test.ts covers the Access consent page,
// test/server-mcp-accounts.test.mjs the account session on the standalone server. Scoped API tokens as a bearer
// (ADR-015, second amendment) are the same code on both runtimes and are tested here, against the real D1 and the
// SQLite of the standalone server. Expiry of OAuth tokens is not here: workerd's clock cannot be moved, so
// test/server-oauth.test.mjs moves it on SQLite. An API token's expiry is data (a past `now` at creation), so it is here.

const GW = "https://gw.test";
const REDIRECT = "https://client.example/callback";
const gw = { ...env, ADMIN_TOKEN: "s3cret", FK_ENV: "test" } as unknown as Env;
const ctx = () => ({ waitUntil() {}, passThroughOnException() {} }) as unknown as ExecutionContext;

// Approves every valid request as a fixed test user, and shows a provider error the way the real consent page does.
let approvingAccount: string | undefined; // set by the one test that checks a grant ends with its account
const approve = new Hono<{ Bindings: Env }>();
approve.get("/oauth/authorize", async (c) => {
  const oauth = c.env.OAUTH_PROVIDER!;
  try {
    const request = await oauth.parseAuthRequest(c.req.raw);
    const scopes = grantedScopes(request.scope);
    const props: AuthProps = { email: "tester@example.org", sub: "tester", clientId: request.clientId, clientName: "Test agent", scopes, ...(approvingAccount ? { accountId: approvingAccount } : {}) };
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
  approvingAccount = undefined;
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

  it("registers a client that states its application_type, as the 2026-07-28 authorization spec asks of clients (SEP-837)", async () => {
    for (const application_type of ["web", "native"]) {
      const res = await call("/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Test agent", application_type, redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }) });
      expect(res.status, application_type).toBe(201);
    }
  });

  it("puts the issuer on the authorization response, as the spec wants for RFC 9207 (SEP-2468)", async () => {
    const clientId = await register();
    const res = await call(authorizePath(clientId, (await pkce()).challenge));
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("Location")!).searchParams.get("iss")).toBe(GW);
    const meta = (await (await call("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
    expect(meta["authorization_response_iss_parameter_supported"]).toBe(true);
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

// ── Scoped API tokens as a bearer on /mcp (ADR-015, second amendment) ─────────────────────────────────────────────

const account = async (id: string, state = "active") =>
  env.DB.prepare("INSERT INTO accounts (id, name, name_key, role, state, created_at) VALUES (?1, ?2, ?3, 'owner', ?4, 1)").bind(id, `Robin ${id}`, `robin ${id}`, state).run();

async function token(over: Partial<{ access: "read" | "write"; projects: string[] | null; days: number; now: number; name: string; accountId: string }> = {}) {
  const accountId = over.accountId ?? "acct-1";
  if (!(await env.DB.prepare("SELECT id FROM accounts WHERE id = ?1").bind(accountId).first())) await account(accountId);
  return createApiToken(gw, { accountId, name: over.name ?? "litellm", access: over.access ?? "read", projects: over.projects ?? null, days: over.days ?? 30, ...(over.now !== undefined ? { now: over.now } : {}) });
}

/** A request to /mcp with a bearer token from a client address; the body is a plain tools/list unless given. */
const withToken = (bearer: string, ip = "203.0.113.5", body: unknown = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) =>
  call("/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "CF-Connecting-IP": ip },
    body: JSON.stringify(body),
  });
const bodyOf = async (res: Response) => {
  const text = await res.text();
  return JSON.parse(text.startsWith("event:") ? text.split("\n").find((l) => l.startsWith("data:"))!.slice(5) : text) as Record<string, any>;
};
const toolCall = async (bearer: string, name: string, args: Record<string, unknown> = {}) => {
  const res = await withToken(bearer, "203.0.113.5", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  return { status: res.status, json: await bodyOf(res) };
};

async function otherProject() {
  const config = { projectId: "other", templates: [{ type: "bug", label: "Bug" }], llm: { provider: "off" }, tracker: { kind: "github", defaultRepo: "acme/other", patSecret: "GITHUB_PAT_default" }, auth: { origins: [] } };
  await env.DB.prepare("INSERT INTO projects (id, public_key, config, config_version, updated_at) VALUES ('other', 'fk_pub_other', ?1, 1, 0)").bind(JSON.stringify(config)).run();
  await env.DB.prepare("INSERT INTO feedback (id, project_id, outcome, payload, created_at, client_feedback_id, delivery) VALUES ('fb-2', 'other', 'created', ?1, 2, 'c-2', 'local')")
    .bind(JSON.stringify({ feedbackId: "c-2", message: "The save button also does nothing here" }))
    .run();
}

describe("scoped API tokens as a bearer", () => {
  it("lets a valid token list the tools and read, read and write tokens alike (the tools only read)", async () => {
    for (const access of ["read", "write"] as const) {
      const { token: t } = await token({ access });
      const list = await withToken(t);
      expect(list.status, access).toBe(200);
      const names = ((await bodyOf(list)) as { result: { tools: { name: string }[] } }).result.tools.map((x) => x.name);
      expect(names, access).toContain("list_projects");
      expect(names, access).toContain("get_config");
      const projects = await toolCall(t, "list_projects");
      expect(projects.json["result"].structuredContent.projects.map((p: { id: string }) => p.id), access).toEqual(["demo"]);
    }
  });

  it("tells whoami that it is a token: its name, its project list and when it ends, and no OAuth lifetimes", async () => {
    const { token: t, row } = await token({ projects: ["demo"], name: "litellm-prod" });
    const who = (await toolCall(t, "whoami")).json["result"].structuredContent;
    expect(who).toMatchObject({ via: "api-token", clientName: "litellm-prod", projects: ["demo"], scopes: ["feedback:read", "config:read"], gateway: GW });
    expect(who.grant).toEqual({ tokenExpiresAt: new Date(row.expiresAt).toISOString() });
  });

  it("answers a revoked token 401 from the next request on, a token that has ended 401, and an account that was removed 401", async () => {
    const { token: t, row } = await token();
    expect((await withToken(t)).status).toBe(200);
    await revokeApiToken(gw, row.id);
    const revoked = await withToken(t);
    expect(revoked.status).toBe(401);
    expect(revoked.headers.get("WWW-Authenticate")).toContain("invalid_token");
    expect(await revoked.text()).toContain("revoked");

    const ended = await token({ now: Date.now() - 40 * 86_400_000, days: 30 });
    const endedRes = await withToken(ended.token);
    expect(endedRes.status).toBe(401);
    expect(await endedRes.text()).toContain("expired");

    const live = await token({ accountId: "acct-2" });
    expect((await withToken(live.token)).status).toBe(200);
    await env.DB.prepare("UPDATE accounts SET state = 'removed' WHERE id = 'acct-2'").run();
    const gone = await withToken(live.token);
    expect(gone.status).toBe(401);
    expect(await gone.text()).toContain("no longer active");
  });

  it("answers an unknown token, a made-up fk_tok_ value and a bearer that is no token of ours with 401, and puts nothing of the token in the answer", async () => {
    const bogus = `fk_tok_${"x".repeat(43)}`;
    for (const bearer of [bogus, "not-a-token", "admin:grant:secret"]) {
      const res = await withToken(bearer);
      expect(res.status, bearer).toBe(401);
      const text = await res.text();
      expect(text).not.toContain(bearer);
      expect([...res.headers].join("\n")).not.toContain(bearer);
    }
  });

  it("takes the token from the Authorization header only: one in the URL is ignored", async () => {
    const { token: t } = await token();
    const urlOnly = await call(`/mcp?access_token=${t}&token=${t}`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
    expect(urlOnly.status).toBe(401);
    expect(await urlOnly.text()).not.toContain(t);
    // Both given: the header decides, and the URL's copy is not echoed.
    const both = await call(`/mcp?access_token=${t}`, { method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
    expect(both.status).toBe(200);
    expect(await both.text()).not.toContain(t);
  });

  it("shows a token limited to some projects only those: lists, reports, search, funnel, config and the connector tools", async () => {
    await otherProject();
    const limited = (await token({ projects: ["demo"] })).token;
    const all = (await token({ projects: null, accountId: "acct-3" })).token;
    expect((await toolCall(all, "list_projects")).json["result"].structuredContent.projects.map((p: { id: string }) => p.id)).toEqual(["demo", "other"]);
    expect((await toolCall(limited, "list_projects")).json["result"].structuredContent.projects.map((p: { id: string }) => p.id)).toEqual(["demo"]);

    const refused = async (name: string, args: Record<string, unknown>) => {
      const r = (await toolCall(limited, name, args)).json["result"];
      expect(r.isError, name).toBe(true);
      expect(r.structuredContent.error.code, name).toBe("not_found");
    };
    await refused("list_feedback", { project: "other" });
    await refused("get_funnel", { project: "other" });
    await refused("get_config", { project: "other" });
    await refused("search_feedback", { project: "other", query: "button" });
    await refused("get_feedback", { id: "fb-2" });
    await refused("fetch", { id: "fb-2" });
    // The same calls on the covered project work, and the same refusal reads like a missing project (no hint that it exists).
    expect((await toolCall(limited, "list_feedback", { project: "demo" })).json["result"].structuredContent.items).toHaveLength(1);
    expect((await toolCall(limited, "get_feedback", { id: "fb-1" })).json["result"].isError).toBeUndefined();
    expect((await toolCall(limited, "get_feedback", { id: "no-such-report" })).json["result"].structuredContent.error.message).toBe((await toolCall(limited, "get_feedback", { id: "fb-2" })).json["result"].structuredContent.error.message);
    // Search without a project covers only the token's projects, and the connector's search too.
    const hits = (await toolCall(limited, "search_feedback", { query: "button" })).json["result"].structuredContent.hits;
    expect(hits.map((h: { id: string }) => h.id)).toEqual(["fb-1"]);
    expect((await toolCall(limited, "search", { query: "button" })).json["result"].structuredContent.results.map((h: { id: string }) => h.id)).toEqual(["fb-1"]);
    expect((await toolCall(all, "search_feedback", { query: "button" })).json["result"].structuredContent.hits.map((h: { id: string }) => h.id)).toEqual(["fb-2", "fb-1"]);
    // A token limited to a project that does not exist (any more) sees nothing and fails nothing.
    const ghost = (await token({ projects: ["deleted"], accountId: "acct-4" })).token;
    expect((await toolCall(ghost, "list_projects")).json["result"].structuredContent.projects).toEqual([]);
    expect((await toolCall(ghost, "search_feedback", { query: "button" })).json["result"].structuredContent.hits).toEqual([]);
  });

  it("counts calls per token: one token over its hour is limited, another is not", async () => {
    const a = (await token({ name: "a" })).token;
    const b = (await token({ name: "b", accountId: "acct-5" })).token;
    expect((await withToken(a)).status).toBe(200);
    const rows = (await env.DB.prepare("SELECT key FROM counters WHERE key LIKE 'mcp:%'").all<{ key: string }>()).results;
    expect(rows).toHaveLength(1);
    await env.DB.prepare("UPDATE counters SET count = ?1 WHERE key = ?2").bind(MCP_CALLS_PER_HOUR, rows[0]!.key).run();
    const over = await withToken(a);
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect((await withToken(b)).status).toBe(200);
  });

  it("counts failed tokens per client address, answers 429 past the limit, and never refuses a valid token for that", async () => {
    const { token: t } = await token();
    const ip = "198.51.100.77";
    for (let i = 0; i < AUTH_FAIL_IP_LIMIT; i++) expect((await withToken(`fk_tok_${String(i).padStart(43, "y")}`, ip)).status, `failure ${i + 1}`).toBe(401);
    const limited = await withToken(`fk_tok_${"z".repeat(43)}`, ip);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect((await withToken(t, ip)).status).toBe(200);
    expect((await withToken(`fk_tok_${"w".repeat(43)}`, "198.51.100.78")).status).toBe(401);
  });

  it("writes the token nowhere: not into the counters, not into a log line", async () => {
    const { token: t } = await token();
    const logged: string[] = [];
    const originals = ["log", "info", "warn", "error", "debug"].map((name) => {
      const fn = (console as unknown as Record<string, (...a: unknown[]) => void>)[name]!;
      (console as unknown as Record<string, unknown>)[name] = (...a: unknown[]) => logged.push(a.map(String).join(" "));
      return [name, fn] as const;
    });
    try {
      await withToken(t);
      await withToken(`fk_tok_${"q".repeat(43)}`);
      await revokeApiToken(gw, (await env.DB.prepare("SELECT id FROM api_tokens LIMIT 1").first<{ id: string }>())!.id);
      await withToken(t);
    } finally {
      for (const [name, fn] of originals) (console as unknown as Record<string, unknown>)[name] = fn;
    }
    expect(logged.join("\n")).not.toContain(t);
    expect(JSON.stringify((await env.DB.prepare("SELECT * FROM counters").all()).results)).not.toContain(t);
  });

  it("ends an OAuth connection that an account approved when the account is removed, and leaves other connections alone", async () => {
    await account("acct-9");
    approvingAccount = "acct-9";
    const mine = await grant("feedback:read");
    approvingAccount = undefined;
    const others = await grant("feedback:read"); // an Access-style grant: no account behind it
    expect((await rpc(mine.access_token, "tools/list")).status).toBe(200);
    await env.DB.prepare("UPDATE accounts SET state = 'removed' WHERE id = 'acct-9'").run();
    expect((await rpc(mine.access_token, "tools/list")).status).toBe(401);
    expect((await rpc(others.access_token, "tools/list")).status).toBe(200);
  });
});
