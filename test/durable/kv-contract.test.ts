import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";

// What the OAuth provider needs from KV (ADR-015), run twice: against Cloudflare's own KV in workerd
// (vitest.workers.config.ts) and against the SQLite adapter of the standalone server (scripts/server-kv.mjs, through
// vitest.conformance.config.ts). A call where the two answer differently fails one of the runs.
// Expiry over time is not here: workerd's clock cannot be moved, so test/server-kv.test.mjs covers it on SQLite.

const kv = env.OAUTH_KV!;
const names = async (prefix: string) => (await kv.list({ prefix })).keys.map((k) => k.name);

async function empty() {
  let cursor: string | undefined;
  do {
    const page = await kv.list({ cursor });
    await Promise.all(page.keys.map((k) => kv.delete(k.name)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

describe("the KV the OAuth provider stores its state in", () => {
  beforeEach(empty);

  it("returns text, parsed JSON or null", async () => {
    await kv.put("client:a", JSON.stringify({ n: 1 }));
    expect(await kv.get("client:a")).toBe('{"n":1}');
    expect(await kv.get("client:a", { type: "json" })).toEqual({ n: 1 });
    expect(await kv.get("client:a", "json")).toEqual({ n: 1 });
    expect(await kv.get("client:missing")).toBeNull();
    expect(await kv.get("client:missing", { type: "json" })).toBeNull();
  });

  it("overwrites and deletes", async () => {
    await kv.put("k", "one");
    await kv.put("k", "two");
    expect(await kv.get("k")).toBe("two");
    await kv.delete("k");
    expect(await kv.get("k")).toBeNull();
    await kv.delete("k"); // deleting nothing is fine
  });

  it("lists by prefix in key order and keeps a prefix literal", async () => {
    for (const name of ["grant:u:3", "grant:u:1", "client:x", "grant:v:1", "grant:u:2", "token:t", "a%b", "axb", "a_b", "aXb"]) await kv.put(name, "1");
    expect(await names("grant:u:")).toEqual(["grant:u:1", "grant:u:2", "grant:u:3"]);
    expect(await names("nothing:")).toEqual([]);
    expect(await names("a%")).toEqual(["a%b"]);
    expect(await names("a_")).toEqual(["a_b"]);
    expect(await names("A")).toEqual([]);
  });

  it("pages with limit and cursor, and says when the list is complete", async () => {
    for (const n of [1, 2, 3, 4, 5]) await kv.put(`grant:u:${n}`, "1");
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await kv.list({ prefix: "grant:u:", limit: 2, cursor });
      pages++;
      seen.push(...page.keys.map((k) => k.name));
      if (page.list_complete) break;
      cursor = (page as { cursor: string }).cursor;
    }
    expect(seen).toEqual(["grant:u:1", "grant:u:2", "grant:u:3", "grant:u:4", "grant:u:5"]);
    expect(pages).toBe(3);
    const exact = await kv.list({ prefix: "grant:u:", limit: 5 });
    expect(exact.keys).toHaveLength(5);
    expect(exact.list_complete).toBe(true);
  });

  it("returns key metadata in list, and none for a key without", async () => {
    await kv.put("grant:u:1", "{}", { metadata: { clientId: "c1", redirectUri: "https://client.example/cb" } });
    await kv.put("grant:u:2", "{}");
    const { keys } = await kv.list({ prefix: "grant:u:" });
    expect(keys[0]!.metadata).toEqual({ clientId: "c1", redirectUri: "https://client.example/cb" });
    expect(keys[1]!.metadata ?? null).toBeNull();
  });

  it("stores a TTL as an expiration time that list reports, and none for a key that never expires", async () => {
    await kv.put("token:short", "x", { expirationTtl: 600 });
    await kv.put("token:forever", "y");
    const { keys } = await kv.list({ prefix: "token:" });
    const now = Date.now() / 1000;
    expect(keys.map((k) => k.name)).toEqual(["token:forever", "token:short"]);
    expect(keys[0]!.expiration).toBeUndefined();
    expect(keys[1]!.expiration).toBeGreaterThan(now + 595);
    expect(keys[1]!.expiration).toBeLessThan(now + 605);
    expect(await kv.get("token:short")).toBe("x");
  });

  it("refuses what KV refuses: a TTL under 60 s, a key over 512 bytes, metadata over 1024 bytes", async () => {
    await expect(kv.put("t", "v", { expirationTtl: 30 })).rejects.toThrow();
    await expect(kv.put("k".repeat(513), "v")).rejects.toThrow();
    await expect(kv.put("m", "v", { metadata: { big: "x".repeat(1100) } })).rejects.toThrow();
    expect(await kv.get("t")).toBeNull();
    expect(await kv.get("m")).toBeNull();
  });
});
