// P2 step 1: read-only admin API (src/worker/admin/routes.ts) — auth and the
// failed-auth limit, project list, config export, feedback history, funnel and
// the system view. D1 is an in-memory fake that answers the routes' queries.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { app } from "../src/worker/app.js";
import { FeedbackConfig } from "../src/shared/contract.js";
import { dayWindow } from "../src/worker/security/ratelimit.js";
import { parsePatExpiry } from "../src/worker/admin/routes.js";
import { fakeD1 } from "./helpers.js";
import { resetAccessCache } from "../src/worker/admin/access.js";
import { AUD, TEAM, makeKey, claims, signJwt, jwksFetch, type TestKey } from "./access-helpers.js";
import type { Env } from "../src/worker/env.js";

const TOKEN = "adm1n-s3cret-token";
const PAT = "github_pat_SECRETVALUE";
const CLIENT_IP = "203.0.113.9";
const DAY = 86_400_000;

const demoConfig = {
  projectId: "demo",
  templates: [{ type: "bug", label: "Bug", fields: [{ key: "repro", label: "Steps", kind: "longtext", required: true }] }],
  llm: { provider: "openrouter", model: "google/gemini-2.5-flash-lite", dailyBudget: 150 },
  tracker: { kind: "github", defaultRepo: "acme/site", patSecret: "GITHUB_PAT_default" },
  auth: { origins: ["https://acme.dev"] },
  storage: { kind: "r2", publicBaseUrl: "https://cdn.example/" },
};
const otherConfig = { ...demoConfig, projectId: "other", tracker: { kind: "github", defaultRepo: "acme/other", patSecret: "GITHUB_PAT_missing" } };

interface FeedbackRec {
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
  const projects = new Map<string, { id: string; public_key: string; config: string; config_version: number; updated_at: number }>();
  projects.set("demo", { id: "demo", public_key: "fk_pub_demo0001", config: JSON.stringify(demoConfig), config_version: 3, updated_at: now - DAY });
  projects.set("other", { id: "other", public_key: "fk_pub_other001", config: JSON.stringify(otherConfig), config_version: 1, updated_at: now - 2 * DAY });
  projects.set("broken", { id: "broken", public_key: "fk_pub_broken01", config: "{not json", config_version: 1, updated_at: now });
  const feedback: FeedbackRec[] = [];
  const events: Array<{ project_id: string; name: string; ts: number }> = [];
  const assets: Array<{ key: string; project_id: string; feedback_id: string; kind: string; deleted: number; created_at: number }> = [];
  const counters = new Map<string, { window_start: number; count: number }>();
  return { now, projects, feedback, events, assets, counters };
}
type Store = ReturnType<typeof store>;

const clientId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function addFeedback(s: Store, n: number, over: Partial<FeedbackRec> = {}, payloadOver: Record<string, unknown> = {}) {
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
      deviceInfo: { browser: "Firefox 140", os: "Linux" },
      context: { clientIp: "198.51.100.7" },
      attachmentKeys: [],
      consoleErrors: [],
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

const tally = <T>(rows: T[], key: (r: T) => string) => {
  const m = new Map<string, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
  return m;
};

// Answers exactly the statements the admin routes, the auth gate and the config
// import issue; anything else reads as "no row".
function handler(s: Store) {
  return (sql: string, params: unknown[]): unknown => {
    if (sql.includes("INSERT INTO counters")) {
      const [key, win] = params as [string, number];
      const cur = s.counters.get(key);
      const count = cur && cur.window_start === win ? cur.count + 1 : 1;
      s.counters.set(key, { window_start: win, count });
      return { count };
    }
    if (sql.includes("FROM counters WHERE key = ?1")) return s.counters.get(params[0] as string) ?? null;
    if (sql.includes("FROM counters WHERE key LIKE 'llm:%'")) {
      return [...s.counters].filter(([k, v]) => k.startsWith("llm:") && v.window_start === params[0]).map(([key, v]) => ({ key, count: v.count }));
    }
    if (sql.includes("FROM meta")) return { value: "2" };
    if (sql.startsWith("INSERT INTO projects")) {
      const [id, publicKey, config, updatedAt] = params as [string, string, string, number];
      const cur = s.projects.get(id);
      s.projects.set(id, cur ? { ...cur, config, config_version: cur.config_version + 1, updated_at: updatedAt } : { id, public_key: publicKey, config, config_version: 1, updated_at: updatedAt });
      return null;
    }
    if (sql.includes("FROM projects WHERE id = ?1")) return s.projects.get(params[0] as string) ?? null;
    if (sql.includes("FROM projects ORDER BY id")) return [...s.projects.values()].sort((a, b) => a.id.localeCompare(b.id));
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
    if (sql.includes("FROM feedback WHERE project_id = ?")) {
      const q = [...params];
      const project = q.shift();
      const outcome = sql.includes("outcome = ?") ? q.shift() : undefined;
      const cursor = sql.includes("(created_at, id) < (?, ?)") ? ([q.shift(), q.shift()] as [number, string]) : null;
      const limit = q.shift() as number;
      return s.feedback
        .filter((f) => f.project_id === project && (outcome === undefined || f.outcome === outcome))
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

function env(s: Store, extra: Record<string, unknown> = {}): Env {
  return {
    DB: fakeD1(handler(s)),
    UPLOADS: { get: async () => null } as unknown as R2Bucket,
    ASSETS: { fetch: async () => new Response("") } as unknown as Fetcher,
    FK_ENV: "test",
    WIDGET_VERSION: "testver",
    FK_RELEASE: "0.2.0-dev.1",
    FK_CHANNEL: "dev",
    ADMIN_TOKEN: TOKEN,
    GITHUB_PAT_default: PAT,
    LLM_API_KEY: "sk-llm-SECRET",
    ...extra,
  } as unknown as Env;
}

const req = (token: string | null = TOKEN, ip = CLIENT_IP, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { "CF-Connecting-IP": ip, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers as Record<string, string> | undefined) },
});

async function getJson<T>(e: Env, path: string, token: string | null = TOKEN, ip = CLIENT_IP): Promise<{ status: number; body: T; text: string; res: Response }> {
  const res = await app.request(path, req(token, ip), e);
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T, text, res };
}

const ADMIN_PATHS = [
  "/api/admin/projects",
  "/api/admin/projects/demo/config",
  "/api/admin/projects/demo/feedback",
  "/api/admin/projects/demo/funnel",
  "/api/admin/system",
];

describe("admin API — auth", () => {
  it("401s every route without a token and with a wrong one", async () => {
    const s = store();
    for (const path of ADMIN_PATHS) {
      expect((await getJson(env(s), path, null)).status, path).toBe(401);
      expect((await getJson(env(s), path, "wrong-token")).status, path).toBe(401);
    }
  });

  it("401s when the instance has no ADMIN_TOKEN at all", async () => {
    const s = store();
    expect((await getJson(env(s, { ADMIN_TOKEN: undefined }), "/api/admin/projects", "")).status).toBe(401);
  });

  it("answers 429 after 20 failed attempts per IP and hour, even with the right token", async () => {
    const s = store();
    const e = env(s);
    for (let i = 0; i < 20; i++) expect((await getJson(e, "/api/admin/projects", "guess-" + i)).status).toBe(401);
    expect((await getJson(e, "/api/admin/projects", "guess-20")).status).toBe(429);
    // Locked: a correct token from the same client no longer gets an answer…
    expect((await getJson(e, "/api/admin/projects")).status).toBe(429);
    // …another client is unaffected.
    expect((await getJson(e, "/api/admin/projects", TOKEN, "192.0.2.44")).status).toBe(200);
    // The counter key holds a hashed IP, never the address.
    expect([...s.counters.keys()].some((k) => k.includes(CLIENT_IP))).toBe(false);
  });

  it("successful requests are not counted against the limit", async () => {
    const s = store();
    const e = env(s);
    for (let i = 0; i < 25; i++) expect((await getJson(e, "/api/admin/projects")).status).toBe(200);
  });

  it("the existing admin routes share the same gate", async () => {
    const s = store();
    const e = env(s);
    for (let i = 0; i < 20; i++) {
      const r = await app.request("/api/admin/config/import", req("nope", CLIENT_IP, { method: "POST", body: "{}" }), e);
      expect(r.status).toBe(401);
    }
    const del = await app.request(`/api/admin/assets?feedbackId=${clientId(1)}`, req(TOKEN, CLIENT_IP, { method: "DELETE" }), e);
    expect(del.status).toBe(429);
  });

  it("marks admin responses as not cacheable", async () => {
    const s = store();
    const { res } = await getJson(env(s), "/api/admin/projects");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("unknown admin paths still answer 501", async () => {
    const s = store();
    expect((await getJson(env(s), "/api/admin/nope")).status).toBe(501);
  });
});

describe("GET /api/admin/projects", () => {
  it("lists projects with 7-day feedback counts by outcome", async () => {
    const s = store();
    addFeedback(s, 1);
    addFeedback(s, 2, { outcome: "issue_failed", issue_url: null });
    addFeedback(s, 3, { outcome: "accepted_incomplete" });
    addFeedback(s, 4, { created_at: s.now - 8 * DAY }); // outside the window
    addFeedback(s, 5, { project_id: "other" });
    const { status, body } = await getJson<{ projects: Array<Record<string, unknown>> }>(env(s), "/api/admin/projects");
    expect(status).toBe(200);
    expect(body.projects.map((p) => p["id"])).toEqual(["broken", "demo", "other"]);
    const demo = body.projects.find((p) => p["id"] === "demo")!;
    expect(demo).toEqual({
      id: "demo",
      publicKey: "fk_pub_demo0001",
      configVersion: 3,
      updatedAt: s.now - DAY,
      feedback7d: { total: 3, byOutcome: { created: 1, accepted_incomplete: 1, "ai-failed": 0, issue_failed: 1 } },
    });
    expect(body.projects.find((p) => p["id"] === "other")!["feedback7d"]).toMatchObject({ total: 1 });
  });
});

describe("GET /api/admin/projects/:id/config", () => {
  it("exports the stored config with publicKey and configVersion", async () => {
    const s = store();
    const { status, body } = await getJson<Record<string, unknown>>(env(s), "/api/admin/projects/demo/config");
    expect(status).toBe(200);
    expect(body).toEqual({ publicKey: "fk_pub_demo0001", configVersion: 3, ...demoConfig });
    expect(FeedbackConfig.safeParse(body).success).toBe(true);
  });

  it("round-trips through POST /api/admin/config/import unchanged", async () => {
    const s = store();
    const e = env(s);
    const exported = (await getJson<Record<string, unknown>>(e, "/api/admin/projects/demo/config")).body;
    const res = await app.request(
      "https://fk.example.com/api/admin/config/import",
      req(TOKEN, CLIENT_IP, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(exported) }),
      e,
    );
    expect(res.status).toBe(200);
    const imported = (await res.json()) as { publicKey: string; configVersion: number };
    expect(imported).toMatchObject({ publicKey: "fk_pub_demo0001", configVersion: 4 });
    // Neither publicKey nor configVersion lands in the stored blob.
    expect(JSON.parse(s.projects.get("demo")!.config)).toEqual(demoConfig);
  });

  it("404s an unknown project and 500s a broken stored blob", async () => {
    const s = store();
    expect((await getJson(env(s), "/api/admin/projects/nope/config")).status).toBe(404);
    expect((await getJson(env(s), "/api/admin/projects/broken/config")).status).toBe(500);
  });
});

describe("GET /api/admin/projects/:id/feedback", () => {
  type Item = Record<string, unknown> & { id: string; attachments: Array<{ key: string; kind: string; url: string | null }> };
  type Page = { items: Item[]; nextCursor: string | null };

  it("returns the newest 25 by default with all item fields", async () => {
    const s = store();
    for (let n = 1; n <= 30; n++) addFeedback(s, n);
    s.assets.push({ key: "demo/shot.webp", project_id: "demo", feedback_id: clientId(1), kind: "screenshot", deleted: 0, created_at: s.now });
    s.assets.push({ key: "demo/gone.webp", project_id: "demo", feedback_id: clientId(1), kind: "upload", deleted: 1, created_at: s.now });
    const { status, body } = await getJson<Page>(env(s), "/api/admin/projects/demo/feedback");
    expect(status).toBe(200);
    expect(body.items).toHaveLength(25);
    expect(body.nextCursor).toBeTypeOf("string");
    expect(body.items[0]).toEqual({
      id: "srv-001",
      clientFeedbackId: clientId(1),
      createdAt: s.now - 60_000,
      outcome: "created",
      type: "bug",
      title: "[BUG] summary 1",
      summary: "summary 1",
      message: "message 1",
      pageUrl: "https://acme.dev/page",
      issueUrl: "https://github.com/acme/site/issues/1",
      llmModel: "google/gemini-2.5-flash-lite",
      attachments: [{ key: "demo/shot.webp", kind: "screenshot", url: "https://cdn.example/demo/shot.webp" }],
      retryable: false,
    });
  });

  it("pages through every row exactly once with the keyset cursor (ties on created_at included)", async () => {
    const s = store();
    for (let n = 1; n <= 30; n++) addFeedback(s, n, n % 3 === 0 ? { created_at: s.now - 5 * 60_000 } : {});
    addFeedback(s, 99, { project_id: "other" });
    const e = env(s);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q: string = `/api/admin/projects/demo/feedback?limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page: Page = (await getJson<Page>(e, q)).body;
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 20);
    expect(pages).toBe(5);
    expect(seen).toHaveLength(30);
    expect(new Set(seen).size).toBe(30);
    const expected = s.feedback
      .filter((f) => f.project_id === "demo")
      .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1))
      .map((f) => f.id);
    expect(seen).toEqual(expected);
  });

  it("filters by outcome and marks issue_failed rows with a draft as retryable", async () => {
    const s = store();
    addFeedback(s, 1);
    addFeedback(s, 2, { outcome: "issue_failed", issue_url: null, issue_draft: JSON.stringify({ title: "t", body: "b", labels: [], repo: "acme/site" }) });
    addFeedback(s, 3, { outcome: "issue_failed", issue_url: null, type: null, title: null, llm_model: null }); // row from before schema v2
    const { body } = await getJson<Page>(env(s), "/api/admin/projects/demo/feedback?outcome=issue_failed");
    expect(body.items.map((i) => [i.id, i["retryable"]])).toEqual([
      ["srv-002", true],
      ["srv-003", false],
    ]);
    // Legacy rows fall back to the payload's type; title/model stay null.
    expect(body.items[1]).toMatchObject({ type: "bug", title: null, llmModel: null });
    expect(body.nextCursor).toBeNull();
  });

  it("validates limit, cursor and outcome; caps limit at 100", async () => {
    const s = store();
    for (let n = 1; n <= 120; n++) addFeedback(s, n);
    const e = env(s);
    expect((await getJson(e, "/api/admin/projects/demo/feedback?limit=0")).status).toBe(400);
    expect((await getJson(e, "/api/admin/projects/demo/feedback?limit=abc")).status).toBe(400);
    expect((await getJson(e, "/api/admin/projects/demo/feedback?cursor=%%%")).status).toBe(400);
    expect((await getJson(e, "/api/admin/projects/demo/feedback?outcome=DROP%20TABLE")).status).toBe(400);
    expect((await getJson<Page>(e, "/api/admin/projects/demo/feedback?limit=500")).body.items).toHaveLength(100);
    expect((await getJson(e, "/api/admin/projects/nope/feedback")).status).toBe(404);
  });

  it("never returns IPs, host context, device info or secrets", async () => {
    const s = store();
    addFeedback(s, 1);
    const { text } = await getJson(env(s), "/api/admin/projects/demo/feedback");
    for (const needle of [CLIENT_IP, "198.51.100.7", "clientIp", "Firefox", TOKEN, PAT]) expect(text).not.toContain(needle);
  });
});

describe("GET /api/admin/projects/:id/funnel", () => {
  it("counts events by name and feedback by outcome inside the window", async () => {
    const s = store();
    const at = (daysAgo: number) => s.now - daysAgo * DAY;
    s.events.push(
      { project_id: "demo", name: "opened", ts: at(1) },
      { project_id: "demo", name: "opened", ts: at(2) },
      { project_id: "demo", name: "opened", ts: at(20) },
      { project_id: "demo", name: "submitted", ts: at(1) },
      { project_id: "demo", name: "sent_anyway", ts: at(40) }, // outside 30 d
      { project_id: "other", name: "opened", ts: at(1) },
    );
    addFeedback(s, 1);
    addFeedback(s, 2, { outcome: "issue_failed", issue_url: null });
    addFeedback(s, 3, { created_at: at(45) });
    const { status, body } = await getJson<Record<string, unknown>>(env(s), "/api/admin/projects/demo/funnel");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      projectId: "demo",
      days: 30,
      events: { opened: 3, typed: 0, submitted: 1, need_fields: 0, completed: 0, sent_anyway: 0, abandoned: 0 },
      feedback: { total: 2, byOutcome: { created: 1, accepted_incomplete: 0, "ai-failed": 0, issue_failed: 1 } },
    });
    const week = (await getJson<{ events: Record<string, number> }>(env(s), "/api/admin/projects/demo/funnel?days=7")).body;
    expect(week.events["opened"]).toBe(2);
  });

  it("accepts days from 1 to 90 only", async () => {
    const s = store();
    const e = env(s);
    for (const d of ["0", "91", "1.5", "x"]) expect((await getJson(e, `/api/admin/projects/demo/funnel?days=${d}`)).status, d).toBe(400);
    expect((await getJson(e, "/api/admin/projects/demo/funnel?days=90")).status).toBe(200);
    expect((await getJson(e, "/api/admin/projects/nope/funnel")).status).toBe(404);
  });
});

describe("GET /api/admin/system", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200, headers: { "github-authentication-token-expiration": "2099-01-01 00:00:00 UTC" } }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reports release, schema, bindings, secret presence, LLM budget and PAT expiry per project", async () => {
    const s = store();
    s.counters.set("llm:demo", { window_start: dayWindow(), count: 42 });
    s.counters.set("llm:other", { window_start: dayWindow() - 1, count: 99 }); // yesterday
    const { status, body, text } = await getJson<Record<string, unknown> & { projects: Array<Record<string, unknown>> }>(env(s), "/api/admin/system");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      version: "0.2.0-dev.1",
      channel: "dev",
      schema: { ok: true, expected: 2, version: 2 },
      bindings: { DB: true, UPLOADS: true, ASSETS: true },
      secrets: { adminToken: true, githubPat: true, llmKey: true },
    });
    const byId = Object.fromEntries(body.projects.map((p) => [p["id"], p]));
    expect(byId["demo"]).toMatchObject({
      configVersion: 3,
      configValid: true,
      llm: { provider: "openrouter", model: "google/gemini-2.5-flash-lite", usedToday: 42, dailyBudget: 150 },
      tracker: {
        repo: "acme/site",
        patSecret: "GITHUB_PAT_default",
        patPresent: true,
        access: { ok: true, status: 200, reason: null },
        patExpiry: { raw: "2099-01-01 00:00:00 UTC", at: "2099-01-01T00:00:00.000Z" },
      },
    });
    expect(byId["other"]).toMatchObject({ llm: { usedToday: 0 }, tracker: { patPresent: false, access: null, patExpiry: null } });
    expect(byId["broken"]).toEqual({ id: "broken", configVersion: 1, configValid: false });
    for (const needle of [TOKEN, PAT, "sk-llm-SECRET", CLIENT_IP]) expect(text).not.toContain(needle);
  });

  it("tolerates a failing PAT check per project", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const s = store();
    const { status, body } = await getJson<{ projects: Array<Record<string, unknown>> }>(env(s), "/api/admin/system");
    expect(status).toBe(200);
    expect(body.projects.find((p) => p["id"] === "demo")).toMatchObject({ tracker: { access: { ok: false, status: 0 }, patExpiry: null } });
  });
});

describe("parsePatExpiry", () => {
  it("parses GitHub's header formats and computes days left", () => {
    const now = Date.parse("2026-10-08T00:00:00Z");
    expect(parsePatExpiry("2026-10-18 00:00:00 UTC", now)).toEqual({ raw: "2026-10-18 00:00:00 UTC", at: "2026-10-18T00:00:00.000Z", daysLeft: 10 });
    expect(parsePatExpiry("2026-10-18 02:00:00 +0200", now)?.at).toBe("2026-10-18T00:00:00.000Z");
    expect(parsePatExpiry("soon", now)).toEqual({ raw: "soon", at: null, daysLeft: null });
    expect(parsePatExpiry(undefined, now)).toBeNull();
  });
});

describe("admin API — Cloudflare Access sign-in", () => {
  let key: TestKey;
  let jwt: string;
  beforeEach(async () => {
    resetAccessCache();
    key ??= await makeKey("kid-a");
    jwt = await signJwt(key, claims());
    const gh = async () => new Response("{}", { status: 200 });
    vi.stubGlobal("fetch", jwksFetch([key], gh).fn);
  });
  afterEach(() => vi.unstubAllGlobals());

  const ORIGIN = "http://localhost";
  const accessEnv = (s: Store, extra: Record<string, unknown> = {}) => env(s, { FK_ACCESS_TEAM_DOMAIN: TEAM, FK_ACCESS_AUD: AUD, ...extra });
  const withJwt = (token: string | null, headers: Record<string, string> = {}, init: RequestInit = {}) =>
    req(token, CLIENT_IP, { ...init, headers: { "Cf-Access-Jwt-Assertion": jwt, ...headers } });

  it("an Access identity passes adminGate on every read route without a token", async () => {
    const s = store();
    const e = accessEnv(s);
    for (const path of ADMIN_PATHS) expect((await app.request(path, withJwt(null), e)).status, path).toBe(200);
  });

  it("the Bearer token keeps working when Access is configured", async () => {
    const s = store();
    expect((await getJson(accessEnv(s), "/api/admin/projects")).status).toBe(200);
  });

  it("ignores the Access header when FK_ACCESS_* are unset", async () => {
    const s = store();
    expect((await app.request("/api/admin/projects", withJwt(null), env(s))).status).toBe(401);
  });

  it("an invalid Access JWT without a token is a counted failure", async () => {
    const s = store();
    const e = accessEnv(s);
    const bad = await signJwt(key, claims({ aud: ["other-app"] }));
    for (let i = 0; i < 20; i++) {
      expect((await app.request("/api/admin/projects", req(null, CLIENT_IP, { headers: { "Cf-Access-Jwt-Assertion": bad } }), e)).status).toBe(401);
    }
    expect((await getJson(e, "/api/admin/projects")).status).toBe(429);
  });

  it("a valid Access identity is not held by the token lockout of its IP", async () => {
    const s = store();
    const e = accessEnv(s);
    for (let i = 0; i < 21; i++) await getJson(e, "/api/admin/projects", "guess-" + i);
    expect((await getJson(e, "/api/admin/projects")).status).toBe(429);
    expect((await app.request("/api/admin/projects", withJwt(null), e)).status).toBe(200);
  });

  it("GET /api/admin/me reports access with the email, or token", async () => {
    const s = store();
    const e = accessEnv(s);
    const a = await app.request("/api/admin/me", withJwt(null), e);
    expect(a.status).toBe(200);
    expect(a.headers.get("Cache-Control")).toBe("no-store");
    expect(await a.json()).toEqual({ v: 1, via: "access", email: "dana@example.com" });
    const t = await getJson(e, "/api/admin/me");
    expect(t.status).toBe(200);
    expect(t.body).toEqual({ v: 1, via: "token" });
    // Access wins when both are present.
    expect(await (await app.request("/api/admin/me", withJwt(TOKEN), e)).json()).toMatchObject({ via: "access" });
  });

  it("GET /api/admin/me without credentials is a 401 that does not count", async () => {
    const s = store();
    const e = accessEnv(s);
    for (let i = 0; i < 30; i++) expect((await getJson(e, "/api/admin/me", null)).status).toBe(401);
    expect(s.counters.size).toBe(0);
    expect((await getJson(e, "/api/admin/me")).status).toBe(200);
    // A wrong token on /me still counts.
    for (let i = 0; i < 20; i++) expect((await getJson(e, "/api/admin/me", "guess-" + i)).status).toBe(401);
    expect((await getJson(e, "/api/admin/me")).status).toBe(429);
  });

  it("state-changing requests accept Access only from the same origin (CSRF)", async () => {
    const s = store();
    const e = accessEnv(s);
    const body = JSON.stringify({ ...demoConfig, projectId: "fresh" });
    const post = (headers: Record<string, string>) => app.request("/api/admin/config/import", withJwt(null, headers, { method: "POST", body }), e);
    expect((await post({ Origin: "https://evil.example" })).status).toBe(401);
    expect((await post({ "Sec-Fetch-Site": "cross-site" })).status).toBe(401);
    expect((await post({})).status).toBe(401);
    expect((await post({ Origin: ORIGIN })).status).toBe(200);
    expect((await post({ "Sec-Fetch-Site": "same-origin" })).status).toBe(200);

    const del = (headers: Record<string, string>) => app.request(`/api/admin/assets?feedbackId=${clientId(1)}`, withJwt(null, headers, { method: "DELETE" }), e);
    expect((await del({ Origin: "https://evil.example" })).status).toBe(401);
    expect((await del({ Origin: ORIGIN })).status).toBe(200);
  });

  it("/diag?project= runs the deep check for an Access identity", async () => {
    const s = store();
    const e = accessEnv(s);
    const res = await app.request("/diag?project=demo", withJwt(null), e);
    const body = (await res.json()) as { checks: { tracker: string } };
    expect(body.checks.tracker).not.toMatch(/^unauthorized/);
    const anon = await app.request("/diag?project=demo", req(null), e);
    expect(((await anon.json()) as { checks: { tracker: string } }).checks.tracker).toMatch(/^unauthorized/);
  });
});
