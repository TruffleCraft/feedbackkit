import { describe, it, expect } from "vitest";
import { sniffImage, storeAttachment, sweepExpiredAssets, deleteAssetsForFeedback, publicUrl } from "../src/worker/storage/r2.js";
import type { Env } from "../src/worker/env.js";

// Signatures, padded to ≥12 bytes (WebP needs bytes 8–11).
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);

function fakeR2() {
  const store = new Set<string>();
  const calls = { put: [] as string[], del: [] as string[] };
  const bucket = {
    put: async (k: string) => {
      store.add(k);
      calls.put.push(k);
    },
    get: async (k: string) => (store.has(k) ? ({ key: k } as unknown) : null),
    delete: async (k: string) => {
      store.delete(k);
      calls.del.push(k);
    },
  } as unknown as R2Bucket;
  return { bucket, store, calls };
}

function fakeDb(assetKeys: string[] = []) {
  const runs: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      let params: unknown[] = [];
      const stmt = {
        bind: (...a: unknown[]) => {
          params = a;
          return stmt;
        },
        first: async () => null,
        run: async () => {
          runs.push({ sql, params });
          return { success: true };
        },
        all: async () => ({ results: sql.includes("SELECT key FROM assets") ? assetKeys.map((key) => ({ key })) : [] }),
      };
      return stmt as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
  return { db, runs };
}

describe("sniffImage", () => {
  it("accepts png/jpeg/gif/webp by magic bytes", () => {
    expect(sniffImage(png)).toEqual({ ext: "png", mime: "image/png" });
    expect(sniffImage(jpg)).toEqual({ ext: "jpg", mime: "image/jpeg" });
    expect(sniffImage(gif)).toEqual({ ext: "gif", mime: "image/gif" });
    expect(sniffImage(webp)).toEqual({ ext: "webp", mime: "image/webp" });
  });

  it("rejects unknown content and too-short buffers (never trusts a header)", () => {
    expect(sniffImage(new Uint8Array(12))).toBeNull(); // all zero
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull(); // png sig but < 12 bytes
    // A .png-claiming file whose bytes are actually HTML is rejected.
    expect(sniffImage(new TextEncoder().encode("<html>gotcha</html>"))).toBeNull();
  });
});

describe("storeAttachment", () => {
  it("puts to R2 with a per-project key and indexes it with expires_at", async () => {
    const r2 = fakeR2();
    const d1 = fakeDb();
    const env = { UPLOADS: r2.bucket, DB: d1.db } as unknown as Env;
    const stored = await storeAttachment(env, {
      projectId: "demo",
      feedbackId: "fid",
      kind: "screenshot",
      bytes: png,
      sniff: { ext: "png", mime: "image/png" },
      retentionDays: 30,
      now: 1000,
      keyId: "abc",
    });
    expect(stored.key).toBe("demo/abc.png");
    expect(r2.calls.put).toEqual(["demo/abc.png"]);
    const insert = d1.runs.find((r) => r.sql.includes("INSERT INTO assets"));
    expect(insert?.params[4]).toBe(1000 + 30 * 86_400_000); // expires_at
  });

  it("keeps expires_at NULL when no retention is configured", async () => {
    const r2 = fakeR2();
    const d1 = fakeDb();
    const env = { UPLOADS: r2.bucket, DB: d1.db } as unknown as Env;
    await storeAttachment(env, { projectId: "p", feedbackId: "f", kind: "upload", bytes: jpg, sniff: { ext: "jpg", mime: "image/jpeg" }, now: 5, keyId: "k" });
    const insert = d1.runs.find((r) => r.sql.includes("INSERT INTO assets"));
    expect(insert?.params[4]).toBeNull();
  });

  it("removes the orphaned R2 object if the index insert fails", async () => {
    const r2 = fakeR2();
    const env = {
      UPLOADS: r2.bucket,
      DB: {
        prepare() {
          const stmt = { bind: () => stmt, run: async () => { throw new Error("db down"); }, first: async () => null, all: async () => ({ results: [] }) };
          return stmt as unknown as D1PreparedStatement;
        },
      } as unknown as D1Database,
    } as unknown as Env;
    await expect(
      storeAttachment(env, { projectId: "p", feedbackId: "f", kind: "upload", bytes: png, sniff: { ext: "png", mime: "image/png" }, now: 1, keyId: "k" }),
    ).rejects.toThrow("db down");
    expect(r2.calls.put).toEqual(["p/k.png"]);
    expect(r2.calls.del).toEqual(["p/k.png"]); // no orphan without an index row
  });
});

describe("sweepExpiredAssets", () => {
  it("deletes expired objects and marks the rows deleted", async () => {
    const r2 = fakeR2();
    const d1 = fakeDb(["demo/a.png", "demo/b.png"]);
    const env = { UPLOADS: r2.bucket, DB: d1.db } as unknown as Env;
    const n = await sweepExpiredAssets(env, 9999);
    expect(n).toBe(2);
    expect(r2.calls.del.sort()).toEqual(["demo/a.png", "demo/b.png"]);
    expect(d1.runs.filter((r) => r.sql.includes("UPDATE assets SET deleted")).length).toBe(2);
  });
});

describe("deleteAssetsForFeedback", () => {
  it("deletes every asset tied to the feedback id", async () => {
    const r2 = fakeR2();
    const d1 = fakeDb(["demo/x.png"]);
    const env = { UPLOADS: r2.bucket, DB: d1.db } as unknown as Env;
    const n = await deleteAssetsForFeedback(env, "fid");
    expect(n).toBe(1);
    expect(r2.calls.del).toEqual(["demo/x.png"]);
  });

  it("keeps going and counts partial success when one key fails to delete", async () => {
    const d1 = fakeDb(["demo/bad.png", "demo/ok.png"]);
    const del: string[] = [];
    const env = {
      DB: d1.db,
      UPLOADS: {
        delete: async (k: string) => {
          if (k === "demo/bad.png") throw new Error("r2 down");
          del.push(k);
        },
      } as unknown as R2Bucket,
    } as unknown as Env;
    const n = await deleteAssetsForFeedback(env, "fid");
    expect(n).toBe(1); // ok.png deleted; bad.png swallowed, not fatal
    expect(del).toEqual(["demo/ok.png"]);
  });
});

describe("publicUrl", () => {
  it("joins the public base and key, or returns undefined without a base", () => {
    expect(publicUrl("https://cdn.x/", "demo/a.png")).toBe("https://cdn.x/demo/a.png");
    expect(publicUrl("https://cdn.x", "demo/a.png")).toBe("https://cdn.x/demo/a.png");
    expect(publicUrl(undefined, "k")).toBeUndefined();
  });
});
