// MCP tools (ADR-015, src/worker/mcp/*): scope enforcement, pagination, search
// with LIKE escaping, the allowlisted feedback detail (no IPs, no Turnstile
// token), rate limiting. Calls go through the real /mcp handler with the props
// the OAuth provider would put on ctx; D1 is an in-memory fake.
import { describe, it, expect } from "vitest";
import { mcpApi, MCP_CALLS_PER_HOUR } from "../src/worker/mcp/server.js";
import { escapeLike } from "../src/worker/admin/queries.js";
import { hourWindow } from "../src/worker/security/ratelimit.js";
import type { AuthProps } from "../src/worker/mcp/scopes.js";
import { fakeD1 } from "./helpers.js";
import type { Env } from "../src/worker/env.js";

const DAY = 86_400_000;
const clientId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const demoConfig = {
  projectId: "demo",
  templates: [{ type: "bug", label: "Bug", fields: [{ key: "repro", label: "Steps", kind: "longtext", required: true }] }],
  llm: { provider: "openrouter", model: "google/gemini-2.5-flash-lite", dailyBudget: 150 },
  tracker: { kind: "github", defaultRepo: "acme/site", patSecret: "GITHUB_PAT_default" },
  auth: { origins: ["https://acme.dev"] },
  storage: { kind: "r2", publicBaseUrl: "https://cdn.example/" },
};

interface Row {
  id: string;
  project_id: string;
  outcome: string;
  payload: string;
  issue_url: string | null;
  created_at: number;
  type: string | null;
  title: string | null;
  llm_model: string | null;
  issue_draft: string | null;
}

function store() {
  const now = Date.now();
  const projects = new Map([
    ["demo", { id: "demo", public_key: "fk_pub_demo0001", config: JSON.stringify(demoConfig), config_version: 3, updated_at: now - DAY }],
    ["other", { id: "other", public_key: "fk_pub_other001", config: JSON.stringify({ ...demoConfig, projectId: "other" }), config_version: 1, updated_at: now }],
  ]);
  const feedback: Row[] = [];
  const events: Array<{ project_id: string; name: string; ts: number }> = [];
  const assets: Array<{ key: string; project_id: string; feedback_id: string; kind: string; deleted: number; created_at: number }> = [];
  const counters = new Map<string, { window_start: number; count: number }>();
  const likeParams: unknown[] = [];
  return { now, projects, feedback, events, assets, counters, likeParams };
}
type Store = ReturnType<typeof store>;

function add(s: Store, n: number, over: Partial<Row> = {}, payloadOver: Record<string, unknown> = {}) {
  s.feedback.push({
    id: `srv-${String(n).padStart(3, "0")}`,
    project_id: "demo",
    outcome: "created",
    payload: JSON.stringify({
      v: 1,
      feedbackId: clientId(n),
      type: "bug",
      message: `message ${n}`,
      pageUrl: "https://acme.dev/page",
      summary: `summary ${n}`,
      extracted: { repro: `steps ${n}` },
      followUpText: `answer ${n}`,
      deviceInfo: { browser: "Firefox 140", os: "Linux", viewport: { w: 1280, h: 800 }, language: "de-DE" },
      context: { appVersion: "4.2.0", plan: "pro" },
      attachmentKeys: [],
      consoleErrors: [],
      turnstileToken: "XXXX.turnstile-secret-token",
      ...payloadOver,
    }),
    issue_url: `https://github.com/acme/site/issues/${n}`,
    created_at: s.now - n * 60_000,
    type: "bug",
    title: `[BUG] summary ${n}`,
    llm_model: "google/gemini-2.5-flash-lite",
    issue_draft: null,
    ...over,
  });
}

// SQLite LIKE with ESCAPE '\', case-insensitive for ASCII.
function like(value: string | null, pattern: string): boolean {
  if (value === null) return false;
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "\\" && i + 1 < pattern.length) re += pattern[++i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    else if (ch === "%") re += "[\\s\\S]*";
    else if (ch === "_") re += "[\\s\\S]";
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i").test(value);
}

const tally = <T>(rows: T[], key: (r: T) => string) => {
  const m = new Map<string, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
  return m;
};

function handler(s: Store) {
  return (sql: string, params: unknown[]): unknown => {
    if (sql.includes("INSERT INTO counters")) {
      const [key, win] = params as [string, number];
      const cur = s.counters.get(key);
      const count = cur && cur.window_start === win ? cur.count + 1 : 1;
      s.counters.set(key, { window_start: win, count });
      return { count };
    }
    if (sql.includes("FROM projects WHERE id = ?1")) return s.projects.get(params[0] as string) ?? null;
    if (sql.includes("FROM projects ORDER BY id")) return [...s.projects.values()];
    if (sql.includes("FROM feedback WHERE created_at >= ?1 GROUP BY project_id, outcome")) {
      const rows = s.feedback.filter((f) => f.created_at >= (params[0] as number));
      return [...tally(rows, (f) => `${f.project_id}|${f.outcome}`)].map(([k, n]) => ({ project_id: k.split("|")[0], outcome: k.split("|")[1], n }));
    }
    if (sql.includes("FROM feedback WHERE project_id = ?1 AND created_at >= ?2 GROUP BY outcome")) {
      const rows = s.feedback.filter((f) => f.project_id === params[0] && f.created_at >= (params[1] as number));
      return [...tally(rows, (f) => f.outcome)].map(([k, n]) => ({ k, n }));
    }
    if (sql.includes("FROM events WHERE project_id = ?1 AND ts >= ?2 GROUP BY name")) {
      const rows = s.events.filter((e) => e.project_id === params[0] && e.ts >= (params[1] as number));
      return [...tally(rows, (e) => e.name)].map(([k, n]) => ({ k, n }));
    }
    if (sql.includes("FROM feedback WHERE id = ?1")) return s.feedback.find((f) => f.id === params[0]) ?? null;
    if (sql.includes("json_extract(payload, '$.message') LIKE ?1 ESCAPE '\\'")) {
      const [pattern, ...rest] = params as [string, ...unknown[]];
      s.likeParams.push(pattern);
      const project = sql.includes("project_id = ?2") ? (rest.shift() as string) : undefined;
      const limit = rest.shift() as number;
      return s.feedback
        .filter((f) => project === undefined || f.project_id === project)
        .filter((f) => {
          const pl = JSON.parse(f.payload) as { message?: string; summary?: string };
          return like(pl.message ?? null, pattern) || like(pl.summary ?? null, pattern) || like(f.title, pattern);
        })
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, limit);
    }
    if (sql.includes("FROM feedback WHERE project_id = ?")) {
      const q = [...params];
      const project = q.shift();
      const outcome = sql.includes("outcome = ?") ? q.shift() : undefined;
      const since = sql.includes("created_at >= ?") ? (q.shift() as number) : undefined;
      const cursor = sql.includes("(created_at, id) < (?, ?)") ? ([q.shift(), q.shift()] as [number, string]) : null;
      const limit = q.shift() as number;
      return s.feedback
        .filter((f) => f.project_id === project && (outcome === undefined || f.outcome === outcome))
        .filter((f) => since === undefined || f.created_at >= since)
        .filter((f) => !cursor || f.created_at < cursor[0] || (f.created_at === cursor[0] && f.id < cursor[1]))
        .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1))
        .slice(0, limit)
        .map((f) => ({ ...f, has_draft: f.issue_draft !== null ? 1 : 0 }));
    }
    if (sql.includes("FROM assets WHERE project_id = ?")) {
      const [project, ...ids] = params as string[];
      return s.assets.filter((a) => a.project_id === project && a.deleted === 0 && ids.includes(a.feedback_id));
    }
    return null;
  };
}

const envOf = (s: Store) => ({ DB: fakeD1(handler(s)), FK_ENV: "test", WIDGET_VERSION: "t", ADMIN_TOKEN: "adm1n" }) as unknown as Env;

const ALL: AuthProps["scopes"] = ["feedback:read", "config:read"];
const propsOf = (scopes: AuthProps["scopes"]): AuthProps => ({ email: "dana@example.com", sub: "sub-1", clientId: "client-1", clientName: "Test Agent", scopes });
const ctxOf = (props: unknown) => ({ props, waitUntil() {}, passThroughOnException() {} }) as unknown as ExecutionContext;

async function post(e: Env, props: unknown, body: unknown, method = "POST"): Promise<Response> {
  return mcpApi.fetch(
    new Request("https://gw.test/mcp", {
      method,
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    }),
    e,
    ctxOf(props),
  );
}

/** The JSON-RPC message of a response, whether sent as JSON or as one SSE event. */
async function message(res: Response): Promise<{ result?: Record<string, unknown>; error?: { code: number; message: string } }> {
  const text = await res.text();
  const data = text.trimStart().startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data: "))?.slice(6) ?? "{}";
  return JSON.parse(data);
}

async function listTools(e: Env, scopes: AuthProps["scopes"]): Promise<string[]> {
  const m = await message(await post(e, propsOf(scopes), { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
  return (m.result!["tools"] as Array<{ name: string }>).map((t) => t.name);
}

type ToolOut = { isError?: boolean; structuredContent?: Record<string, unknown>; content: Array<{ text: string }> };
async function call(e: Env, name: string, args: Record<string, unknown> = {}, scopes = ALL): Promise<ToolOut & { rpcError?: string }> {
  const m = await message(await post(e, propsOf(scopes), { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }));
  if (m.error) return { rpcError: m.error.message, content: [] };
  return m.result as unknown as ToolOut;
}

describe("MCP tools: scopes", () => {
  it("lists only the tools the grant's scopes allow", async () => {
    const e = envOf(store());
    const read = await listTools(e, ["feedback:read"]);
    expect(read).toEqual(["whoami", "list_projects", "list_feedback", "get_feedback", "search_feedback", "get_funnel", "search", "fetch"]);
    expect(await listTools(e, ["config:read"])).toEqual(["whoami", "get_config"]);
    expect(await listTools(e, ALL)).toContain("get_config");
    expect(await listTools(e, [])).toEqual(["whoami"]);
  });

  it("refuses a tool outside the grant", async () => {
    const e = envOf(store());
    expect((await call(e, "get_config", { project: "demo" }, ["feedback:read"])).rpcError).toMatch(/not found/i);
    expect((await call(e, "list_feedback", { project: "demo" }, ["config:read"])).rpcError).toMatch(/not found/i);
  });

  it("drops scopes it does not know from the props", async () => {
    const e = envOf(store());
    const m = await message(await post(e, { ...propsOf(["feedback:read"]), scopes: ["feedback:read", "admin:write"] }, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: {} } }));
    expect((m.result!["structuredContent"] as { scopes: string[] }).scopes).toEqual(["feedback:read"]);
  });

  it("whoami reports the grant", async () => {
    const r = await call(envOf(store()), "whoami");
    expect(r.structuredContent).toMatchObject({ email: "dana@example.com", clientName: "Test Agent", scopes: ALL, gateway: "https://gw.test" });
  });

  it("says in every content tool's description that feedback is untrusted", async () => {
    const m = await message(await post(envOf(store()), propsOf(ALL), { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
    const tools = m.result!["tools"] as Array<{ name: string; description: string }>;
    for (const name of ["list_feedback", "get_feedback", "search_feedback", "search", "fetch"]) {
      expect(tools.find((t) => t.name === name)!.description, name).toMatch(/untrusted/);
    }
  });
});

describe("MCP tools: reads", () => {
  it("list_projects returns the projects with 7-day counts", async () => {
    const s = store();
    add(s, 1);
    add(s, 2, { outcome: "issue_failed" });
    const r = await call(envOf(s), "list_projects");
    const projects = r.structuredContent!["projects"] as Array<{ id: string; feedback7d: { total: number; byOutcome: Record<string, number> } }>;
    expect(projects.map((p) => p.id)).toEqual(["demo", "other"]);
    expect(projects[0]!.feedback7d).toMatchObject({ total: 2, byOutcome: { created: 1, issue_failed: 1 } });
  });

  it("list_feedback pages with nextCursor and filters by since and outcome", async () => {
    const s = store();
    for (let n = 1; n <= 25; n++) add(s, n, n % 5 === 0 ? { outcome: "issue_failed" } : {});
    const e = envOf(s);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const r = await call(e, "list_feedback", { project: "demo", limit: 10, ...(cursor ? { cursor } : {}) });
      const sc = r.structuredContent as { items: Array<{ id: string }>; nextCursor: string | null };
      seen.push(...sc.items.map((i) => i.id));
      cursor = sc.nextCursor ?? undefined;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect(seen[0]).toBe("srv-001");

    const since = new Date(s.now - 3.5 * 60_000).toISOString();
    const recent = await call(e, "list_feedback", { project: "demo", since });
    expect((recent.structuredContent!["items"] as Array<{ id: string }>).map((i) => i.id)).toEqual(["srv-001", "srv-002", "srv-003"]);

    const failed = await call(e, "list_feedback", { project: "demo", outcome: "issue_failed" });
    expect((failed.structuredContent!["items"] as unknown[]).length).toBe(5);
  });

  it("list_feedback answers bad input with isError, not an exception", async () => {
    const e = envOf(store());
    expect(await call(e, "list_feedback", { project: "nope" })).toMatchObject({ isError: true, structuredContent: { error: { code: "not_found" } } });
    expect(await call(e, "list_feedback", { project: "demo", cursor: "garbage" })).toMatchObject({ isError: true, structuredContent: { error: { code: "invalid_input" } } });
    expect(await call(e, "list_feedback", { project: "demo", since: "yesterday-ish" })).toMatchObject({ isError: true });
    expect((await call(e, "list_feedback", { project: "demo", limit: 500 })).isError).toBe(true);
  });

  it("get_feedback returns the allowlisted fields and never an IP or the Turnstile token", async () => {
    const s = store();
    add(s, 7, {}, { ip: "203.0.113.50", cfConnectingIp: "203.0.113.51", hpField: "" });
    s.assets.push({ key: "demo/2026/shot.png", project_id: "demo", feedback_id: clientId(7), kind: "screenshot", deleted: 0, created_at: s.now });
    const r = await call(envOf(s), "get_feedback", { id: "srv-007" });
    expect(r.isError).toBeFalsy();
    const fb = r.structuredContent!;
    expect(fb).toMatchObject({
      id: "srv-007",
      projectId: "demo",
      message: "message 7",
      followUpText: "answer 7",
      summary: "summary 7",
      extracted: { repro: "steps 7" },
      type: "bug",
      outcome: "created",
      issueUrl: "https://github.com/acme/site/issues/7",
      llmModel: "google/gemini-2.5-flash-lite",
      pageUrl: "https://acme.dev/page",
      device: { browser: "Firefox 140", os: "Linux", viewport: { w: 1280, h: 800 }, language: "de-DE" },
      attachments: [{ kind: "screenshot", url: "https://cdn.example/demo/2026/shot.png" }],
      hostContext: { verified: false, values: { appVersion: "4.2.0", plan: "pro" } },
    });
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/203\.0\.113/);
    expect(text).not.toContain("turnstile");
    expect(Object.keys(fb)).not.toContain("hpField");
  });

  it("get_feedback says not_found for an unknown id", async () => {
    expect(await call(envOf(store()), "get_feedback", { id: "srv-999" })).toMatchObject({ isError: true, structuredContent: { error: { code: "not_found" } } });
  });

  it("get_funnel counts events and outcomes in the window", async () => {
    const s = store();
    add(s, 1);
    s.events.push({ project_id: "demo", name: "opened", ts: s.now - DAY }, { project_id: "demo", name: "opened", ts: s.now - 40 * DAY });
    const r = await call(envOf(s), "get_funnel", { project: "demo", days: 30 });
    expect(r.structuredContent).toMatchObject({ projectId: "demo", days: 30, events: { opened: 1, typed: 0 }, feedback: { total: 1 } });
    expect((await call(envOf(s), "get_funnel", { project: "demo", days: 91 })).isError).toBe(true);
  });

  it("get_config returns the stored config with the public key", async () => {
    const r = await call(envOf(store()), "get_config", { project: "demo" });
    expect(r.structuredContent).toMatchObject({ publicKey: "fk_pub_demo0001", configVersion: 3, projectId: "demo", tracker: { patSecret: "GITHUB_PAT_default" } });
  });
});

describe("MCP tools: search", () => {
  it("escapes LIKE wildcards", () => {
    expect(escapeLike("100%_\\x")).toBe("100\\%\\_\\\\x");
  });

  it("matches % and _ literally", async () => {
    const s = store();
    add(s, 1, {}, { message: "Checkout fails at 100% zoom" });
    add(s, 2, {}, { message: "Checkout fails at 1000 items" });
    add(s, 3, {}, { message: "field a_b is empty" });
    add(s, 4, {}, { message: "field axb is empty" });
    const e = envOf(s);
    const pct = await call(e, "search_feedback", { query: "100%" });
    expect((pct.structuredContent!["hits"] as Array<{ id: string }>).map((h) => h.id)).toEqual(["srv-001"]);
    const under = await call(e, "search_feedback", { query: "a_b" });
    expect((under.structuredContent!["hits"] as Array<{ id: string }>).map((h) => h.id)).toEqual(["srv-003"]);
    expect(s.likeParams).toEqual(["%100\\%%", "%a\\_b%"]);
  });

  it("searches message, summary and title, in one project or all", async () => {
    const s = store();
    add(s, 1, { title: "[BUG] Login button" });
    add(s, 2, { project_id: "other" }, { summary: "login loops" });
    add(s, 3, {}, { message: "LOGIN page is slow" });
    const e = envOf(s);
    const all = await call(e, "search_feedback", { query: "login" });
    expect((all.structuredContent!["hits"] as Array<{ id: string }>).map((h) => h.id)).toEqual(["srv-001", "srv-002", "srv-003"]);
    const demo = await call(e, "search_feedback", { query: "login", project: "demo" });
    expect((demo.structuredContent!["hits"] as Array<{ id: string }>).map((h) => h.id)).toEqual(["srv-001", "srv-003"]);
  });

  it("caps the query length", async () => {
    const r = await call(envOf(store()), "search_feedback", { query: "x".repeat(201) });
    expect(r.isError).toBe(true);
  });

  it("search and fetch speak the ChatGPT connector shape", async () => {
    const s = store();
    add(s, 1, { title: "[BUG] Login button" });
    add(s, 2, { issue_url: null }, { message: "login loops" });
    const e = envOf(s);
    const r = await call(e, "search", { query: "login" });
    expect(r.structuredContent).toEqual({
      results: [
        { id: "srv-001", title: "[BUG] Login button", url: "https://github.com/acme/site/issues/1" },
        { id: "srv-002", title: "[BUG] summary 2", url: "https://gw.test/admin/projects/demo" },
      ],
    });
    const f = await call(e, "fetch", { id: "srv-001" });
    expect(f.structuredContent).toMatchObject({ id: "srv-001", title: "[BUG] Login button", url: "https://github.com/acme/site/issues/1", metadata: { projectId: "demo", untrusted: true } });
    expect(String(f.structuredContent!["text"])).toContain("Message:\nmessage 1");
    expect(String(f.structuredContent!["text"])).toContain("- repro: steps 1");
  });
});

describe("MCP endpoint guards", () => {
  it("401s a token without FeedbackKit props", async () => {
    const res = await post(envOf(store()), undefined, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(401);
    expect((await post(envOf(store()), { userId: "x" }, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
  });

  it("answers GET with 405", async () => {
    expect((await post(envOf(store()), propsOf(ALL), null, "GET")).status).toBe(405);
  });

  it("rate-limits per grant and hour", async () => {
    const s = store();
    const e = envOf(s);
    expect((await post(e, propsOf(ALL), { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(200);
    const [key] = [...s.counters.keys()];
    expect(key).toMatch(/^mcp:[0-9a-f]{32}$/); // hashed: no email in D1
    s.counters.set(key!, { window_start: hourWindow(), count: MCP_CALLS_PER_HOUR });
    const res = await post(e, propsOf(ALL), { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    // another client of the same person has its own budget
    const other = await post(e, { ...propsOf(ALL), clientId: "client-2" }, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(other.status).toBe(200);
  });
});
