import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeD1 } from "./helpers.js";
import type { Env } from "../src/worker/env.js";
import type { DeliveryResult } from "../src/worker/delivery.js";

// #110: the admin routes around delivery. deliverRow is mocked (its behaviour is
// covered against a real D1 in test/durable/delivery.test.ts); this checks the
// HTTP contract: auth, status codes and error codes.
const delivery = vi.hoisted(() => ({ result: null as unknown, seen: [] as unknown[] }));
vi.mock("../src/worker/delivery.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/worker/delivery.js")>();
  return {
    ...real,
    deliverRow: async (_env: unknown, id: string, opts: unknown) => {
      delivery.seen.push({ id, opts });
      return delivery.result;
    },
  };
});
const { app } = await import("../src/worker/app.js");

const TOKEN = "s3cret";
const auth = { Authorization: `Bearer ${TOKEN}` };
function env(handler: (sql: string, params: unknown[]) => unknown = () => null, uploads: Record<string, { body: string; type: string }> = {}): Env {
  return {
    DB: fakeD1(handler),
    UPLOADS: {
      get: async (key: string) => (uploads[key] ? { body: new Response(uploads[key]!.body).body, httpMetadata: { contentType: uploads[key]!.type } } : null),
    } as unknown as R2Bucket,
    ADMIN_TOKEN: TOKEN,
    FK_ENV: "test",
  } as unknown as Env;
}
const retry = (body: unknown = {}, headers: Record<string, string> = auth) =>
  app.request("/api/admin/feedback/row-1/retry", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) }, env());

describe("POST /api/admin/feedback/:id/retry", () => {
  beforeEach(() => {
    delivery.seen = [];
  });
  const cases: Array<[DeliveryResult, number, Record<string, unknown>]> = [
    [{ status: "delivered", itemId: 9, projectUrl: "https://github.com/orgs/a/projects/1", warnings: [] }, 200, { status: "delivered", feedbackId: "row-1", itemId: 9 }],
    [{ status: "missing" }, 404, { code: "FK_NOT_FOUND" }],
    [{ status: "not_retryable", reason: "local" }, 409, { code: "FK_NOT_RETRYABLE" }],
    [{ status: "busy", claimUntil: Date.now() + 30_000 }, 409, { code: "FK_RETRY_IN_PROGRESS" }],
    [{ status: "unknown_needs_decision" }, 409, { code: "FK_DELIVERY_UNKNOWN", needsCreateAnyway: true }],
    [{ status: "unknown", reason: "timeout" }, 502, { code: "FK_DELIVERY_UNKNOWN" }],
    [{ status: "failed", reason: "GitHub answered 403", httpStatus: 403 }, 502, { code: "FK_DELIVERY_FAILED", githubStatus: 403 }],
  ];
  for (const [result, status, body] of cases) {
    it(`${result.status} → ${status}`, async () => {
      delivery.result = result;
      const res = await retry();
      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject(body);
    });
  }

  it("passes createAnyway only when it is literally true, and needs admin auth", async () => {
    delivery.result = { status: "missing" };
    await retry({ createAnyway: "yes" });
    await retry({ createAnyway: true });
    expect(delivery.seen.map((s) => (s as { opts: { createAnyway: boolean } }).opts.createAnyway)).toEqual([false, true]);
    expect((await retry({}, {})).status).toBe(401);
  });

  it("sets Retry-After while another delivery holds the claim", async () => {
    delivery.result = { status: "busy", claimUntil: Date.now() + 30_000 };
    expect(Number((await retry()).headers.get("Retry-After"))).toBeGreaterThan(0);
  });
});

describe("GET /admin/assets/* (private screenshot links)", () => {
  const known = (sql: string, params: unknown[]) => (sql.includes("FROM assets") && params[0] === "demo/shot.png" ? { key: "demo/shot.png" } : null);
  const uploads = { "demo/shot.png": { body: "PNGDATA", type: "image/png" } };

  it("needs a sign-in", async () => {
    expect((await app.request("/admin/assets/demo/shot.png", {}, env(known, uploads))).status).toBe(401);
  });

  it("streams a known attachment with private, sandboxed headers", async () => {
    const res = await app.request("/admin/assets/demo/shot.png", { headers: auth }, env(known, uploads));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(await res.text()).toBe("PNGDATA");
  });

  it("404s a key that is not indexed (deleted or never stored)", async () => {
    expect((await app.request("/admin/assets/demo/other.png", { headers: auth }, env(known, uploads))).status).toBe(404);
  });
});
