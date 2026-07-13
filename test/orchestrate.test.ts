import { describe, it, expect } from "vitest";
import { orchestrateFeedback } from "../src/worker/orchestrate.js";
import { FeedbackConfig, FeedbackPayload } from "../src/shared/contract.js";
import type { ChatFn } from "../src/worker/llm/client.js";
import type { FetchFn } from "../src/worker/providers/github.js";
import type { Env } from "../src/worker/env.js";
import type { LoadedProject } from "../src/worker/config.js";

const baseConfig = (over: Record<string, unknown> = {}) =>
  FeedbackConfig.parse({
    projectId: "demo",
    locale: "de",
    templates: [
      {
        type: "bug",
        label: "Bug",
        fields: [
          { key: "repro", label: "Schritte", kind: "longtext", required: true },
          { key: "expected", label: "Erwartet", kind: "longtext", required: true },
          { key: "actual", label: "Tatsächlich", kind: "longtext", required: true },
        ],
        tracker: { labels: ["type/bug"] },
      },
      { type: "praise", label: "Lob", fields: [], noIssue: true },
    ],
    llm: { provider: "openrouter", model: "m" },
    tracker: { kind: "github", defaultRepo: "acme/site", patSecret: "GITHUB_PAT_default" },
    auth: { origins: [] },
    storage: { kind: "r2", publicBaseUrl: "https://cdn.x" },
    ...over,
  });

const loaded = (config = baseConfig()): LoadedProject => ({ config, version: 1 });

const UUID = "11111111-1111-4111-8111-111111111111";
const payload = (over: Record<string, unknown> = {}) =>
  FeedbackPayload.parse({ v: 1, feedbackId: UUID, type: "bug", message: "Speichern kaputt", pageUrl: "https://acme.dev", ...over });

// Stateful D1 fake: dedup replay + records feedback/dedup writes.
function fakeDb(opts: { dedupThrows?: boolean } = {}) {
  const dedup = new Map<string, string>();
  const feedback: Array<{ id: unknown; outcome: unknown; issueUrl: unknown }> = [];
  const db = {
    prepare(sql: string) {
      let params: unknown[] = [];
      const stmt = {
        bind: (...a: unknown[]) => {
          params = a;
          return stmt;
        },
        first: async () => {
          if (sql.includes("FROM dedup")) {
            if (opts.dedupThrows) throw new Error("D1 down");
            const r = dedup.get(String(params[0]));
            return r ? { response: r } : null;
          }
          return null;
        },
        run: async () => {
          if (sql.includes("INSERT INTO dedup")) dedup.set(String(params[0]), String(params[1]));
          if (sql.includes("INSERT INTO feedback")) feedback.push({ id: params[0], outcome: params[2], issueUrl: params[4] });
          return { success: true };
        },
        all: async () => ({ results: [] }),
      };
      return stmt as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
  return { db, dedup, feedback };
}

const env = (db: D1Database, over: Record<string, unknown> = {}): Env => ({ DB: db, GITHUB_PAT_default: "tok", ...over }) as unknown as Env;

const chatReturning = (obj: object): ChatFn => async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj) } }] }), { status: 200 });
const chatText = (content: string): ChatFn => async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
const chatMustNotRun: ChatFn = async () => {
  throw new Error("LLM must not be called on this path");
};

function ghCapture(status = 201) {
  const calls: Array<{ url: string; body: { title: string; body: string; labels: string[] } }> = [];
  const fetchImpl: FetchFn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body as string) });
    return status === 201
      ? new Response(JSON.stringify({ html_url: "https://github.com/acme/site/issues/1", number: 1 }), { status: 201 })
      : new Response("err", { status });
  };
  return { fetchImpl, calls };
}

describe("orchestrateFeedback — POST-1", () => {
  it("creates an issue when the LLM extracts every required field", async () => {
    const db = fakeDb();
    const gh = ghCapture();
    const r = await orchestrateFeedback(env(db.db), loaded(), payload(), {
      apiKey: "k",
      chat: chatReturning({ type: "bug", summary: "Speichern kaputt", repro: "klick", expected: "gespeichert", actual: "hängt" }),
      fetchImpl: gh.fetchImpl,
      now: 1000,
      newId: () => "fid1",
    });
    expect(r.body).toMatchObject({ status: "created", issueUrl: "https://github.com/acme/site/issues/1" });
    expect(gh.calls[0]!.body.title).toBe("[BUG] Speichern kaputt");
    expect(db.feedback[0]).toMatchObject({ outcome: "created" });
    expect(db.dedup.has(UUID)).toBe(true); // terminal success is idempotency-stored
  });

  it("asks for missing required fields (need_fields) and creates no issue", async () => {
    const db = fakeDb();
    const gh = ghCapture();
    const r = await orchestrateFeedback(env(db.db), loaded(), payload(), {
      apiKey: "k",
      chat: chatReturning({ type: "bug", summary: "s", repro: "klick", expected: "", actual: "" }),
      fetchImpl: gh.fetchImpl,
    });
    expect(r.body.status).toBe("need_fields");
    expect((r.body as { missing: string[] }).missing.sort()).toEqual(["actual", "expected"]);
    expect(gh.calls).toHaveLength(0);
    expect(db.dedup.size).toBe(0); // need_fields is NOT terminal
  });

  it("create-anyway on LLM failure: accepted_incomplete + ai-failed label", async () => {
    const db = fakeDb();
    const gh = ghCapture();
    const r = await orchestrateFeedback(env(db.db), loaded(), payload(), {
      apiKey: "k",
      chat: chatText("sorry, cannot"),
      fetchImpl: gh.fetchImpl,
    });
    expect(r.body.status).toBe("accepted_incomplete");
    expect(gh.calls[0]!.body.labels).toEqual(expect.arrayContaining(["ai-failed", "needs-triage"]));
    expect(db.feedback[0]).toMatchObject({ outcome: "ai-failed" });
  });

  it("required-field mode (LLM off / no key): asks all required, no LLM call", async () => {
    const db = fakeDb();
    const gh = ghCapture();
    const r = await orchestrateFeedback(env(db.db), loaded(), payload(), { chat: chatMustNotRun, fetchImpl: gh.fetchImpl });
    expect(r.body.status).toBe("need_fields");
    expect((r.body as { missing: string[] }).missing.sort()).toEqual(["actual", "expected", "repro"]);
    expect(gh.calls).toHaveLength(0);
  });

  it("field-ceiling: >3 missing with onIncomplete → accepted_incomplete instead of a wall of questions", async () => {
    const cfg = baseConfig({
      templates: [
        {
          type: "bug",
          label: "Bug",
          fields: ["a", "b", "c", "d"].map((k) => ({ key: k, label: k, kind: "longtext", required: true })),
          tracker: { labels: [] },
        },
      ],
    });
    const db = fakeDb();
    const gh = ghCapture();
    const r = await orchestrateFeedback(env(db.db), loaded(cfg), payload(), {
      apiKey: "k",
      chat: chatReturning({ type: "bug", summary: "s", a: "", b: "", c: "", d: "" }),
      fetchImpl: gh.fetchImpl,
    });
    expect(r.body.status).toBe("accepted_incomplete");
  });
});

describe("orchestrateFeedback — POST-2 (deterministic, no LLM)", () => {
  it("creates from completed fields without an LLM call", async () => {
    const db = fakeDb();
    const gh = ghCapture();
    const r = await orchestrateFeedback(env(db.db), loaded(), payload({ fields: { repro: "k", expected: "e", actual: "a" }, extracted: {} }), {
      apiKey: "k",
      chat: chatMustNotRun,
      fetchImpl: gh.fetchImpl,
    });
    expect(r.body.status).toBe("created");
    expect(gh.calls).toHaveLength(1);
  });

  it("still-missing + createAnyway.onIncomplete → accepted_incomplete", async () => {
    const db = fakeDb();
    const gh = ghCapture();
    const r = await orchestrateFeedback(env(db.db), loaded(), payload({ fields: { repro: "k" }, extracted: {} }), {
      apiKey: "k",
      chat: chatMustNotRun,
      fetchImpl: gh.fetchImpl,
    });
    expect(r.body.status).toBe("accepted_incomplete");
  });

  it("still-missing + onIncomplete=false → keeps asking (need_fields)", async () => {
    const cfg = baseConfig({ createAnyway: { onIncomplete: false, onLlmError: true } });
    const db = fakeDb();
    const gh = ghCapture();
    const r = await orchestrateFeedback(env(db.db), loaded(cfg), payload({ fields: { repro: "k" }, extracted: {} }), {
      apiKey: "k",
      chat: chatMustNotRun,
      fetchImpl: gh.fetchImpl,
    });
    expect(r.body.status).toBe("need_fields");
    expect(gh.calls).toHaveLength(0);
  });
});

describe("orchestrateFeedback — create-anyway on tracker/D1 failure", () => {
  it("tracker create fails → issue_failed, payload persisted, NOT dedup-stored (retryable)", async () => {
    const db = fakeDb();
    const gh = ghCapture(500);
    const r = await orchestrateFeedback(env(db.db), loaded(), payload({ fields: { repro: "k", expected: "e", actual: "a" } }), {
      apiKey: "k",
      chat: chatMustNotRun,
      fetchImpl: gh.fetchImpl,
      newId: () => "fid-f",
    });
    expect(r.body.status).toBe("issue_failed");
    expect(db.feedback[0]).toMatchObject({ outcome: "issue_failed", issueUrl: null });
    expect(db.dedup.size).toBe(0);
  });

  it("missing PAT → issue_failed without a tracker call", async () => {
    const db = fakeDb();
    const gh = ghCapture();
    const r = await orchestrateFeedback({ DB: db.db } as unknown as Env, loaded(), payload({ fields: { repro: "k", expected: "e", actual: "a" } }), {
      apiKey: "k",
      chat: chatMustNotRun,
      fetchImpl: gh.fetchImpl,
    });
    expect(r.body.status).toBe("issue_failed");
    expect((r.body as { reason: string }).reason).toContain("credential");
    expect(gh.calls).toHaveLength(0);
  });

  it("D1 dedup read down → still creates, tags the issue d1-degraded", async () => {
    const db = fakeDb({ dedupThrows: true });
    const gh = ghCapture();
    const r = await orchestrateFeedback(env(db.db), loaded(), payload({ fields: { repro: "k", expected: "e", actual: "a" } }), {
      apiKey: "k",
      chat: chatMustNotRun,
      fetchImpl: gh.fetchImpl,
    });
    expect(["created", "accepted_incomplete"]).toContain(r.body.status);
    expect(gh.calls[0]!.body.labels).toContain("d1-degraded");
  });
});

describe("orchestrateFeedback — idempotency & noIssue", () => {
  it("replays the stored response for a repeated feedbackId (no second issue)", async () => {
    const db = fakeDb();
    const gh = ghCapture();
    const deps = { apiKey: "k", chat: chatReturning({ type: "bug", summary: "s", repro: "k", expected: "e", actual: "a" }), fetchImpl: gh.fetchImpl, newId: () => "fid-i" };
    const first = await orchestrateFeedback(env(db.db), loaded(), payload(), deps);
    const second = await orchestrateFeedback(env(db.db), loaded(), payload(), { ...deps, chat: chatMustNotRun });
    expect(second.body).toEqual(first.body);
    expect(gh.calls).toHaveLength(1); // second call replayed from dedup
  });

  it("noIssue template (praise) persists only, no tracker call", async () => {
    const db = fakeDb();
    const gh = ghCapture();
    const r = await orchestrateFeedback(env(db.db), loaded(), payload({ type: "praise", message: "super!" }), {
      chat: chatMustNotRun,
      fetchImpl: gh.fetchImpl,
      newId: () => "fid-p",
    });
    expect(r.body).toMatchObject({ status: "created" });
    expect((r.body as { issueUrl?: string }).issueUrl).toBeUndefined();
    expect(gh.calls).toHaveLength(0);
    expect(db.feedback[0]).toMatchObject({ outcome: "created" });
  });
});
