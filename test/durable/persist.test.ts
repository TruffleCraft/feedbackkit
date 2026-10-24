import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { resetStorage, failingFeedbackWrites } from "./reset.js";
import { orchestrateFeedback } from "../../src/worker/orchestrate.js";
import { FeedbackConfig, FeedbackPayload } from "../../src/shared/contract.js";
import type { ChatFn } from "../../src/worker/llm/client.js";
import type { FetchFn } from "../../src/worker/providers/github.js";
import type { Env } from "../../src/worker/env.js";

// #108 against a real local D1 with the repo's migrations: a report that was not
// delivered is acknowledged only once its row exists, and one submission is one
// row per project.

const FID = "33333333-3333-4333-8333-333333333333";
const config = (projectId = "demo") =>
  FeedbackConfig.parse({
    projectId,
    templates: [
      { type: "bug", label: "Bug", fields: [], tracker: { labels: ["type/bug"] } },
      { type: "praise", label: "Praise", fields: [], noIssue: true },
    ],
    llm: { provider: "off" },
    tracker: { kind: "github", defaultRepo: "acme/site", patSecret: "GITHUB_PAT_default" },
    auth: { origins: [] },
  });
const payload = (over: Record<string, unknown> = {}) => FeedbackPayload.parse({ v: 1, feedbackId: FID, type: "bug", message: "Saving fails", pageUrl: "https://acme.dev/x", ...over });
const noChat: ChatFn = async () => {
  throw new Error("LLM off");
};
const github = (status: number): FetchFn => async () =>
  status === 201 ? new Response(JSON.stringify({ html_url: "https://github.com/acme/site/issues/7", number: 7 }), { status }) : new Response("down", { status });
const gwEnv = (pat = true) => ({ ...env, ...(pat ? { GITHUB_PAT_default: "tok" } : {}) }) as unknown as Env;
let n = 0;
const deps = (status: number) => ({ chat: noChat, fetchImpl: github(status), newId: () => `row-${++n}` });

const rows = (projectId = "demo") =>
  env.DB.prepare("SELECT id, outcome, issue_url, client_feedback_id FROM feedback WHERE project_id = ?1 ORDER BY created_at, id").bind(projectId).all<{ id: string; outcome: string; issue_url: string | null; client_feedback_id: string }>();

describe("undelivered reports are stored before they are acknowledged", () => {
  beforeEach(resetStorage);

  it("noIssue: the row exists with the client feedbackId, a resend replays the same id", async () => {
    const first = await orchestrateFeedback(gwEnv(), { config: config(), version: 1 }, payload({ type: "praise" }), deps(201));
    expect(first).toMatchObject({ http: 200, body: { status: "created" } });
    const again = await orchestrateFeedback(gwEnv(), { config: config(), version: 1 }, payload({ type: "praise" }), deps(201));
    expect(again.body).toEqual(first.body);
    const { results } = await rows();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: (first.body as { id: string }).id, client_feedback_id: FID, issue_url: null });
  });

  it("a resent issue_failed submission stays one row, and a later delivery upgrades it", async () => {
    const a = await orchestrateFeedback(gwEnv(), { config: config(), version: 1 }, payload(), deps(500));
    const b = await orchestrateFeedback(gwEnv(false), { config: config(), version: 1 }, payload(), deps(201));
    expect(a.body).toMatchObject({ status: "issue_failed" });
    expect(b.body).toMatchObject({ status: "issue_failed", id: (a.body as { id: string }).id });
    expect((await rows()).results).toHaveLength(1);

    const c = await orchestrateFeedback(gwEnv(), { config: config(), version: 1 }, payload(), deps(201));
    expect(c.body).toMatchObject({ status: "created", id: (a.body as { id: string }).id });
    const { results } = await rows();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ outcome: "created", issue_url: "https://github.com/acme/site/issues/7" });
  });

  it("dedup is scoped per project: the same feedbackId in two projects is two rows", async () => {
    await orchestrateFeedback(gwEnv(), { config: config("one"), version: 1 }, payload({ type: "praise" }), deps(201));
    // The dedup table is global; clear it so the second project reaches persist.
    await env.DB.prepare("DELETE FROM dedup").run();
    const two = await orchestrateFeedback(gwEnv(), { config: config("two"), version: 1 }, payload({ type: "praise" }), deps(201));
    expect(two.body).toMatchObject({ status: "created" });
    expect((await rows("one")).results).toHaveLength(1);
    expect((await rows("two")).results).toHaveLength(1);
  });

  it("noIssue with a failing D1 write answers 503 FK_PERSIST_FAILED and stores no dedup entry", async () => {
    const r = await orchestrateFeedback(failingFeedbackWrites(gwEnv()), { config: config(), version: 1 }, payload({ type: "praise" }), deps(201));
    expect(r).toMatchObject({ http: 503, headers: { "Retry-After": "5" }, body: { status: "error", code: "FK_PERSIST_FAILED", retryable: true } });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM dedup").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("tracker failure with a failing D1 write answers 503, not issue_failed", async () => {
    const r = await orchestrateFeedback(failingFeedbackWrites(gwEnv()), { config: config(), version: 1 }, payload(), deps(500));
    expect(r).toMatchObject({ http: 503, body: { code: "FK_PERSIST_FAILED" } });
  });

  it("a delivered issue stays a success when the journey write fails", async () => {
    const r = await orchestrateFeedback(failingFeedbackWrites(gwEnv()), { config: config(), version: 1 }, payload(), deps(201));
    expect(r).toMatchObject({ http: 200, body: { status: "created" } });
  });
});
