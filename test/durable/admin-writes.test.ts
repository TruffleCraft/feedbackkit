import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { registerAdminRoutes } from "../../src/worker/admin/routes.js";
import type { Env } from "../../src/worker/env.js";
import { resetStorage } from "./reset.js";

// #111: the admin write routes against a real D1 and R2, through Hono. Only the
// admin routes are registered: app.ts pulls in the MCP/OAuth modules, which
// generate random values at module scope (not allowed in workerd test scope).
const app = new Hono<{ Bindings: Env }>();
registerAdminRoutes(app);
const TOKEN = "s3cret";
const gw = { ...env, ADMIN_TOKEN: TOKEN, FK_ENV: "test" } as unknown as Env;
const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` }) =>
  app.request(path, { method, headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, gw);

const config = { projectId: "demo", templates: [{ type: "bug", label: "Bug" }], llm: { provider: "off" }, tracker: { kind: "github", defaultRepo: "acme/site", patSecret: "GITHUB_PAT_default" }, auth: { origins: [] } };

async function seed() {
  await resetStorage();
  await env.DB.prepare("INSERT INTO projects (id, public_key, config, config_version, updated_at) VALUES ('demo', 'fk_pub_demo', ?1, 3, 0)").bind(JSON.stringify(config)).run();
  const row = (id: string, delivery: string | null, issueUrl: string | null) =>
    env.DB.prepare("INSERT INTO feedback (id, project_id, outcome, payload, issue_url, created_at, client_feedback_id, delivery) VALUES (?1, 'demo', 'created', ?2, ?3, 1, ?4, ?5)")
      .bind(id, JSON.stringify({ feedbackId: `c-${id}`, message: "hi" }), issueUrl, `c-${id}`, delivery)
      .run();
  await row("local-1", "local", null);
  await row("issue-1", "issue", "https://github.com/acme/site/issues/1");
  await row("old-1", null, null);
  await env.UPLOADS.put("demo/a.png", "png");
  await env.DB.prepare("INSERT INTO assets (key, project_id, feedback_id, kind, created_at) VALUES ('demo/a.png', 'demo', 'c-local-1', 'screenshot', 1)").run();
}

describe("PATCH /api/admin/feedback/:id", () => {
  beforeEach(seed);

  it("sets disposition, handled_at and a note on a local row", async () => {
    const res = await call("PATCH", "/api/admin/feedback/local-1", { disposition: "done", note: "fixed in 2.3" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ disposition: "done", note: "fixed in 2.3", handledAt: expect.any(Number) });
    const reopened = await (await call("PATCH", "/api/admin/feedback/local-1", { disposition: "open" })).json();
    expect(reopened).toMatchObject({ disposition: "open", handledAt: null, note: "fixed in 2.3" });
  });

  it("works on undecided rows from before v4, refuses delivered ones with FK_NOT_LOCAL", async () => {
    expect((await call("PATCH", "/api/admin/feedback/old-1", { disposition: "dismissed" })).status).toBe(200);
    const res = await call("PATCH", "/api/admin/feedback/issue-1", { disposition: "done" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "FK_NOT_LOCAL" });
  });

  it("validates its input", async () => {
    expect((await call("PATCH", "/api/admin/feedback/local-1", { disposition: "gone" })).status).toBe(400);
    expect((await call("PATCH", "/api/admin/feedback/local-1", { note: "x".repeat(2001) })).status).toBe(400);
    expect((await call("PATCH", "/api/admin/feedback/local-1", {})).status).toBe(400);
    expect((await call("PATCH", "/api/admin/feedback/nope", { disposition: "done" })).status).toBe(404);
  });
});

describe("DELETE /api/admin/feedback/:id", () => {
  beforeEach(seed);

  it("deletes the attachments, then the row", async () => {
    const res = await call("DELETE", "/api/admin/feedback/local-1");
    expect(await res.json()).toMatchObject({ status: "deleted", assetsDeleted: 1 });
    expect(await env.UPLOADS.get("demo/a.png")).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM feedback WHERE id = 'local-1'").first()).toBeNull();
    expect((await call("DELETE", "/api/admin/feedback/local-1")).status).toBe(404);
  });
});

describe("config editor routes", () => {
  beforeEach(seed);
  const edited = { ...config, templates: [{ type: "bug", label: "Bug" }, { type: "praise", label: "Praise", noIssue: true }] };

  it("validate names Zod issues and the effective delivery per type", async () => {
    const bad = await call("POST", "/api/admin/projects/demo/config/validate", { config: { ...config, templates: [] } });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "FK_CONFIG_INVALID", issues: [expect.stringContaining("templates")] });
    const ok = await call("POST", "/api/admin/projects/demo/config/validate", { config: { ...edited, publicKey: "fk_pub_demo", configVersion: 3 } });
    expect(await ok.json()).toMatchObject({ status: "valid", configVersion: 3, deliveries: [{ type: "bug", delivery: "issue" }, { type: "praise", delivery: "local" }] });
  });

  it("refuses a retention shorter than the notice for unhandled reports, on validate and on publish", async () => {
    const short = { ...config, storage: { kind: "r2", retentionDays: 3 } };
    const bad = await call("POST", "/api/admin/projects/demo/config/validate", { config: short });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "FK_CONFIG_INVALID", issues: [expect.stringContaining("7-day notice")] });
    expect((await call("PUT", "/api/admin/projects/demo/config", { config: short, expectedVersion: 3 })).status).toBe(400);
    expect((await call("POST", "/api/admin/projects/demo/config/validate", { config: { ...config, storage: { kind: "r2", retentionDays: 7 } } })).status).toBe(200);
  });

  it("names what a retention change deletes: reports and attachments older than it", async () => {
    // The seeded reports were all submitted long ago, one of them has a screenshot.
    const ok = await call("POST", "/api/admin/projects/demo/config/validate", { config: { ...config, storage: { kind: "r2", retentionDays: 30 } } });
    expect(await ok.json()).toMatchObject({ status: "valid", retention: { days: 30, previousDays: null, reports: 3, attachments: 1 } });
    // Nothing changes, nothing to report.
    expect(await (await call("POST", "/api/admin/projects/demo/config/validate", { config })).json()).not.toHaveProperty("retention");
    // Reports newer than the retention stay out of the count.
    await env.DB.prepare("UPDATE feedback SET created_at = ?1 WHERE id = 'issue-1'").bind(Date.now()).run();
    expect(await (await call("POST", "/api/admin/projects/demo/config/validate", { config: { ...config, storage: { kind: "r2", retentionDays: 30 } } })).json()).toMatchObject({ retention: { reports: 2 } });
  });

  it("says so when a retention is removed", async () => {
    await env.DB.prepare("UPDATE projects SET config = ?1 WHERE id = 'demo'").bind(JSON.stringify({ ...config, storage: { kind: "r2", retentionDays: 30 } })).run();
    const res = await call("POST", "/api/admin/projects/demo/config/validate", { config });
    expect(await res.json()).toMatchObject({ retention: { days: null, previousDays: 30, reports: 0, attachments: 0 } });
  });

  it("locks projectId", async () => {
    const res = await call("POST", "/api/admin/projects/demo/config/validate", { config: { ...config, projectId: "other" } });
    expect(res.status).toBe(400);
  });

  it("publishes with expectedVersion, stores the blob as written, and answers 409 FK_CONFIG_STALE on a stale version", async () => {
    const res = await call("PUT", "/api/admin/projects/demo/config", { config: { ...edited, publicKey: "fk_pub_demo", configVersion: 3 }, expectedVersion: 3 });
    expect(await res.json()).toMatchObject({ status: "published", configVersion: 4 });
    const stored = await env.DB.prepare("SELECT config FROM projects WHERE id = 'demo'").first<{ config: string }>();
    expect(JSON.parse(stored!.config)).toEqual(edited); // no defaults, no publicKey/configVersion

    // A stale write that keeps the published types, so the version check is what refuses it.
    const stale = await call("PUT", "/api/admin/projects/demo/config", { config: { ...edited, privacyUrl: "https://acme.example/privacy" }, expectedVersion: 3 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "FK_CONFIG_STALE", configVersion: 4, config: edited });
  });

  it("applies the delivery shape gate like the import", async () => {
    const res = await call("PUT", "/api/admin/projects/demo/config", { config: { ...config, delivery: "local" }, expectedVersion: 3 });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "FK_CONFIG_SHAPE_UNSUPPORTED" });
  });
});

describe("published type IDs", () => {
  const two = { ...config, templates: [{ type: "bug", label: "Bug" }, { type: "idea", label: "Idea" }] };
  beforeEach(async () => {
    await seed();
    await env.DB.prepare("UPDATE projects SET config = ?1 WHERE id = 'demo'").bind(JSON.stringify(two)).run();
  });

  it("refuses to drop or rename a published type, on validate and on publish, and says to archive it", async () => {
    for (const templates of [[{ type: "bug", label: "Bug" }], [{ type: "bug", label: "Bug" }, { type: "thought", label: "Idea" }]]) {
      const check = await call("POST", "/api/admin/projects/demo/config/validate", { config: { ...config, templates } });
      expect(check.status).toBe(400);
      expect(await check.json()).toMatchObject({ code: "FK_CONFIG_INVALID", issues: [expect.stringContaining('type "idea" was published')] });
      expect((await call("PUT", "/api/admin/projects/demo/config", { config: { ...config, templates }, expectedVersion: 3 })).status).toBe(400);
    }
    const stored = await env.DB.prepare("SELECT config FROM projects WHERE id = 'demo'").first<{ config: string }>();
    expect(JSON.parse(stored!.config)).toEqual(two);
  });

  it("refuses an ID that is used twice", async () => {
    const res = await call("POST", "/api/admin/projects/demo/config/validate", { config: { ...config, templates: [{ type: "bug", label: "Bug" }, { type: "bug", label: "Again" }] } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ issues: expect.arrayContaining([expect.stringContaining("used by more than one type")]) });
  });

  it("publishes an archived type once the stored capability covers it", async () => {
    const archived = { ...two, templates: [{ type: "bug", label: "Bug" }, { type: "idea", label: "Idea", archived: true }] };
    const early = await call("PUT", "/api/admin/projects/demo/config", { config: archived, expectedVersion: 3 });
    expect(early.status).toBe(422);
    expect(await early.json()).toMatchObject({ code: "FK_CONFIG_SHAPE_UNSUPPORTED", required: 3 });
    await env.DB.prepare("INSERT INTO meta (key, value) VALUES ('delivery_capability', '3') ON CONFLICT(key) DO UPDATE SET value = '3'").run();
    const ok = await call("PUT", "/api/admin/projects/demo/config", { config: archived, expectedVersion: 3 });
    expect(await ok.json()).toMatchObject({ status: "published", configVersion: 4 });
    const stored = await env.DB.prepare("SELECT config FROM projects WHERE id = 'demo'").first<{ config: string }>();
    expect(JSON.parse(stored!.config).templates[1]).toMatchObject({ type: "idea", archived: true });
  });
});

describe("GET /api/admin/projects/:id/feedback?view=", () => {
  beforeEach(seed);
  const ids = async (view: string) => ((await (await call("GET", `/api/admin/projects/demo/feedback?view=${view}`)).json()) as { items: Array<{ id: string }> }).items.map((i) => i.id);

  it("open, done and undecided", async () => {
    expect(await ids("open")).toEqual(["local-1"]);
    expect(await ids("undecided")).toEqual(["old-1"]);
    await call("PATCH", "/api/admin/feedback/local-1", { disposition: "done" });
    expect(await ids("done")).toEqual(["local-1"]);
    expect(await ids("open")).toEqual([]);
    expect((await call("GET", "/api/admin/projects/demo/feedback?view=nope")).status).toBe(400);
  });
});
