import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { resetStorage } from "./reset.js";
import { pruneExpiredRecords, retentionNotice } from "../../src/worker/storage/retention.js";
import type { Env } from "../../src/worker/env.js";

// #108: retention stays strict (handled and unhandled rows go at retentionDays)
// and takes the row's R2 assets with it; unhandled rows due within 7 days are
// listed beforehand. Real D1 and R2.

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const gw = env as unknown as Env;

async function project(id: string, retentionDays?: number) {
  const config = JSON.stringify({ projectId: id, storage: retentionDays ? { kind: "r2", retentionDays } : { kind: "r2" } });
  await env.DB.prepare("INSERT INTO projects (id, public_key, config, updated_at) VALUES (?1, ?2, ?3, 0)").bind(id, `fk_pub_${id}`, config).run();
}

async function report(projectId: string, id: string, ageDays: number, opts: { issueUrl?: string; asset?: boolean } = {}) {
  const clientId = `client-${id}`;
  await env.DB.prepare(
    "INSERT INTO feedback (id, project_id, outcome, payload, issue_url, created_at, type, client_feedback_id) VALUES (?1, ?2, ?3, '{}', ?4, ?5, 'bug', ?6)",
  )
    .bind(id, projectId, opts.issueUrl ? "created" : "issue_failed", opts.issueUrl ?? null, NOW - ageDays * DAY, clientId)
    .run();
  if (opts.asset) {
    const key = `${projectId}/${id}.png`;
    await env.UPLOADS.put(key, "png");
    await env.DB.prepare("INSERT INTO assets (key, project_id, feedback_id, kind, expires_at, created_at) VALUES (?1, ?2, ?3, 'screenshot', NULL, ?4)")
      .bind(key, projectId, clientId, NOW - ageDays * DAY)
      .run();
  }
}

const ids = async (projectId: string) =>
  ((await env.DB.prepare("SELECT id FROM feedback WHERE project_id = ?1 ORDER BY id").bind(projectId).all<{ id: string }>()).results ?? []).map((r) => r.id);

describe("pruneExpiredRecords", () => {
  beforeEach(async () => {
    await resetStorage();
    await project("strict", 30);
    await project("keep");
  });

  it("deletes handled and unhandled rows past retentionDays together with their R2 assets", async () => {
    await report("strict", "old-handled", 31, { issueUrl: "https://github.com/a/b/issues/1", asset: true });
    await report("strict", "old-unhandled", 40, { asset: true });
    await report("strict", "fresh", 29, { asset: true });
    await report("keep", "ancient", 400, { asset: true });

    const r = await pruneExpiredRecords(gw, NOW);

    expect(r).toMatchObject({ feedback: 2, assets: 2 });
    expect(await ids("strict")).toEqual(["fresh"]);
    expect(await ids("keep")).toEqual(["ancient"]);
    expect(await env.UPLOADS.get("strict/old-handled.png")).toBeNull();
    expect(await env.UPLOADS.get("strict/old-unhandled.png")).toBeNull();
    expect(await env.UPLOADS.get("strict/fresh.png")).not.toBeNull();
    expect(await env.UPLOADS.get("keep/ancient.png")).not.toBeNull();
    const marked = await env.DB.prepare("SELECT key FROM assets WHERE deleted = 1 ORDER BY key").all<{ key: string }>();
    expect(marked.results.map((a) => a.key)).toEqual(["strict/old-handled.png", "strict/old-unhandled.png"]);
  });

  it("only touches assets of the row's own project", async () => {
    await report("strict", "old", 31);
    // Same client id, other project: must survive.
    await env.UPLOADS.put("keep/other.png", "png");
    await env.DB.prepare("INSERT INTO assets (key, project_id, feedback_id, kind, created_at) VALUES ('keep/other.png', 'keep', 'client-old', 'upload', 0)").run();
    await pruneExpiredRecords(gw, NOW);
    expect(await ids("strict")).toEqual([]);
    expect(await env.UPLOADS.get("keep/other.png")).not.toBeNull();
  });
});

describe("retentionNotice", () => {
  beforeEach(resetStorage);

  it("lists unhandled rows that retention deletes within 7 days, oldest first, without content", async () => {
    await project("strict", 30);
    await report("strict", "due-in-1", 29);
    await report("strict", "due-in-6", 24);
    await report("strict", "due-in-8", 22);
    await report("strict", "handled", 29, { issueUrl: "https://github.com/a/b/issues/2" });

    const n = await retentionNotice(gw, "strict", 30, NOW);
    expect(n).toMatchObject({ retentionDays: 30, dueSoon: 2 });
    expect(n!.items.map((i) => i.id)).toEqual(["due-in-1", "due-in-6"]);
    expect(n!.items[0]).toEqual({ id: "due-in-1", type: "bug", outcome: "issue_failed", createdAt: NOW - 29 * DAY, deletesAt: NOW + DAY });
  });

  it("is null for a project without retentionDays", async () => {
    expect(await retentionNotice(gw, "keep", undefined, NOW)).toBeNull();
  });
});
