import { describe, it, expect, beforeEach } from "vitest";
import app from "../src/worker/index.js";
import { __clearConfigCache } from "../src/worker/config.js";
import { fakeD1 } from "./helpers.js";
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
