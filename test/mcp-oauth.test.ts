// MCP over OAuth 2.1 (ADR-015): the Worker entry with and without OAUTH_KV, and
// the /oauth/authorize consent flow against the real workers-oauth-provider
// (in-memory KV) with Cloudflare Access JWTs signed by a local test key.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import worker from "../src/worker/index.js";
import { resetProviders } from "../src/worker/oauth/provider.js";
import { grantedScopes } from "../src/worker/oauth/authorize.js";
import { resetAccessCache } from "../src/worker/admin/access.js";
import { AUD, TEAM, makeKey, claims, signJwt, jwksFetch, type TestKey } from "./access-helpers.js";
import { fakeD1, memoryKV, type MemoryKV } from "./helpers.js";
import type { Env } from "../src/worker/env.js";

const GW = "https://gw.test";
const REDIRECT = "https://client.example/callback";

let key: TestKey;
beforeAll(async () => {
  key = await makeKey("kid-1");
});
beforeEach(() => {
  resetAccessCache();
  resetProviders();
  vi.stubGlobal("fetch", jwksFetch([key]).fn);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function envOf(kv: MemoryKV | null, extra: Record<string, unknown> = {}): Env {
  return {
    DB: fakeD1(() => null),
    UPLOADS: { get: async () => null } as unknown as R2Bucket,
    ASSETS: { fetch: async () => new Response("") } as unknown as Fetcher,
    FK_ENV: "test",
    WIDGET_VERSION: "t",
    ADMIN_TOKEN: "adm1n-token",
    FK_ACCESS_TEAM_DOMAIN: TEAM,
    FK_ACCESS_AUD: AUD,
    ...(kv ? { OAUTH_KV: kv } : {}),
    ...extra,
  } as unknown as Env;
}

const ctx = () => ({ waitUntil() {}, passThroughOnException() {}, props: {} }) as unknown as ExecutionContext;
const fetchW = (e: Env, path: string, init: RequestInit = {}) => worker.fetch(new Request(`${GW}${path}`, init), e, ctx());

const grants = (kv: MemoryKV) => [...kv.data.keys()].filter((k) => k.startsWith("grant:"));

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = "v".repeat(20) + crypto.randomUUID().replace(/-/g, "");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { verifier, challenge };
}

async function register(e: Env): Promise<string> {
  const res = await fetchW(e, "/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Test <Agent>", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

async function authorizeUrl(clientId: string, scope = "feedback:read config:read") {
  const { verifier, challenge } = await pkce();
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope,
    state: "st-123",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${GW}/mcp`,
  });
  return { path: `/oauth/authorize?${q}`, verifier };
}

const accessHeaders = async (email = "dana@example.com") => ({ "Cf-Access-Jwt-Assertion": await signJwt(key, claims({ email })) });

/** GET the consent page; returns the handle and the binding cookie. */
async function consent(e: Env, path: string): Promise<{ res: Response; html: string; handle: string; cookie: string }> {
  const res = await fetchW(e, path, { headers: await accessHeaders() });
  const html = await res.text();
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1] ?? "";
  const cookie = (res.headers.get("Set-Cookie") ?? "").split(";")[0]!;
  return { res, html, handle, cookie };
}

async function decide(e: Env, handle: string, cookie: string, decision: string, headers: Record<string, string> = {}) {
  return fetchW(e, "/oauth/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: GW, Cookie: cookie, ...(await accessHeaders()), ...headers },
    body: new URLSearchParams({ handle, decision }).toString(),
  });
}

describe("worker entry without OAUTH_KV", () => {
  it("answers /mcp and the OAuth paths with 404 and a clear message", async () => {
    const e = envOf(null);
    for (const path of ["/mcp", "/oauth/authorize", "/oauth/token", "/.well-known/oauth-authorization-server"]) {
      const res = await fetchW(e, path, { method: path === "/oauth/token" ? "POST" : "GET" });
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).toMatch(/FK_OAUTH_KV_ID/);
    }
  });

  it("still serves the rest of the gateway", async () => {
    const res = await fetchW(envOf(null), "/t/fk_pub_demo0001");
    expect(res.status).toBe(200);
  });
});

describe("worker entry with OAUTH_KV", () => {
  it("401s /mcp without a token and points to the resource metadata", async () => {
    const res = await fetchW(envOf(memoryKV()), "/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain(`resource_metadata="${GW}/.well-known/oauth-protected-resource/mcp"`);
  });

  it("401s /mcp with a made-up token", async () => {
    const res = await fetchW(envOf(memoryKV()), "/mcp", { method: "POST", headers: { Authorization: "Bearer abc:def:ghi" }, body: "{}" });
    expect(res.status).toBe(401);
  });

  it("publishes the resource and authorization server metadata", async () => {
    const e = envOf(memoryKV());
    const pr = (await (await fetchW(e, "/.well-known/oauth-protected-resource/mcp")).json()) as { resource: string };
    expect(pr.resource).toBe(`${GW}/mcp`);
    const as = (await (await fetchW(e, "/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
    expect(as).toMatchObject({ issuer: GW, authorization_endpoint: `${GW}/oauth/authorize`, token_endpoint: `${GW}/oauth/token`, registration_endpoint: `${GW}/oauth/register` });
    expect(as["scopes_supported"]).toEqual(["feedback:read", "config:read"]);
  });

  it("keeps serving the app's own routes", async () => {
    expect((await fetchW(envOf(memoryKV()), "/t/fk_pub_demo0001")).status).toBe(200);
  });

  it("on a plain-http origin turns MCP off instead of failing the whole gateway", async () => {
    const e = envOf(memoryKV());
    const at = (path: string) => worker.fetch(new Request(`http://gw.example${path}`), e, ctx());
    expect((await at("/t/fk_pub_demo0001")).status).toBe(200);
    const mcp = await at("/mcp");
    expect(mcp.status).toBe(404);
    expect(await mcp.text()).toContain("https");
  });
});

describe("/oauth/authorize", () => {
  it("grants nothing without an Access identity", async () => {
    const kv = memoryKV();
    const e = envOf(kv);
    const { path } = await authorizeUrl(await register(e));
    const res = await fetchW(e, path);
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain("Sign-in required");
    expect(html).not.toContain('name="handle"');
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(grants(kv)).toEqual([]);
  });

  it("grants nothing when Access is not configured, even with a JWT", async () => {
    const kv = memoryKV();
    const e = envOf(kv, { FK_ACCESS_AUD: undefined });
    const { path } = await authorizeUrl(await register(e));
    expect((await fetchW(e, path, { headers: await accessHeaders() })).status).toBe(403);
    expect(grants(kv)).toEqual([]);
  });

  it("renders the consent page for an Access user", async () => {
    const e = envOf(memoryKV());
    const { path } = await authorizeUrl(await register(e));
    const { res, html, handle, cookie } = await consent(e, path);
    expect(res.status).toBe(200);
    expect(html).toContain("Connect Test &lt;Agent&gt;"); // client-chosen name, escaped
    expect(html).not.toContain("<Agent>");
    expect(html).toContain("Signed in as <b>dana@example.com</b>");
    expect(html).toContain("Read projects, feedback and funnel numbers");
    expect(html).toContain("Read project configuration");
    expect(html).toContain("client.example");
    expect(html).not.toMatch(/<script/i);
    expect(handle).not.toBe("");
    expect(cookie).toMatch(/^__Host-oauth-consent/);
    const csp = res.headers.get("Content-Security-Policy")!;
    expect(csp).toMatch(/style-src 'nonce-[0-9a-f]+'/);
    expect(csp).toContain("form-action 'self' https://client.example");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("Cancel denies: back to the client with access_denied, no grant", async () => {
    const kv = memoryKV();
    const e = envOf(kv);
    const { path } = await authorizeUrl(await register(e));
    const { handle, cookie } = await consent(e, path);
    const res = await decide(e, handle, cookie, "cancel");
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("Location")!);
    expect(`${to.origin}${to.pathname}`).toBe(REDIRECT);
    expect(to.searchParams.get("error")).toBe("access_denied");
    expect(to.searchParams.get("state")).toBe("st-123");
    expect(grants(kv)).toEqual([]);
  });

  it("refuses the POST without an Access identity, from another origin, or without the browser cookie", async () => {
    const kv = memoryKV();
    const e = envOf(kv);
    const { path } = await authorizeUrl(await register(e));
    const { handle, cookie } = await consent(e, path);
    const noAccess = await fetchW(e, "/oauth/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: GW, Cookie: cookie },
      body: new URLSearchParams({ handle, decision: "allow" }).toString(),
    });
    expect(noAccess.status).toBe(403);
    expect((await decide(e, handle, cookie, "allow", { Origin: "https://evil.example" })).status).toBe(403);
    expect((await decide(e, handle, "", "allow")).status).toBe(400);
    expect(grants(kv)).toEqual([]);
  });

  it("Allow grants the requested scopes, and the token opens /mcp", async () => {
    const kv = memoryKV();
    const e = envOf(kv);
    const clientId = await register(e);
    const { path, verifier } = await authorizeUrl(clientId, "feedback:read");
    const { handle, cookie } = await consent(e, path);
    const res = await decide(e, handle, cookie, "allow");
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("Location")!);
    expect(to.searchParams.get("state")).toBe("st-123");
    const code = to.searchParams.get("code")!;
    expect(code).toBeTruthy();
    expect(grants(kv)).toHaveLength(1);

    // The handle works once.
    expect((await decide(e, handle, cookie, "allow")).status).toBe(400);

    const tok = await fetchW(e, "/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: `${GW}/mcp` }).toString(),
    });
    expect(tok.status).toBe(200);
    const { access_token, scope } = (await tok.json()) as { access_token: string; scope: string };
    expect(scope).toBe("feedback:read");

    const mcp = await fetchW(e, "/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: {} } }),
    });
    expect(mcp.status).toBe(200);
    const text = await mcp.text();
    expect(text).toContain('\\"email\\":\\"dana@example.com\\"');
    expect(text).toContain('\\"scopes\\":[\\"feedback:read\\"]');
    expect(text).toContain('\\"clientName\\":\\"Test <Agent>\\"');
  });

  it("grants the default scope when the client asks for none of ours", () => {
    expect(grantedScopes([])).toEqual(["feedback:read"]);
    expect(grantedScopes(["openid", "admin:write"])).toEqual(["feedback:read"]);
    expect(grantedScopes(["config:read", "config:read"])).toEqual(["config:read"]);
  });

  it("shows a local error page for an unknown client and does not redirect", async () => {
    const e = envOf(memoryKV());
    const { path } = await authorizeUrl("unknown-client");
    const res = await fetchW(e, path, { headers: await accessHeaders() });
    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();
  });
});
