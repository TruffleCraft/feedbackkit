import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { sweepOrphanScreenshots, ORPHAN_SCREENSHOT_MS } from "../../src/worker/storage/r2.js";
import type { Env } from "../../src/worker/env.js";
import { resetStorage } from "./reset.js";

// #170 against a real local D1 and R2: screenshots upload on capture, before the
// report exists. Those no stored report lists are deleted 24 hours after upload.

const NOW = 1_800_000_000_000;
const SENT = "55555555-5555-4555-8555-555555555555";
const ABANDONED = "66666666-6666-4666-8666-666666666666";
const gw = env as unknown as Env;

async function asset(key: string, feedbackId: string, kind: string, ageMs: number) {
  await gw.UPLOADS.put(key, new Uint8Array([1]));
  await gw.DB.prepare("INSERT INTO assets (key, project_id, feedback_id, kind, expires_at, created_at) VALUES (?1, 'demo', ?2, ?3, NULL, ?4)")
    .bind(key, feedbackId, kind, NOW - ageMs)
    .run();
}

async function report(feedbackId: string, attachmentKeys: string[]) {
  const payload = JSON.stringify({ v: 1, feedbackId, message: "The total shows $0.00", pageUrl: "https://example.org/orders", attachmentKeys });
  await gw.DB.prepare(
    "INSERT INTO feedback (id, project_id, outcome, payload, issue_url, created_at, type, title, llm_provider, llm_model, config_version, updated_at, client_feedback_id) VALUES (?1, 'demo', 'created', ?2, NULL, ?3, 'bug', 't', 'off', NULL, 1, ?3, ?4)",
  )
    .bind(crypto.randomUUID(), payload, NOW, feedbackId)
    .run();
}

const deleted = async (key: string) => (await gw.DB.prepare("SELECT deleted FROM assets WHERE key = ?1").bind(key).first<{ deleted: number }>())?.deleted;

describe("sweepOrphanScreenshots", () => {
  beforeEach(resetStorage);

  it("deletes screenshots without a report after 24 hours and keeps the ones a report lists", async () => {
    const old = ORPHAN_SCREENSHOT_MS + 60_000;
    await asset("demo/sent.webp", SENT, "screenshot", old);
    await asset("demo/replaced.webp", SENT, "screenshot", old); // its markup replaced it before Send
    await asset("demo/abandoned.webp", ABANDONED, "screenshot", old);
    await asset("demo/fresh.webp", ABANDONED, "screenshot", 60_000); // the draft may still be sent
    await asset("demo/picked.png", ABANDONED, "upload", old); // a picked file keeps the project's retention
    await report(SENT, ["demo/sent.webp"]);

    expect(await sweepOrphanScreenshots(gw, NOW)).toBe(2);
    expect(await deleted("demo/sent.webp")).toBe(0);
    expect(await deleted("demo/replaced.webp")).toBe(1);
    expect(await deleted("demo/abandoned.webp")).toBe(1);
    expect(await deleted("demo/fresh.webp")).toBe(0);
    expect(await deleted("demo/picked.png")).toBe(0);
    expect(await gw.UPLOADS.get("demo/abandoned.webp")).toBeNull();
    expect(await gw.UPLOADS.get("demo/sent.webp")).not.toBeNull();
    expect(await sweepOrphanScreenshots(gw, NOW)).toBe(0); // idempotent
  });

  it("survives a report row whose payload is not JSON", async () => {
    await asset("demo/abandoned.webp", ABANDONED, "screenshot", ORPHAN_SCREENSHOT_MS + 60_000);
    await gw.DB.prepare(
      "INSERT INTO feedback (id, project_id, outcome, payload, issue_url, created_at, type, title, llm_provider, llm_model, config_version, updated_at, client_feedback_id) VALUES ('x', 'demo', 'created', 'not json', NULL, ?1, 'bug', 't', 'off', NULL, 1, ?1, ?2)",
    )
      .bind(NOW, ABANDONED)
      .run();
    expect(await sweepOrphanScreenshots(gw, NOW)).toBe(1);
  });
});
