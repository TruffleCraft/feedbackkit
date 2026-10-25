import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { createTestReport, orchestrateFeedback } from "../../src/worker/orchestrate.js";
import { deliverRow, deliveryMarker } from "../../src/worker/delivery.js";
import { checkProject } from "../../src/worker/project-check.js";
import { FeedbackConfig, FeedbackPayload } from "../../src/shared/contract.js";
import type { ChatFn } from "../../src/worker/llm/client.js";
import type { FetchFn } from "../../src/worker/providers/github.js";
import type { Env } from "../../src/worker/env.js";
import { resetStorage } from "./reset.js";

// #110 against a real local D1: GitHub Project delivery with its state machine.
// GitHub is a scripted fake keyed by method and path.

const FID = "44444444-4444-4444-8444-444444444444";
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const config = (over: Record<string, unknown> = {}) =>
  FeedbackConfig.parse({
    projectId: "demo",
    delivery: "project",
    templates: [{ type: "bug", label: "Bug", fields: [] }],
    llm: { provider: "off" },
    tracker: { kind: "github", patSecret: "GITHUB_PAT_default", project: { org: "acme", number: 3, typeOptions: { bug: "Bug" } } },
    storage: { kind: "r2", publicBaseUrl: "https://cdn.example", retentionDays: 30 },
    auth: { origins: [] },
    ...over,
  });
const payload = (over: Record<string, unknown> = {}) =>
  FeedbackPayload.parse({ v: 1, feedbackId: FID, type: "bug", message: "Export button is gone", pageUrl: "https://acme.dev/reports", attachmentKeys: ["demo/shot.png"], ...over });
const noChat: ChatFn = async () => {
  throw new Error("LLM off");
};
const gw = { ...env, GITHUB_PAT_default: "tok" } as unknown as Env;

const FIELDS = [
  { id: 1, name: "Type", data_type: "single_select", options: [{ id: "opt-bug", name: { raw: "Bug", html: "Bug" } }] },
  { id: 2, name: "Page", data_type: "text" },
  { id: 3, name: "Source", data_type: "single_select", options: [{ id: "opt-fk", name: { raw: "FeedbackKit", html: "FeedbackKit" } }] },
];

interface Call {
  method: string;
  path: string;
  body: unknown;
}
function github(script: { draft?: number | "throw"; fields?: unknown[]; items?: unknown[] } = {}) {
  const calls: Call[] = [];
  const fetchImpl: FetchFn = async (url, init) => {
    const path = url.replace("https://api.github.com", "");
    const method = init.method ?? "GET";
    calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "POST" && path.endsWith("/drafts")) {
      if (script.draft === "throw") throw new Error("socket hang up");
      const status = script.draft ?? 201;
      return status === 201 ? new Response(JSON.stringify({ id: 9001, content_type: "DraftIssue" }), { status }) : new Response("no", { status });
    }
    if (method === "GET" && path.includes("/fields")) return new Response(JSON.stringify(script.fields ?? FIELDS), { status: 200 });
    if (method === "PATCH") return new Response("{}", { status: 200 });
    if (method === "GET" && path.includes("/items")) return new Response(JSON.stringify(script.items ?? []), { status: 200 });
    return new Response("unexpected", { status: 500 });
  };
  return { fetchImpl, calls, drafts: () => calls.filter((c) => c.method === "POST") };
}

const send = (gh: ReturnType<typeof github>, over: Record<string, unknown> = {}) =>
  orchestrateFeedback(gw, { config: config(over), version: 1 }, payload(), { chat: noChat, fetchImpl: gh.fetchImpl, now: NOW, origin: "https://fk.example" });
const row = () =>
  env.DB.prepare("SELECT id, outcome, delivery, delivery_state, project_item_id, project_url, delivery_warnings, retry_count, last_error, claim_token FROM feedback WHERE client_feedback_id = ?1")
    .bind(FID)
    .first<Record<string, unknown>>();

describe("GitHub Project delivery", () => {
  beforeEach(resetStorage);

  it("201 → delivered: draft with marker and a signed-in screenshot link, fields set, widget sees created", async () => {
    const gh = github();
    const r = await send(gh);
    expect(r).toMatchObject({ http: 200, body: { status: "created" } });
    expect((r.body as { issueUrl?: string }).issueUrl).toBeUndefined();
    const stored = await row();
    expect(stored).toMatchObject({ outcome: "created", delivery: "project", delivery_state: "delivered", project_item_id: "9001", project_url: "https://github.com/orgs/acme/projects/3", delivery_warnings: null, claim_token: null });
    const draft = gh.drafts()[0]!;
    expect(draft.path).toBe("/orgs/acme/projectsV2/3/drafts");
    const body = (draft.body as { body: string }).body;
    expect(body).toContain(deliveryMarker(String(stored!["id"])));
    expect(body).toContain("https://fk.example/admin/assets/demo/shot.png");
    expect(body).not.toContain("cdn.example"); // never the public bearer link
    const patch = gh.calls.find((c) => c.method === "PATCH")!;
    expect(patch.path).toBe("/orgs/acme/projectsV2/3/items/9001");
    expect(patch.body).toEqual({ fields: [{ id: 1, value: "opt-bug" }, { id: 2, value: "https://acme.dev/reports" }, { id: 3, value: "opt-fk" }] });
  });

  it("missing fields and options only add warnings", async () => {
    const gh = github({ fields: [{ id: 1, name: "Type", data_type: "single_select", options: [] }] });
    const r = await send(gh);
    expect(r.body).toMatchObject({ status: "created" });
    const stored = await row();
    expect(stored!["delivery_state"]).toBe("delivered");
    expect(JSON.parse(String(stored!["delivery_warnings"]))).toEqual(['option "Bug" not found in field "Type"', 'field "Page" not found', 'field "Source" not found']);
  });

  it("a definite refusal (4xx) → failed, saved as issue_failed; a retry delivers it", async () => {
    const r = await send(github({ draft: 403 }));
    expect(r.body).toMatchObject({ status: "issue_failed" });
    expect(await row()).toMatchObject({ delivery_state: "failed", outcome: "issue_failed" });
    const fixed = github();
    const again = await deliverRow(gw, String((await row())!["id"]), { retry: true, fetchImpl: fixed.fetchImpl, now: NOW + 1000 });
    expect(again).toMatchObject({ status: "delivered", itemId: 9001 });
    expect(await row()).toMatchObject({ delivery_state: "delivered", outcome: "created", retry_count: 1, last_error: null });
  });

  it("an uncertain outcome is reconciled by marker before anything is created again", async () => {
    await send(github({ draft: "throw" }));
    const id = String((await row())!["id"]);
    expect(await row()).toMatchObject({ delivery_state: "unknown" });

    // Found: linked, no second draft.
    const found = github({ items: [{ id: 77, content_type: "DraftIssue", content: { body: `text\n\n${deliveryMarker(id)}` } }] });
    expect(await deliverRow(gw, id, { retry: true, fetchImpl: found.fetchImpl, now: NOW + 1000 })).toMatchObject({ status: "delivered", itemId: 77, reconciled: true });
    expect(found.drafts()).toHaveLength(0);
  });

  it("nothing found by marker → the operator decides; createAnyway creates it", async () => {
    await send(github({ draft: 502 }));
    const id = String((await row())!["id"]);
    const none = github({ items: [{ id: 5, content_type: "DraftIssue", content: { body: "someone else" } }] });
    expect(await deliverRow(gw, id, { retry: true, fetchImpl: none.fetchImpl, now: NOW + 1000 })).toEqual({ status: "unknown_needs_decision" });
    expect(none.drafts()).toHaveLength(0);
    expect(await row()).toMatchObject({ delivery_state: "unknown", claim_token: null }); // claim released

    const anyway = github();
    expect(await deliverRow(gw, id, { retry: true, createAnyway: true, fetchImpl: anyway.fetchImpl, now: NOW + 2000 })).toMatchObject({ status: "delivered" });
    expect(anyway.drafts()).toHaveLength(1);
  });

  it("a client resend after an uncertain outcome never creates a second draft", async () => {
    await send(github({ draft: "throw" }));
    const resend = github();
    const r = await send(resend);
    expect(r.body).toMatchObject({ status: "issue_failed" });
    expect(resend.drafts()).toHaveLength(0);
  });

  it("a held claim answers busy", async () => {
    await send(github({ draft: 403 }));
    const id = String((await row())!["id"]);
    await env.DB.prepare("UPDATE feedback SET claim_token = 'other', claim_until = ?1 WHERE id = ?2").bind(NOW + 60_000, id).run();
    const gh = github();
    expect(await deliverRow(gw, id, { retry: true, fetchImpl: gh.fetchImpl, now: NOW })).toEqual({ status: "busy", claimUntil: NOW + 60_000 });
    expect(gh.calls).toHaveLength(0);
  });

  it("a late delivery keeps the screenshots reachable for 7 more days", async () => {
    await env.DB.prepare("INSERT INTO assets (key, project_id, feedback_id, kind, expires_at, created_at) VALUES ('demo/shot.png', 'demo', ?1, 'screenshot', ?2, ?3)")
      .bind(FID, NOW + 30 * DAY, NOW)
      .run();
    await send(github({ draft: 403 }));
    const late = NOW + 29 * DAY;
    await deliverRow(gw, String((await row())!["id"]), { retry: true, fetchImpl: github().fetchImpl, now: late });
    const a = await env.DB.prepare("SELECT expires_at FROM assets WHERE key = 'demo/shot.png'").first<{ expires_at: number }>();
    expect(a!.expires_at).toBe(late + 7 * DAY);
  });

  it("a local row is not retryable", async () => {
    await orchestrateFeedback(gw, { config: config({ delivery: "local" }), version: 1 }, payload(), { chat: noChat, now: NOW });
    expect(await deliverRow(gw, String((await row())!["id"]), { retry: true })).toMatchObject({ status: "not_retryable" });
  });
});

describe("test report and the System check", () => {
  beforeEach(resetStorage);

  it("a delivered test report is is_test, and proves draft writing", async () => {
    const cfg = config();
    const gh = github({ fields: [FIELDS[0]] });
    const before = await checkProject(gw, cfg, gh.fetchImpl);
    expect(before).toMatchObject({ fieldsReadable: true, draftWriteVerified: null, missing: ['field "Page"', 'field "Source"'] });

    const r = await createTestReport(gw, { config: cfg, version: 1 }, cfg.templates[0]!, { fetchImpl: gh.fetchImpl, now: NOW, origin: "https://fk.example" });
    expect(r.body).toMatchObject({ status: "created" });
    const t = await env.DB.prepare("SELECT is_test, delivery_state FROM feedback WHERE project_id = 'demo'").first();
    expect(t).toEqual({ is_test: 1, delivery_state: "delivered" });
    expect((await checkProject(gw, cfg, gh.fetchImpl))!.draftWriteVerified).toBe(NOW);
  });

  it("names a missing organisation project and a token without access", async () => {
    const notFound: FetchFn = async () => new Response("nope", { status: 404 });
    expect(await checkProject(gw, config(), notFound)).toMatchObject({ fieldsReadable: false, reason: expect.stringContaining("organisation project") });
    const noPat = await checkProject({ ...env } as unknown as Env, config());
    expect(noPat).toMatchObject({ patPresent: false, fieldsReadable: null });
  });
});
