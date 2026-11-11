import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { mcpApi } from "../../src/worker/mcp/server.js";
import { TOOLS } from "../../src/worker/mcp/tools.js";
import type { AuthProps } from "../../src/worker/mcp/scopes.js";
import type { Env } from "../../src/worker/env.js";
import { resetStorage } from "./reset.js";

// MCP specification revision 2026-07-28, the parts a read-only tool server meets, against the gateway's /mcp handler
// (src/worker/mcp/server.ts: the Agents SDK's createMcpHandler over MCP SDK 2.0.0). It runs twice, like the rest of
// test/durable: in workerd (vitest.workers.config.ts) and on Node (vitest.conformance.config.ts), so a runtime
// difference fails one run. The OAuth layer in front of /mcp has its own suites (mcp-oauth-flow.test.ts); here the
// handler gets the grant's props the way the provider hands them over.
//
// Sources, all under https://modelcontextprotocol.io/specification/2026-07-28/ :
//   changelog, basic/transports/streamable-http (request metadata, server validation, backward compatibility),
//   basic/versioning, basic/index (_meta, resultType, error codes), server/discover, server/tools,
//   server/utilities/caching, basic/patterns/subscriptions.
// The section is named in each test. "Known limit" tests pin what the SDK or the Agents SDK does not do, so that a
// release that fixes it shows up as a failing test to update.

const GW = "https://gw.test";
const MODERN = "2026-07-28";
const LEGACY = "2025-11-25";
const BOTH = ["feedback:read", "config:read"] as const;

const gw = { ...env, ADMIN_TOKEN: "s3cret", FK_ENV: "test" } as unknown as Env;
const principal = (scopes: readonly string[]): AuthProps => ({ email: "dana@example.com", sub: "s", clientId: "c1", clientName: "Test agent", scopes: [...scopes] as AuthProps["scopes"] });

const meta = (over: Record<string, unknown> = {}) => ({
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: "conformance", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
  ...over,
});

interface Reply {
  status: number;
  headers: Headers;
  json: Record<string, any> | null;
  text: string;
}

/** One POST to /mcp as the OAuth provider would hand it over: the request, the grant's props on the context. */
async function post(body: unknown, headers: Record<string, string> = {}, scopes: readonly string[] = BOTH): Promise<Reply> {
  const request = new Request(`${GW}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: principal(scopes) } as unknown as ExecutionContext;
  const res = await mcpApi.fetch(request, gw, ctx);
  const text = await res.text();
  // A JSON body, or the one event of a stream.
  const data = text.startsWith("event:") || text.startsWith("data:") ? (text.split("\n").find((l) => l.startsWith("data:")) ?? "data:").slice(5) : text;
  let json: Record<string, any> | null = null;
  try {
    json = data.trim() ? JSON.parse(data) : null;
  } catch {
    /* not JSON */
  }
  return { status: res.status, headers: res.headers, json, text };
}

/** A 2026-07-28 request: the metadata headers and the per-request _meta the transport requires. */
function modern(method: string, params: Record<string, unknown> = {}, over: { headers?: Record<string, string>; meta?: Record<string, unknown>; scopes?: readonly string[]; id?: number } = {}) {
  const name = typeof params["name"] === "string" ? (params["name"] as string) : undefined;
  return post(
    { jsonrpc: "2.0", id: over.id ?? 1, method, params: { ...params, _meta: meta(over.meta) } },
    { "MCP-Protocol-Version": MODERN, "Mcp-Method": method, ...(name ? { "Mcp-Name": name } : {}), ...over.headers },
    over.scopes,
  );
}

const toolNames = (r: Reply) => (r.json!["result"].tools as Array<{ name: string }>).map((t) => t.name);
const declared = (scopes: readonly string[]) => TOOLS.filter((t) => !t.scope || scopes.includes(t.scope)).map((t) => t.name);

beforeEach(resetStorage); // the per-grant rate limit counts in D1

describe("server/discover (server/discover)", () => {
  it("is implemented and answers with versions, capabilities, identity and caching hints", async () => {
    const r = await modern("server/discover");
    expect(r.status).toBe(200);
    const result = r.json!["result"];
    expect(result.resultType).toBe("complete");
    expect(result.supportedVersions).toContain(MODERN);
    expect(result.capabilities.tools).toBeDefined();
    expect(result._meta["io.modelcontextprotocol/serverInfo"]).toMatchObject({ name: "feedbackkit", version: expect.any(String) });
    expect(typeof result.instructions).toBe("string");
    // Caching (server/utilities/caching): both fields are required on server/discover results.
    expect(Number.isInteger(result.ttlMs) && result.ttlMs >= 0).toBe(true);
    expect(["public", "private"]).toContain(result.cacheScope);
  });

  it("serves a client that sends no clientInfo (it is optional)", async () => {
    const r = await modern("server/discover", {}, { meta: { "io.modelcontextprotocol/clientInfo": undefined } });
    expect(r.status).toBe(200);
  });
});

describe("per-request _meta (basic/index#_meta, basic/versioning)", () => {
  it("rejects a request without _meta, without the protocol version or without the client capabilities: 400 and -32602", async () => {
    const noMeta = await post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, { "MCP-Protocol-Version": MODERN, "Mcp-Method": "tools/list" });
    expect(noMeta.status).toBe(400);
    expect(noMeta.json!["error"].code).toBe(-32602);
    const noCapabilities = await modern("tools/list", {}, { meta: { "io.modelcontextprotocol/clientCapabilities": undefined } });
    expect(noCapabilities.status).toBe(400);
    expect(noCapabilities.json!["error"].code).toBe(-32602);
    const noVersion = await post(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/clientCapabilities": {} } } },
      { "MCP-Protocol-Version": MODERN, "Mcp-Method": "tools/list" },
    );
    expect(noVersion.status).toBe(400);
    expect(noVersion.json!["error"].code).toBe(-32602);
  });

  it("answers an unsupported version with 400, -32022 and the versions it supports", async () => {
    const r = await modern("tools/list", {}, { headers: { "MCP-Protocol-Version": "1900-01-01" }, meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01" } });
    expect(r.status).toBe(400);
    expect(r.json!["error"].code).toBe(-32022);
    expect(r.json!["error"].data.requested).toBe("1900-01-01");
    expect(r.json!["error"].data.supported).toContain(MODERN);
  });

  it("answers a header that disagrees with the body's protocol version with 400 and -32020 (HeaderMismatch)", async () => {
    const r = await modern("tools/list", {}, { meta: { "io.modelcontextprotocol/protocolVersion": LEGACY } });
    expect(r.status).toBe(400);
    expect(r.json!["error"].code).toBe(-32020);
  });

  it("answers an unknown method with 404 and -32601, and no longer knows ping or logging/setLevel", async () => {
    for (const method of ["foo/bar", "ping", "logging/setLevel"]) {
      const r = await modern(method);
      expect(r.status, method).toBe(404);
      expect(r.json!["error"].code, method).toBe(-32601);
    }
  });
});

describe("request metadata headers (basic/transports/streamable-http#request-metadata)", () => {
  it("requires Mcp-Method on every request: missing, or not the body's method (case counts), is 400 and -32020", async () => {
    const missing = await post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta() } }, { "MCP-Protocol-Version": MODERN });
    expect(missing.status).toBe(400);
    expect(missing.json!["error"].code).toBe(-32020);
    for (const wrong of ["tools/call", "Tools/List"]) {
      const r = await modern("tools/list", {}, { headers: { "Mcp-Method": wrong } });
      expect(r.status, wrong).toBe(400);
      expect(r.json!["error"].code, wrong).toBe(-32020);
    }
  });

  it("requires Mcp-Name on tools/call and checks it against params.name: missing or different is 400 and -32020", async () => {
    const body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: {}, _meta: meta() } };
    const missing = await post(body, { "MCP-Protocol-Version": MODERN, "Mcp-Method": "tools/call" });
    expect(missing.status).toBe(400);
    expect(missing.json!["error"].code).toBe(-32020);
    const different = await post(body, { "MCP-Protocol-Version": MODERN, "Mcp-Method": "tools/call", "Mcp-Name": "list_projects" });
    expect(different.status).toBe(400);
    expect(different.json!["error"].code).toBe(-32020);
    const right = await post(body, { "MCP-Protocol-Version": MODERN, "Mcp-Method": "tools/call", "Mcp-Name": "whoami" });
    expect(right.status).toBe(200);
  });

  it("decodes the Base64 sentinel form of Mcp-Name before comparing it", async () => {
    const r = await modern("tools/call", { name: "whoami", arguments: {} }, { headers: { "Mcp-Name": `=?base64?${btoa("whoami")}?=` } });
    expect(r.status).toBe(200);
    const wrong = await modern("tools/call", { name: "whoami", arguments: {} }, { headers: { "Mcp-Name": `=?base64?${btoa("list_projects")}?=` } });
    expect(wrong.status).toBe(400);
    expect(wrong.json!["error"].code).toBe(-32020);
  });

  it("needs Mcp-Name on no other method of this server (tools/list, server/discover)", async () => {
    expect((await modern("tools/list")).status).toBe(200);
    expect((await modern("server/discover")).status).toBe(200);
  });
});

describe("results (basic/index#resulttype, server/tools)", () => {
  it("carries resultType complete and the server's identity in _meta on discover, list and call results, errors from a tool included", async () => {
    const results = [
      (await modern("server/discover")).json!["result"],
      (await modern("tools/list")).json!["result"],
      (await modern("tools/call", { name: "whoami", arguments: {} })).json!["result"],
      (await modern("tools/call", { name: "get_feedback", arguments: { id: "does-not-exist" } })).json!["result"],
      (await modern("tools/call", { name: "get_feedback", arguments: {} })).json!["result"], // invalid input is a tool error too
    ];
    expect(results[3].isError).toBe(true);
    expect(results[4].isError).toBe(true);
    for (const result of results) {
      expect(result.resultType).toBe("complete");
      expect(result._meta["io.modelcontextprotocol/serverInfo"]).toMatchObject({ name: "feedbackkit" });
    }
  });

  it("answers an unknown tool with the JSON-RPC error -32602, and a tool outside the grant the same way (server/tools#error-handling)", async () => {
    const unknown = await modern("tools/call", { name: "no_such_tool", arguments: {} });
    expect(unknown.json!["error"].code).toBe(-32602);
    const outside = await modern("tools/call", { name: "get_config", arguments: { project: "demo" } }, { scopes: ["feedback:read"] });
    expect(outside.json!["error"].code).toBe(-32602);
  });
});

describe("tools/list (server/tools#listing-tools, server/utilities/caching)", () => {
  it("has ttlMs and cacheScope, and the scope is private because the list depends on the grant", async () => {
    const both = (await modern("tools/list")).json!["result"];
    const feedbackOnly = (await modern("tools/list", {}, { scopes: ["feedback:read"] })).json!["result"];
    for (const result of [both, feedbackOnly]) {
      expect(Number.isInteger(result.ttlMs) && result.ttlMs >= 0).toBe(true);
      expect(result.cacheScope).toBe("private");
    }
    // The reason: two grants see two lists. A public scope would let a cache hand the wider list to the narrower grant.
    expect(both.tools.length).toBeGreaterThan(feedbackOnly.tools.length);
  });

  it("returns the tools in one deterministic order: the same on every call, the order written down here, and the same relative order for a narrower grant", async () => {
    // The order is part of what clients cache and what lands in a model's prompt: a change here is deliberate, so it is spelled out.
    const ORDER = ["whoami", "list_projects", "list_feedback", "get_feedback", "search_feedback", "get_funnel", "get_config", "search", "fetch"];
    const first = toolNames(await modern("tools/list"));
    for (let i = 0; i < 5; i++) expect(toolNames(await modern("tools/list"))).toEqual(first);
    expect(first).toEqual(ORDER);
    expect(declared(BOTH)).toEqual(ORDER);
    expect(toolNames(await modern("tools/list", {}, { scopes: ["feedback:read"] }))).toEqual(ORDER.filter((n) => n !== "get_config"));
    expect(toolNames(await modern("tools/list", {}, { scopes: ["config:read"] }))).toEqual(["whoami", "get_config"]);
  });

  it("lists only what the grant allows, in one page: no nextCursor", async () => {
    const result = (await modern("tools/list", {}, { scopes: ["feedback:read"] })).json!["result"];
    expect(result.tools.map((t: { name: string }) => t.name)).not.toContain("get_config");
    expect(result.nextCursor).toBeUndefined();
  });

  it("describes each tool with a name, an input schema of type object and the read-only hint", async () => {
    for (const tool of (await modern("tools/list")).json!["result"].tools as Array<Record<string, any>>) {
      expect(typeof tool["name"]).toBe("string");
      expect(tool["inputSchema"].type).toBe("object");
      expect(tool["annotations"]).toMatchObject({ readOnlyHint: true });
    }
  });
});

describe("transport (basic/transports/streamable-http)", () => {
  it("accepts one notification per POST with 202 and no body", async () => {
    const r = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { "MCP-Protocol-Version": MODERN });
    expect(r.status).toBe(202);
    expect(r.text).toBe("");
  });

  it("answers GET, DELETE and OPTIONS to the MCP endpoint with 405 (no stream endpoint, no sessions)", async () => {
    for (const method of ["GET", "DELETE", "OPTIONS"]) {
      const res = await mcpApi.fetch(new Request(`${GW}/mcp`, { method, headers: { Accept: "text/event-stream" } }), gw, { props: principal(BOTH) } as unknown as ExecutionContext);
      expect(res.status, method).toBe(405);
      expect(res.headers.get("Allow"), method).toBe("POST");
    }
  });

  it("rejects a JSON-RPC batch of 2026-07-28 requests with 400", async () => {
    const r = await post([{ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta() } }], { "MCP-Protocol-Version": MODERN, "Mcp-Method": "tools/list" });
    expect(r.status).toBe(400);
  });

  it("refuses an Origin that is not allowed with 403, and serves a request without one", async () => {
    const refused = await modern("tools/list", {}, { headers: { Origin: "https://evil.example" } });
    expect(refused.status).toBe(403);
    expect((await modern("tools/list")).status).toBe(200);
  });

  it("ignores Mcp-Session-Id and Last-Event-ID, and never mints or echoes a session id", async () => {
    const r = await modern("tools/list", {}, { headers: { "Mcp-Session-Id": "abc", "Last-Event-ID": "7" } });
    expect(r.status).toBe(200);
    expect(r.headers.get("Mcp-Session-Id")).toBeNull();
    expect(r.text).not.toContain("abc");
  });
});

describe("clients of 2025-11-25 and earlier are still served (basic/versioning#backward-compatibility-with-initialization-based-versions)", () => {
  const legacy = (method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = { "MCP-Protocol-Version": LEGACY }, scopes: readonly string[] = BOTH) =>
    post({ jsonrpc: "2.0", id: 1, method, params }, headers, scopes);

  it("answers initialize with the version the client asked for and the tools capability", async () => {
    for (const version of [LEGACY, "2025-06-18", "2025-03-26"]) {
      const r = await legacy("initialize", { protocolVersion: version, capabilities: {}, clientInfo: { name: "old", version: "1" } }, { "MCP-Protocol-Version": version });
      expect(r.status, version).toBe(200);
      expect(r.json!["result"].protocolVersion, version).toBe(version);
      expect(r.json!["result"].capabilities.tools, version).toBeDefined();
      expect(r.json!["result"].serverInfo.name, version).toBe("feedbackkit");
    }
  });

  it("serves tools/list without _meta, with the same tools in the same order as a modern client sees, and the scope filter", async () => {
    const old = await legacy("tools/list");
    expect(old.status).toBe(200);
    expect(toolNames(old)).toEqual(toolNames(await modern("tools/list")));
    expect(toolNames(await legacy("tools/list", {}, { "MCP-Protocol-Version": LEGACY }, ["feedback:read"]))).toEqual(declared(["feedback:read"]));
  });

  it("serves tools/call, with and without the protocol version header, and refuses a tool outside the grant", async () => {
    const withHeader = await legacy("tools/call", { name: "whoami", arguments: {} });
    expect(withHeader.status).toBe(200);
    expect(withHeader.json!["result"].structuredContent.email).toBe("dana@example.com");
    expect((await legacy("tools/call", { name: "whoami", arguments: {} }, {})).status).toBe(200);
    const outside = await legacy("tools/call", { name: "get_config", arguments: { project: "demo" } }, { "MCP-Protocol-Version": LEGACY }, ["feedback:read"]);
    expect(outside.json!["error"].code).toBe(-32602);
  });

  it("mints no session: no Mcp-Session-Id on the answer to initialize", async () => {
    const r = await legacy("initialize", { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: "old", version: "1" } });
    expect(r.headers.get("Mcp-Session-Id")).toBeNull();
  });
});

describe("subscriptions/listen (basic/patterns/subscriptions)", () => {
  it("acknowledges an opted-in subscription on a stream and tags it with its subscription id", async () => {
    const ac = new AbortController();
    const request = new Request(`${GW}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": MODERN, "Mcp-Method": "subscriptions/listen" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "subscriptions/listen", params: { _meta: meta(), notifications: { toolsListChanged: true } } }),
      signal: ac.signal,
    });
    const res = await mcpApi.fetch(request, gw, { waitUntil() {}, passThroughOnException() {}, props: principal(BOTH) } as unknown as ExecutionContext);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    const event = JSON.parse(first.split("\n").find((l) => l.startsWith("data:"))!.slice(5));
    expect(event.method).toBe("notifications/subscriptions/acknowledged");
    expect(event.params._meta["io.modelcontextprotocol/subscriptionId"]).toBe(7);
    await reader.cancel();
    ac.abort();
  });
});

describe("known limits of MCP SDK 2.0.0 and Agents SDK 0.27 (each is a spec point this gateway cannot fix from outside)", () => {
  it("discover and the unsupported-version error list only 2026-07-28, although clients of 2025-11-25 are served by the Agents SDK's own legacy handler", async () => {
    // The spec's examples list both versions for a server that serves both eras. createMcpHandler builds the SDK handler with
    // legacy "reject" and serves legacy traffic beside it, and the SDK's supportedProtocolVersions option does not reach
    // discover. A client that reads supportedVersions learns about the modern era only, which is harmless: it never needs the other.
    const discover = (await modern("server/discover")).json!["result"];
    expect(discover.supportedVersions).toEqual([MODERN]);
    const unsupported = await modern("tools/list", {}, { headers: { "MCP-Protocol-Version": LEGACY }, meta: { "io.modelcontextprotocol/protocolVersion": LEGACY } });
    expect(unsupported.json!["error"].code).toBe(-32022);
    expect(unsupported.json!["error"].data.supported).toEqual([MODERN]);
  });

  it("the tools capability says listChanged: true, but the tool set of a request never changes, so no notification follows the acknowledgement", async () => {
    expect((await modern("server/discover")).json!["result"].capabilities.tools).toEqual({ listChanged: true });
  });

  it("an Origin that is not localhost is refused with the legacy-range code -32000, which the 2026-07-28 error policy discourages", async () => {
    const refused = await modern("tools/list", {}, { headers: { Origin: "https://evil.example" } });
    expect(refused.status).toBe(403);
    expect(refused.json!["error"].code).toBe(-32000);
  });

  it("an invalid pagination cursor is ignored: tools/list has one page, so any cursor returns it instead of -32602", async () => {
    const r = await modern("tools/list", { cursor: "not-a-cursor" });
    expect(r.status).toBe(200);
    expect(toolNames(r)).toEqual(declared(BOTH));
  });
});
