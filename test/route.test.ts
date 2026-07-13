import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../src/worker/index.js";
import { __clearConfigCache } from "../src/worker/config.js";
import { fakeD1 } from "./helpers.js";
import { MAX_UPLOAD_BYTES } from "../src/worker/storage/r2.js";
import type { Env } from "../src/worker/env.js";

const configJson = JSON.stringify({
  projectId: "demo",
  templates: [{ type: "bug", label: "Bug", fields: [{ key: "repro", label: "Steps", kind: "longtext", required: true }] }],
  llm: { provider: "openrouter", model: "m" },
  tracker: { kind: "github", defaultRepo: "acme/site", patSecret: "GITHUB_PAT_default" },
  auth: { origins: ["https://acme.dev"] },
});

function env(handler: (sql: string, params: unknown[]) => unknown): Env {
  return {
    DB: fakeD1(handler),
    UPLOADS: { get: async () => null } as unknown as R2Bucket,
    ASSETS: { fetch: async () => new Response("") } as unknown as Fetcher,
    FK_ENV: "test",
  } as unknown as Env;
}

const projectRow = (sql: string) =>
  sql.includes("FROM projects") ? { config: configJson, config_version: 4 } : null;

describe("GET /api/config", () => {
  beforeEach(() => __clearConfigCache());

  it("returns the public projection with an ETag", async () => {
    const res = await app.request("/api/config?project=fk_pub_x", {}, env(projectRow));
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe('"cfg-4"');
    const body = (await res.json()) as { v: number; types: unknown[] };
    expect(body.v).toBe(1);
    expect(body.types).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain("GITHUB_PAT_default");
  });

  it("reflects CORS only for an allowlisted origin", async () => {
    const ok = await app.request("/api/config?project=fk_pub_x", { headers: { Origin: "https://acme.dev" } }, env(projectRow));
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe("https://acme.dev");

    const bad = await app.request("/api/config?project=fk_pub_x", { headers: { Origin: "https://evil.com" } }, env(projectRow));
    expect(bad.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("304s on a matching If-None-Match", async () => {
    const res = await app.request(
      "/api/config?project=fk_pub_x",
      { headers: { "If-None-Match": '"cfg-4"' } },
      env(projectRow),
    );
    expect(res.status).toBe(304);
  });

  it("400 without ?project, 404 for unknown", async () => {
    expect((await app.request("/api/config", {}, env(projectRow))).status).toBe(400);
    expect((await app.request("/api/config?project=nope", {}, env(() => null))).status).toBe(404);
  });

  it("answers the CORS preflight so cross-origin If-None-Match works", async () => {
    const res = await app.request(
      "/api/config?project=fk_pub_x",
      { method: "OPTIONS", headers: { Origin: "https://acme.dev" } },
      env(projectRow),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://acme.dev");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("If-None-Match");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
  });
});

describe("GET /diag", () => {
  it("is green when schema matches and bindings exist", async () => {
    const res = await app.request("/diag", {}, env((sql) => (sql.includes("meta") ? { value: "1" } : null)));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; schema: { ok: boolean } };
    expect(body.ok).toBe(true);
    expect(body.schema.ok).toBe(true);
  });

  it("is 503 when the schema is behind", async () => {
    const res = await app.request("/diag", {}, env((sql) => (sql.includes("meta") ? { value: "0" } : null)));
    expect(res.status).toBe(503);
  });
});

// ── Uploads (P1.8) ────────────────────────────────────────────────────────────
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const FID = "11111111-1111-4111-8111-111111111111";

function uploadEnv(projectExists = true) {
  const puts: string[] = [];
  const handler = (sql: string) => {
    if (sql.includes("FROM projects")) return projectExists ? { config: configJson, config_version: 4 } : null;
    if (sql.includes("counters")) return { count: 1 }; // rate-limit upsert RETURNING
    return null;
  };
  const e = {
    DB: fakeD1(handler),
    UPLOADS: { put: async (k: string) => void puts.push(k), get: async () => null, delete: async () => {} } as unknown as R2Bucket,
    ASSETS: { fetch: async () => new Response("") } as unknown as Fetcher,
    FK_ENV: "test",
  } as unknown as Env;
  return { e, puts };
}

describe("POST /api/upload", () => {
  beforeEach(() => __clearConfigCache());

  it("stores a valid image under a per-project key and returns it", async () => {
    const { e, puts } = uploadEnv();
    const res = await app.request(
      `/api/upload?project=fk_pub_x&feedbackId=${FID}&kind=screenshot`,
      { method: "POST", headers: { Origin: "https://acme.dev", "Content-Type": "image/png" }, body: PNG },
      e,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { key: string };
    expect(body.key).toMatch(/^demo\/.+\.png$/);
    expect(puts).toHaveLength(1);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://acme.dev");
  });

  it("rejects a file whose bytes are not an accepted image (415), header ignored", async () => {
    const { e } = uploadEnv();
    const res = await app.request(
      `/api/upload?project=fk_pub_x&feedbackId=${FID}`,
      { method: "POST", headers: { "Content-Type": "image/png" }, body: new TextEncoder().encode("<html>nope</html>") },
      e,
    );
    expect(res.status).toBe(415);
  });

  it("rejects oversize bodies (413)", async () => {
    const { e } = uploadEnv();
    const big = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    big.set(PNG, 0);
    const res = await app.request(`/api/upload?project=fk_pub_x&feedbackId=${FID}`, { method: "POST", body: big }, e);
    expect(res.status).toBe(413);
  });

  it("400s on a missing/invalid feedbackId", async () => {
    const { e } = uploadEnv();
    const res = await app.request(`/api/upload?project=fk_pub_x&feedbackId=not-a-uuid`, { method: "POST", body: PNG }, e);
    expect(res.status).toBe(400);
  });

  it("403s a non-allowlisted origin and 404s an unknown project", async () => {
    const { e } = uploadEnv();
    const forbidden = await app.request(
      `/api/upload?project=fk_pub_x&feedbackId=${FID}`,
      { method: "POST", headers: { Origin: "https://evil.com" }, body: PNG },
      e,
    );
    expect(forbidden.status).toBe(403);

    const unknown = await app.request(`/api/upload?project=nope&feedbackId=${FID}`, { method: "POST", body: PNG }, uploadEnv(false).e);
    expect(unknown.status).toBe(404);
  });

  it("answers the CORS preflight", async () => {
    const res = await app.request("/api/upload", { method: "OPTIONS", headers: { Origin: "https://acme.dev" } }, uploadEnv().e);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });
});

describe("DELETE /api/admin/assets", () => {
  beforeEach(() => __clearConfigCache());

  it("401s without the admin token", async () => {
    const res = await app.request(`/api/admin/assets?feedbackId=${FID}`, { method: "DELETE" }, uploadEnv().e);
    expect(res.status).toBe(401);
  });

  it("deletes with a valid admin token", async () => {
    const { e } = uploadEnv();
    (e as Record<string, unknown>)["ADMIN_TOKEN"] = "s3cret";
    const res = await app.request(
      `/api/admin/assets?feedbackId=${FID}`,
      { method: "DELETE", headers: { Authorization: "Bearer s3cret" } },
      e,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: number };
    expect(typeof body.deleted).toBe("number");
  });

  it("400s on an invalid feedbackId even when authed", async () => {
    const { e } = uploadEnv();
    (e as Record<string, unknown>)["ADMIN_TOKEN"] = "s3cret";
    const res = await app.request(`/api/admin/assets?feedbackId=bad`, { method: "DELETE", headers: { Authorization: "Bearer s3cret" } }, e);
    expect(res.status).toBe(400);
  });
});

// ── Feedback + events wiring (P1.9) ─────────────────────────────────────────────
const fbPayload = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, feedbackId: FID, type: "bug", message: "kaputt", pageUrl: "https://acme.dev", ...over });

describe("POST /api/feedback (route wiring)", () => {
  beforeEach(() => __clearConfigCache());

  it("400s without ?project", async () => {
    const res = await app.request("/api/feedback", { method: "POST", body: fbPayload() }, env(projectRow));
    expect(res.status).toBe(400);
  });

  it("gives a filled honeypot a plausible fake success (no processing)", async () => {
    const res = await app.request("/api/feedback?project=fk_pub_x", { method: "POST", body: fbPayload({ hpField: "i am a bot" }) }, env(projectRow));
    expect(res.status).toBe(200);
    expect((await res.json() as { status: string }).status).toBe("created");
  });

  it("400s on a payload that fails the wire contract", async () => {
    const res = await app.request("/api/feedback?project=fk_pub_x", { method: "POST", body: JSON.stringify({ v: 1, feedbackId: "bad", pageUrl: "x" }) }, env(projectRow));
    expect(res.status).toBe(400);
  });

  it("413s an oversized feedback body (bounded read, before Zod)", async () => {
    const big = JSON.stringify({ v: 1, feedbackId: FID, pageUrl: "https://acme.dev", message: "x".repeat(600_000) });
    const res = await app.request("/api/feedback?project=fk_pub_x", { method: "POST", body: big }, env(projectRow));
    expect(res.status).toBe(413);
  });

  it("with no LLM key, runs required-field mode → need_fields (no network)", async () => {
    const res = await app.request("/api/feedback?project=fk_pub_x", { method: "POST", body: fbPayload() }, env(projectRow));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; missing: string[] };
    expect(body.status).toBe("need_fields");
    expect(body.missing).toEqual(["repro"]);
  });
});

describe("test page /t/:key + /api/test-preview (P1.11)", () => {
  beforeEach(() => __clearConfigCache());

  it("serves the test page with a strict CSP and safely-embedded key", async () => {
    const res = await app.request("/t/fk_pub_x", {}, env(projectRow));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    const html = await res.text();
    expect(html).toContain('"project":"fk_pub_x"');
    // a key trying to inject markup is escaped (< → <), never raw in the HTML
    const evil = await (await app.request("/t/" + encodeURIComponent('<img src=x onerror=alert(1)>'), {}, env(projectRow))).text();
    expect(evil).not.toContain("<img src=x");
    expect(evil).toContain("\\u003cimg src=x");
  });

  it("dry-run preview returns the rendered issue (no LLM/issue/D1 write)", async () => {
    const res = await app.request(
      "/api/test-preview?project=fk_pub_x",
      { method: "POST", body: JSON.stringify({ type: "bug", message: "totally broken" }) },
      env(projectRow),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string; body: string };
    expect(body.title).toContain("[BUG]");
    expect(body.body).toContain("totally broken");
  });

  it("test-preview rejects a cross-origin request", async () => {
    const res = await app.request(
      "/api/test-preview?project=fk_pub_x",
      { method: "POST", headers: { Origin: "https://evil.com" }, body: JSON.stringify({ type: "bug", message: "x" }) },
      env(projectRow),
    );
    expect(res.status).toBe(403);
  });
});

describe("same-origin auto-allow", () => {
  beforeEach(() => __clearConfigCache());
  it("allows a same-origin feedback POST even though the gateway origin isn't in the allowlist", async () => {
    // Origin equals the request's own origin (the /t/<key> page) → not 403.
    const res = await app.request(
      "http://localhost/api/feedback?project=fk_pub_x",
      { method: "POST", headers: { Origin: "http://localhost" }, body: fbPayload() },
      env(projectRow),
    );
    expect(res.status).not.toBe(403);
  });
});

describe("POST /api/events", () => {
  it("accepts a valid enum event and always 204s", async () => {
    const ok = await app.request("/api/events", { method: "POST", body: JSON.stringify({ v: 1, project: "fk_pub_x", name: "submitted" }) }, env(projectRow));
    expect(ok.status).toBe(204);
    const garbage = await app.request("/api/events", { method: "POST", body: "not json" }, env(projectRow));
    expect(garbage.status).toBe(204);
  });
});
