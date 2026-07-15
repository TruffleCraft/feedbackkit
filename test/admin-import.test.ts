// P2: CLI-free config import (POST /api/admin/config/import), /diag first-run
// visibility, and the GET / landing page.
import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../src/worker/app.js";
import { __clearConfigCache } from "../src/worker/config.js";
import { fakeD1 } from "./helpers.js";
import type { Env } from "../src/worker/env.js";

const validConfig = {
  projectId: "demo",
  templates: [{ type: "bug", label: "Bug", fields: [{ key: "repro", label: "Steps", kind: "longtext", required: true }] }],
  llm: { provider: "openrouter", model: "m" },
  tracker: { kind: "github", defaultRepo: "acme/site", patSecret: "GITHUB_PAT_default" },
  auth: { origins: ["https://acme.dev"] },
};

function env(handler: (sql: string, params: unknown[]) => unknown, extra: Record<string, unknown> = {}): Env {
  return {
    DB: fakeD1(handler),
    UPLOADS: { get: async () => null } as unknown as R2Bucket,
    ASSETS: { fetch: async () => new Response("") } as unknown as Fetcher,
    FK_ENV: "test",
    WIDGET_VERSION: "testver",
    ADMIN_TOKEN: "s3cret",
    ...extra,
  } as unknown as Env;
}

function importReq(body: unknown, token = "s3cret") {
  return {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("POST /api/admin/config/import", () => {
  beforeEach(() => __clearConfigCache());

  it("401s without a valid admin token", async () => {
    const unauthed = await app.request("/api/admin/config/import", { method: "POST", body: "{}" }, env(() => null));
    expect(unauthed.status).toBe(401);
    const wrong = await app.request("/api/admin/config/import", importReq(validConfig, "nope"), env(() => null));
    expect(wrong.status).toBe(401);
  });

  it("400s an invalid config with Zod issue paths", async () => {
    const res = await app.request(
      "/api/admin/config/import",
      importReq({ projectId: "demo", templates: [] }),
      env(() => null),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: string[] };
    expect(body.error).toBe("config failed validation");
    expect(body.issues.join("\n")).toContain("templates");
  });

  it("upserts, generates a public key, and returns snippet + test page", async () => {
    const writes: { sql: string; params: unknown[] }[] = [];
    const handler = (sql: string, params: unknown[]) => {
      if (sql.startsWith("INSERT INTO projects")) {
        writes.push({ sql, params });
        return null;
      }
      if (sql.includes("SELECT public_key")) {
        return { public_key: writes[0]!.params[1], config_version: 1 };
      }
      return null;
    };
    const res = await app.request("https://fk.example.com/api/admin/config/import", importReq(validConfig), env(handler));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; publicKey: string; snippet: string; testPage: string; configVersion: number };
    expect(body.status).toBe("imported");
    expect(body.publicKey).toMatch(/^fk_pub_[0-9a-f]{12}$/);
    expect(body.snippet).toBe(`<script src="https://fk.example.com/widget.js?v=testver" data-project="${body.publicKey}"></script>`);
    expect(body.testPage).toBe(`https://fk.example.com/t/${body.publicKey}`);

    // The stored blob never contains the publicKey (it lives in its own column).
    const [id, , configBlob] = writes[0]!.params as [string, string, string];
    expect(id).toBe("demo");
    expect(configBlob).not.toContain("publicKey");
    expect(JSON.parse(configBlob).projectId).toBe("demo");
  });

  it("pins a caller-provided publicKey on first import", async () => {
    let insertedKey = "";
    const handler = (sql: string, params: unknown[]) => {
      if (sql.startsWith("INSERT INTO projects")) insertedKey = params[1] as string;
      if (sql.includes("SELECT public_key")) return { public_key: insertedKey, config_version: 1 };
      return null;
    };
    const res = await app.request(
      "/api/admin/config/import",
      importReq({ publicKey: "fk_pub_pinned1", ...validConfig }),
      env(handler),
    );
    const body = (await res.json()) as { publicKey: string };
    expect(body.publicKey).toBe("fk_pub_pinned1");
  });

  it("rejects a malformed publicKey", async () => {
    const res = await app.request(
      "/api/admin/config/import",
      importReq({ publicKey: "bad key!", ...validConfig }),
      env(() => null),
    );
    expect(res.status).toBe(400);
  });

  it("returns the STORED key on re-import — the key never rotates", async () => {
    const handler = (sql: string) =>
      sql.includes("SELECT public_key") ? { public_key: "fk_pub_original", config_version: 5 } : null;
    const res = await app.request(
      "/api/admin/config/import",
      importReq({ publicKey: "fk_pub_replaced", ...validConfig }),
      env(handler),
    );
    const body = (await res.json()) as { publicKey: string; configVersion: number };
    expect(body.publicKey).toBe("fk_pub_original");
    expect(body.configVersion).toBe(5);
  });

  it("409s when the publicKey belongs to another project", async () => {
    const handler = (sql: string) => {
      if (sql.startsWith("INSERT INTO projects")) throw new Error("UNIQUE constraint failed: projects.public_key");
      return null;
    };
    const res = await app.request("/api/admin/config/import", importReq(validConfig), env(handler));
    expect(res.status).toBe(409);
  });

  it("503s when D1 is not migrated/reachable", async () => {
    const handler = (sql: string) => {
      if (sql.startsWith("INSERT INTO projects")) throw new Error("no such table: projects");
      return null;
    };
    const res = await app.request("/api/admin/config/import", importReq(validConfig), env(handler));
    expect(res.status).toBe(503);
  });
});

describe("GET /diag first-run visibility", () => {
  const migrated = (sql: string) => {
    if (sql.includes("meta")) return { value: "1" };
    if (sql.includes("COUNT(*)")) return { n: 0 };
    return null;
  };

  it("exposes presence booleans, firstRun and nextSteps — never values", async () => {
    const bare = {
      DB: fakeD1(migrated),
      UPLOADS: { get: async () => null } as unknown as R2Bucket,
      ASSETS: { fetch: async () => new Response("") } as unknown as Fetcher,
      FK_ENV: "test",
    } as unknown as Env; // no secrets at all — the fresh button deploy
    const res = await app.request("/diag", {}, bare);
    expect(res.status).toBe(200); // infra is healthy; readiness is a separate signal
    const body = (await res.json()) as {
      secrets: { adminToken: boolean; githubPat: boolean; llmKey: boolean };
      projects: number;
      firstRun: boolean;
      nextSteps: string[];
    };
    expect(body.secrets).toEqual({ adminToken: false, githubPat: false, llmKey: false });
    expect(body.projects).toBe(0);
    expect(body.firstRun).toBe(true);
    expect(body.nextSteps.join("\n")).toContain("ADMIN_TOKEN");
    expect(body.nextSteps.join("\n")).toContain("config/import");
    expect(JSON.stringify(body)).not.toContain("s3cret");
  });

  it("clears firstRun and shrinks nextSteps once configured", async () => {
    const handler = (sql: string) => {
      if (sql.includes("meta")) return { value: "1" };
      if (sql.includes("COUNT(*)")) return { n: 2 };
      return null;
    };
    const res = await app.request("/diag", {}, env(handler, { GITHUB_PAT_default: "x", LLM_API_KEY: "y" }));
    const body = (await res.json()) as { firstRun: boolean; nextSteps: string[]; secrets: { githubPat: boolean } };
    expect(body.firstRun).toBe(false);
    expect(body.secrets.githubPat).toBe(true);
    expect(body.nextSteps).toEqual([]);
  });
});

describe("GET / landing page", () => {
  it("renders the setup checklist with fixes on a fresh deploy", async () => {
    const bare = {
      DB: fakeD1((sql: string) => (sql.includes("meta") ? { value: "1" } : sql.includes("COUNT(*)") ? { n: 0 } : null)),
      UPLOADS: {} as R2Bucket,
      ASSETS: {} as Fetcher,
      FK_ENV: "test",
    } as unknown as Env;
    const res = await app.request("/", {}, bare);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain("Almost there");
    expect(html).toContain("wrangler secret put ADMIN_TOKEN");
    expect(html).toContain("/api/admin/config/import");
  });

  it("shows ready state once secrets + a project exist", async () => {
    const handler = (sql: string) => {
      if (sql.includes("meta")) return { value: "1" };
      if (sql.includes("COUNT(*)")) return { n: 1 };
      return null;
    };
    const res = await app.request("/", {}, env(handler, { GITHUB_PAT_default: "x" }));
    const html = await res.text();
    expect(html).toContain("Ready.");
    expect(html).not.toContain("wrangler secret put ADMIN_TOKEN");
  });
});
