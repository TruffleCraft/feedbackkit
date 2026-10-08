import { describe, it, expect } from "vitest";
import { orchestrateFeedback, dryRunPreview } from "../src/worker/orchestrate.js";
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
function fakeDb(opts: { dedupThrows?: boolean; counterCount?: number } = {}) {
  const dedup = new Map<string, string>();
  const feedback: Array<{ id: unknown; outcome: unknown; issueUrl: unknown; row: Record<string, unknown> }> = [];
  const db = {
    prepare(sql: string) {
      let params: unknown[] = [];
      const stmt = {
        bind: (...a: unknown[]) => {
          params = a;
          return stmt;
        },
        first: async () => {
          if (sql.includes("counters")) return { count: opts.counterCount ?? 1 }; // rate-limit/budget upsert RETURNING
          if (sql.includes("FROM dedup")) {
            if (opts.dedupThrows) throw new Error("D1 down");
            const r = dedup.get(String(params[0]));
            return r ? { response: r } : null;
          }
          return null;
        },
        run: async () => {
          if (sql.includes("INSERT INTO dedup")) dedup.set(String(params[0]), String(params[1]));
          if (sql.includes("INSERT INTO feedback")) {
            // Column list of the INSERT, zipped with its bound values.
            const cols = sql.slice(sql.indexOf("(") + 1, sql.indexOf(")")).split(",").map((c) => c.trim());
            const row = Object.fromEntries(cols.map((c, i) => [c, params[i]]));
            feedback.push({ id: params[0], outcome: params[2], issueUrl: params[4], row });
          }
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

// Two idea-like types the user cannot tell apart: something new vs. a change to something that exists.
const ideaConfig = () =>
  baseConfig({
    templates: [
      { type: "feature", label: "Feature request", fields: [{ key: "problem", label: "Problem", kind: "longtext", required: true }], tracker: { labels: ["type/feature"] } },
      { type: "improvement", label: "Change request", fields: [{ key: "what", label: "Was", kind: "longtext", required: true }], tracker: { labels: ["type/improvement"] } },
    ],
  });
const capturingChat = (obj: object, seen: { prompt: string; schema?: { required: string[] } }): ChatFn => async (req) => {
  const body = JSON.parse((req as { init: { body: string } }).init.body);
  seen.prompt = body.messages[1].content;
  seen.schema = body.response_format?.json_schema?.schema;
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj) } }] }), { status: 200 });
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
      chat: chatReturning({ type: "bug", summary: "Saving fails", repro: "klick", expected: "gespeichert", actual: "hängt" }),
      fetchImpl: gh.fetchImpl,
      now: 1000,
      newId: () => "fid1",
    });
    expect(r.body).toMatchObject({ status: "created", issueUrl: "https://github.com/acme/site/issues/1", type: "bug", summary: "Saving fails" });
    expect(gh.calls[0]!.body.title).toBe("[BUG] Saving fails");
    expect(db.feedback[0]).toMatchObject({ outcome: "created" });
    expect(db.dedup.has(UUID)).toBe(true); // terminal success is idempotency-stored
  });

  it("reads the screenshot from R2 and sends it to the LLM as a base64 data URL + page context", async () => {
    const db = fakeDb();
    const gh = ghCapture();
    const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
    const uploads = {
      get: async (key: string) =>
        key === "demo/shot.webp" ? { arrayBuffer: async () => bytes.buffer, httpMetadata: { contentType: "image/webp" } } : null,
    };
    let seen: { messages: Array<{ content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> }> } | undefined;
    const chat: ChatFn = async (req) => {
      seen = JSON.parse((req as { init: { body: string } }).init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ type: "bug", summary: "s", repro: "k", expected: "e", actual: "a" }) } }] }), { status: 200 });
    };
    await orchestrateFeedback(env(db.db, { UPLOADS: uploads }), loaded(), payload({ attachmentKeys: ["demo/shot.webp"] }), { apiKey: "k", chat, fetchImpl: gh.fetchImpl });
    const content = seen!.messages[1]!.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(content.find((c) => c.type === "image_url")?.image_url?.url).toMatch(/^data:image\/webp;base64,/);
    expect(content.find((c) => c.type === "text")?.text).toContain("https://acme.dev"); // pageUrl reached the model
  });

  it("asks ONE conversational follow-up (follow_up), no issue yet", async () => {
    const db = fakeDb();
    const gh = ghCapture();
    const r = await orchestrateFeedback(env(db.db), loaded(), payload(), {
      apiKey: "k",
      chat: chatReturning({ type: "bug", summary: "s", repro: "klick", expected: "", actual: "", followUpQuestion: "Was hast du erwartet und was ist passiert?" }),
      fetchImpl: gh.fetchImpl,
    });
    expect(r.body.status).toBe("follow_up");
    expect((r.body as { question: string }).question).toBe("Was hast du erwartet und was ist passiert?");
    expect((r.body as { summary?: string }).summary).toBe("s");
    expect(gh.calls).toHaveLength(0);
    expect(db.dedup.size).toBe(0); // follow_up is NOT terminal
  });

  it("auto-type: no type sent → the model picks the template, the response names it", async () => {
    const db = fakeDb();
    const gh = ghCapture();
    let prompt = "";
    const chat: ChatFn = async (req) => {
      prompt = JSON.parse((req as { init: { body: string } }).init.body).messages[1].content;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ type: "praise", summary: "Tolle App", followUpQuestion: "", repro: "", expected: "", actual: "" }) } }] }), { status: 200 });
    };
    const r = await orchestrateFeedback(env(db.db), loaded(), payload({ type: undefined, message: "Super gemacht!" }), { apiKey: "k", chat, fetchImpl: gh.fetchImpl, newId: () => "fid" });
    expect(prompt).toContain("choose the best match");
    expect(prompt).toContain("- praise (Lob); required fields: none");
    expect(r.body).toMatchObject({ status: "created", type: "praise", summary: "Tolle App" });
    expect(gh.calls).toHaveLength(0); // praise is noIssue: the bug template's required fields were never asked
  });

  it("issueLink off: the issue is created and stored, but its URL is not returned", async () => {
    const db = fakeDb();
    const r = await orchestrateFeedback(env(db.db), loaded(baseConfig({ issueLink: false })), payload(), {
      apiKey: "k",
      chat: chatReturning({ type: "bug", summary: "s", repro: "k", expected: "e", actual: "a" }),
      fetchImpl: ghCapture().fetchImpl,
    });
    expect(r.body.status).toBe("created");
    expect(r.body).not.toHaveProperty("issueUrl");
    expect(db.feedback[0]).toMatchObject({ issueUrl: "https://github.com/acme/site/issues/1" });
  });

  it("auto-type: the follow-up carries the chosen type for POST-2", async () => {
    const db = fakeDb();
    const r = await orchestrateFeedback(env(db.db), loaded(), payload({ type: undefined }), {
      apiKey: "k",
      chat: chatReturning({ type: "bug", summary: "s", repro: "klick", expected: "", actual: "", followUpQuestion: "Was hast du erwartet?" }),
      fetchImpl: ghCapture().fetchImpl,
    });
    expect(r.body).toMatchObject({ status: "follow_up", type: "bug", question: "Was hast du erwartet?" });
    expect(r.body).not.toHaveProperty("typeUnclear");
  });

  it("auto-type without a usable model: creates for triage instead of asking type-specific questions", async () => {
    const db = fakeDb();
    const gh = ghCapture();
    const r = await orchestrateFeedback(env(db.db), loaded(), payload({ type: undefined }), { chat: chatMustNotRun, fetchImpl: gh.fetchImpl });
    expect(r.body.status).toBe("accepted_incomplete");
    expect(gh.calls[0]!.body.labels).toContain("needs-triage");
  });

  it("a fixed type is never re-classified, even with auto-type on", async () => {
    const db = fakeDb();
    let prompt = "";
    const chat: ChatFn = async (req) => {
      prompt = JSON.parse((req as { init: { body: string } }).init.body).messages[1].content;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ type: "praise", summary: "s", followUpQuestion: "", repro: "k", expected: "e", actual: "a" }) } }] }), { status: 200 });
    };
    const r = await orchestrateFeedback(env(db.db), loaded(), payload(), { apiKey: "k", chat, fetchImpl: ghCapture().fetchImpl });
    expect(prompt).toContain("Feedback type: bug");
    expect(r.body).toMatchObject({ status: "created", type: "bug" });
  });

  it("auto-type: an unclear type asks the settling question even when nothing is missing", async () => {
    const db = fakeDb();
    const gh = ghCapture();
    const seen: { prompt: string; schema?: { required: string[] } } = { prompt: "" };
    const chat = capturingChat({ type: "feature", typeUnclear: true, summary: "Export als PDF", followUpQuestion: "Gibt es einen Export schon, oder fehlt er ganz?", problem: "Ich will Notizen als PDF exportieren", what: "" }, seen);
    const r = await orchestrateFeedback(env(db.db), loaded(ideaConfig()), payload({ type: undefined, message: "PDF-Export wäre toll" }), { apiKey: "k", chat, fetchImpl: gh.fetchImpl });
    expect(seen.prompt).toContain("typeUnclear");
    expect(seen.schema?.required).toContain("typeUnclear");
    expect(r.body).toMatchObject({ status: "follow_up", type: "feature", typeUnclear: true, question: "Gibt es einen Export schon, oder fehlt er ganz?" });
    expect(gh.calls).toHaveLength(0);
  });

  it("auto-type: a clear type with nothing missing creates without a question", async () => {
    const db = fakeDb();
    const r = await orchestrateFeedback(env(db.db), loaded(ideaConfig()), payload({ type: undefined }), {
      apiKey: "k",
      chat: chatReturning({ type: "feature", typeUnclear: false, summary: "s", followUpQuestion: "", problem: "p", what: "" }),
      fetchImpl: ghCapture().fetchImpl,
    });
    expect(r.body).toMatchObject({ status: "created", type: "feature" });
  });

  it("a fixed type never sees the typeUnclear field", async () => {
    const db = fakeDb();
    const seen: { prompt: string; schema?: { required: string[] } } = { prompt: "" };
    await orchestrateFeedback(env(db.db), loaded(ideaConfig()), payload({ type: "feature" }), { apiKey: "k", chat: capturingChat({ type: "feature", summary: "s", followUpQuestion: "", problem: "p" }, seen), fetchImpl: ghCapture().fetchImpl });
    expect(seen.prompt).not.toContain("typeUnclear");
    expect(seen.schema?.required).not.toContain("typeUnclear");
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

  it("the model leaves followUpQuestion empty although fields are missing → created as incomplete, no label question", async () => {
    const db = fakeDb();
    const gh = ghCapture();
    const r = await orchestrateFeedback(env(db.db), loaded(), payload({ message: "siehe Screenshot" }), {
      apiKey: "k",
      chat: chatReturning({ type: "bug", summary: "Hilfe-Bereich wirkt fremd", followUpQuestion: "", repro: "", expected: "", actual: "Die Sektion passt nicht zum Rest" }),
      fetchImpl: gh.fetchImpl,
      now: 1000,
      newId: () => "fid-noq",
    });
    expect(r.body.status).toBe("accepted_incomplete");
    expect(gh.calls).toHaveLength(1);
    expect(JSON.stringify(r.body)).not.toContain("Kurz noch");
  });

  it("LLM off / no key: asks a fallback follow-up (no LLM call)", async () => {
    const db = fakeDb();
    const gh = ghCapture();
    const r = await orchestrateFeedback(env(db.db), loaded(), payload(), { chat: chatMustNotRun, fetchImpl: gh.fetchImpl });
    expect(r.body.status).toBe("follow_up");
    expect((r.body as { question: string }).question).toBeTruthy(); // composed from field labels
    expect(gh.calls).toHaveLength(0);
  });

  it("over the daily LLM budget → fallback follow-up, no LLM call", async () => {
    const cfg = baseConfig({ llm: { provider: "openrouter", model: "m", dailyBudget: 1 } });
    const db = fakeDb({ counterCount: 5 }); // budget counter already past 1
    const gh = ghCapture();
    const r = await orchestrateFeedback(env(db.db), loaded(cfg), payload(), { apiKey: "k", chat: chatMustNotRun, fetchImpl: gh.fetchImpl });
    expect(r.body.status).toBe("follow_up");
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

describe("orchestrateFeedback — POST-2 (freetext answer → one re-extraction)", () => {
  it("re-extracts the freetext answer, merges, and creates", async () => {
    const db = fakeDb();
    const gh = ghCapture();
    const r = await orchestrateFeedback(env(db.db), loaded(), payload({ followUpText: "erwartet gespeichert, es bleibt hängen", extracted: { repro: "klick" } }), {
      apiKey: "k",
      chat: chatReturning({ type: "bug", summary: "s", repro: "klick", expected: "gespeichert", actual: "hängt" }),
      fetchImpl: gh.fetchImpl,
    });
    expect(r.body.status).toBe("created");
    expect(gh.calls).toHaveLength(1);
  });

  it("auto-typed: the answer settles the type and the issue gets that type's labels", async () => {
    const db = fakeDb();
    const gh = ghCapture();
    const seen: { prompt: string; schema?: { required: string[] } } = { prompt: "" };
    const chat = capturingChat({ type: "improvement", typeUnclear: false, summary: "Export schneller machen", followUpQuestion: "", problem: "", what: "Der Export dauert zu lange" }, seen);
    const r = await orchestrateFeedback(
      env(db.db),
      loaded(ideaConfig()),
      payload({ type: "feature", autoTyped: true, message: "Export ist nervig", followUpText: "Den gibt es schon, er dauert nur ewig", extracted: { problem: "Export nervt" } }),
      { apiKey: "k", chat, fetchImpl: gh.fetchImpl },
    );
    expect(seen.prompt).toContain("choose the best match");
    expect(r.body).toMatchObject({ status: "created", type: "improvement" });
    expect(gh.calls[0]!.body.labels).toContain("type/improvement");
    expect(gh.calls[0]!.body.body).toContain("Der Export dauert zu lange");
  });

  it("not auto-typed: POST-2 keeps the type even if the model suggests another", async () => {
    const db = fakeDb();
    const gh = ghCapture();
    const seen: { prompt: string; schema?: { required: string[] } } = { prompt: "" };
    const chat = capturingChat({ type: "improvement", summary: "s", followUpQuestion: "", problem: "Export nervt" }, seen);
    const r = await orchestrateFeedback(env(db.db), loaded(ideaConfig()), payload({ type: "feature", followUpText: "dauert ewig", extracted: { problem: "Export nervt" } }), { apiKey: "k", chat, fetchImpl: gh.fetchImpl });
    expect(seen.prompt).toContain("Feedback type: feature");
    expect(r.body).toMatchObject({ status: "created", type: "feature" });
  });

  it("still-missing after the answer → accepted_incomplete (single-shot, always creates)", async () => {
    const db = fakeDb();
    const gh = ghCapture();
    const r = await orchestrateFeedback(env(db.db), loaded(), payload({ followUpText: "weiß nicht", extracted: {} }), {
      apiKey: "k",
      chat: chatReturning({ type: "bug", summary: "s", repro: "klick", expected: "", actual: "" }),
      fetchImpl: gh.fetchImpl,
    });
    expect(r.body.status).toBe("accepted_incomplete");
    expect(gh.calls[0]!.body.labels).toContain("needs-triage");
  });

  it("empty answer (send-now/anyway bail) → NO re-extraction, uses echoed extraction", async () => {
    const db = fakeDb();
    const gh = ghCapture();
    const r = await orchestrateFeedback(env(db.db), loaded(), payload({ followUpText: "", extracted: { repro: "klick", expected: "e", actual: "a" }, summary: "POST-1 summary" }), {
      apiKey: "k",
      chat: chatMustNotRun, // empty answer must not trigger a redundant LLM call
      fetchImpl: gh.fetchImpl,
    });
    expect(r.body.status).toBe("created");
    expect(gh.calls[0]!.body.title).toBe("[BUG] POST-1 summary");
    expect(gh.calls[0]!.body.body).toContain("klick"); // POST-1's extraction preserved
  });

  it("preserves the answer in the issue even if re-extraction is unavailable (no key)", async () => {
    const db = fakeDb();
    const gh = ghCapture();
    const r = await orchestrateFeedback(env(db.db), loaded(), payload({ message: "Bilder langsam", followUpText: "auf der Projekte-Seite", extracted: {}, summary: "Images load slowly" }), {
      chat: chatMustNotRun, // no apiKey → no re-extraction
      fetchImpl: gh.fetchImpl,
    });
    expect(["created", "accepted_incomplete"]).toContain(r.body.status);
    expect(gh.calls[0]!.body.title).toBe("[BUG] Images load slowly");
    expect(gh.calls[0]!.body.body).toContain("auf der Projekte-Seite"); // folded into the issue
  });

  it("LLM off on both POSTs: a plain issue without the AI note or empty sections", async () => {
    const db = fakeDb();
    const gh = ghCapture();
    await orchestrateFeedback(env(db.db), loaded(baseConfig({ llm: { provider: "off" } })), payload({ message: "Kein Screenshot-Knopf", followUpText: "", extracted: {} }), {
      chat: chatMustNotRun,
      fetchImpl: gh.fetchImpl,
    });
    const body = gh.calls[0]!.body.body;
    expect(body).not.toContain("AI-generierter Entwurf");
    expect(body).not.toContain("not provided");
    expect(body).toContain("> Kein Screenshot-Knopf");
  });

  it("rejects non-canonical select values echoed by POST-2", async () => {
    const config = baseConfig({
      templates: [{
        type: "bug",
        label: "Bug",
        fields: [{ key: "severity", label: "Schweregrad", kind: "select", required: true, options: [{ value: "high", label: "Hoch" }] }],
        tracker: { labels: ["type/bug"] },
      }],
    });
    const db = fakeDb();
    const gh = ghCapture();
    const result = await orchestrateFeedback(env(db.db), loaded(config), payload({ followUpText: "", extracted: { severity: "hoch" } }), {
      chat: chatMustNotRun,
      fetchImpl: gh.fetchImpl,
    });
    expect(result.body.status).toBe("accepted_incomplete");
    expect(gh.calls[0]!.body.body).not.toContain("hoch");
    expect(gh.calls[0]!.body.labels).toContain("needs-triage");
  });
});

describe("orchestrateFeedback — create-anyway on tracker/D1 failure", () => {
  const fullExtract = () => chatReturning({ type: "bug", summary: "s", repro: "k", expected: "e", actual: "a" });

  it("tracker create fails → issue_failed, payload persisted, NOT dedup-stored (retryable)", async () => {
    const db = fakeDb();
    const gh = ghCapture(500);
    const r = await orchestrateFeedback(env(db.db), loaded(), payload(), { apiKey: "k", chat: fullExtract(), fetchImpl: gh.fetchImpl, newId: () => "fid-f" });
    expect(r.body.status).toBe("issue_failed");
    expect(db.feedback[0]).toMatchObject({ outcome: "issue_failed", issueUrl: null });
    expect(db.dedup.size).toBe(0);
  });

  it("missing PAT → issue_failed without a tracker call", async () => {
    const db = fakeDb();
    const gh = ghCapture();
    const r = await orchestrateFeedback({ DB: db.db } as unknown as Env, loaded(), payload(), { apiKey: "k", chat: fullExtract(), fetchImpl: gh.fetchImpl });
    expect(r.body.status).toBe("issue_failed");
    expect((r.body as { reason: string }).reason).toContain("credential");
    expect(gh.calls).toHaveLength(0);
  });

  it("D1 dedup read down → still creates, tags the issue d1-degraded", async () => {
    const db = fakeDb({ dedupThrows: true });
    const gh = ghCapture();
    const r = await orchestrateFeedback(env(db.db), loaded(), payload(), { apiKey: "k", chat: fullExtract(), fetchImpl: gh.fetchImpl });
    expect(["created", "accepted_incomplete"]).toContain(r.body.status);
    expect(gh.calls[0]!.body.labels).toContain("d1-degraded");
  });
});

describe("orchestrateFeedback — journey row (admin history, #70)", () => {
  const fullExtract = () => chatReturning({ type: "bug", summary: "Saving fails", repro: "k", expected: "e", actual: "a" });

  it("pins type, title, LLM provider/model, config version and the understood summary", async () => {
    const db = fakeDb();
    const gh = ghCapture();
    await orchestrateFeedback(env(db.db), { config: baseConfig(), version: 7 }, payload(), { apiKey: "k", chat: fullExtract(), fetchImpl: gh.fetchImpl, now: 5000, newId: () => "fid-j" });
    const row = db.feedback[0]!.row;
    expect(row).toMatchObject({
      id: "fid-j",
      project_id: "demo",
      outcome: "created",
      type: "bug",
      title: "[BUG] Saving fails",
      llm_provider: "openrouter",
      llm_model: "m",
      config_version: 7,
      created_at: 5000,
      updated_at: 5000,
      last_error: null,
      issue_draft: null,
    });
    // POST-1 creates carry no summary of their own; the stored payload gets the understood one.
    expect(JSON.parse(row["payload"] as string)).toMatchObject({ feedbackId: UUID, summary: "Saving fails" });
  });

  it("records the configured model even when no model took part (provider off)", async () => {
    const db = fakeDb();
    const gh = ghCapture();
    const config = baseConfig({ llm: { provider: "off", model: "" }, templates: [{ type: "idea", label: "Idee", fields: [] }] });
    await orchestrateFeedback(env(db.db), loaded(config), payload({ type: "idea" }), { chat: chatMustNotRun, fetchImpl: gh.fetchImpl });
    expect(db.feedback[0]!.row).toMatchObject({ type: "idea", llm_provider: "off", llm_model: null });
  });

  it("tracker failure stores the rendered draft and the error, so a retry needs no LLM", async () => {
    const db = fakeDb();
    const gh = ghCapture(502);
    await orchestrateFeedback(env(db.db), loaded(), payload(), { apiKey: "k", chat: fullExtract(), fetchImpl: gh.fetchImpl });
    const row = db.feedback[0]!.row;
    expect(row).toMatchObject({ outcome: "issue_failed", last_error: "tracker error 502" });
    const draft = JSON.parse(row["issue_draft"] as string) as { title: string; body: string; labels: string[]; repo: string };
    // Exactly what the failed createIssue call sent.
    expect(draft).toEqual({ title: gh.calls[0]!.body.title, body: gh.calls[0]!.body.body, labels: gh.calls[0]!.body.labels, repo: "acme/site" });
    expect(gh.calls[0]!.url).toContain("/repos/acme/site/issues");
  });

  it("missing PAT stores the draft too (nothing was sent)", async () => {
    const db = fakeDb();
    await orchestrateFeedback({ DB: db.db } as unknown as Env, loaded(), payload(), { apiKey: "k", chat: fullExtract() });
    const row = db.feedback[0]!.row;
    expect(row["last_error"]).toBe("tracker credential not configured");
    expect(JSON.parse(row["issue_draft"] as string)).toMatchObject({ title: "[BUG] Saving fails", repo: "acme/site", labels: ["type/bug"] });
  });
});

describe("dryRunPreview (test page)", () => {
  it("renders the would-be issue title + body with no side effects", () => {
    const p = dryRunPreview(baseConfig(), { type: "bug", message: "save is broken", fields: { repro: "click save" } });
    expect(p).not.toBeNull();
    expect(p!.title).toBe("[BUG] save is broken");
    expect(p!.body).toContain("click save");
    expect(p!.body).toContain("### Original feedback");
  });
  it("returns null for an unknown type", () => {
    expect(dryRunPreview(baseConfig(), { type: "nope", message: "x" })).toBeNull();
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
