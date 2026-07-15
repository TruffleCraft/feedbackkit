import { describe, it, expect } from "vitest";
import { classifyAndExtract, type ChatFn } from "../src/worker/llm/client.js";
import { FeedbackConfig } from "../src/shared/contract.js";
import { BUG_FIXTURES } from "./fixtures/extraction.js";

const config = FeedbackConfig.parse({
  projectId: "demo",
  locale: "de",
  templates: [
    {
      type: "bug",
      label: "Bug",
      fields: [
        { key: "repro", label: "Schritte", kind: "longtext", required: true, extractionHint: "Wie reproduzieren?" },
        { key: "expected", label: "Erwartet", kind: "longtext", required: true },
        { key: "actual", label: "Tatsächlich", kind: "longtext", required: true },
      ],
    },
  ],
  llm: { provider: "openrouter", model: "google/gemini-flash-1.5" },
  tracker: { kind: "github", defaultRepo: "acme/site", patSecret: "GITHUB_PAT_default" },
  auth: { origins: [] },
});
const bug = config.templates[0]!;

// A mock chat transport that returns whatever content we give it.
function mockChat(content: string, status = 200): ChatFn {
  return async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });
}

describe("classifyAndExtract", () => {
  it("extracts fields and reports none missing when all present", async () => {
    const r = await classifyAndExtract({
      config,
      template: bug,
      message: "…",
      apiKey: "k",
      chat: mockChat(JSON.stringify({ type: "bug", summary: "Speichern kaputt", repro: "Klick", expected: "gespeichert", actual: "hängt" })),
    });
    expect(r.degraded).toBe(false);
    expect(r.missing).toEqual([]);
    expect(r.extracted.repro).toBe("Klick");
    expect(r.type).toBe("bug");
    expect(r.summary).toBe("Speichern kaputt");
  });

  it("reports required fields the LLM left empty as missing", async () => {
    const r = await classifyAndExtract({
      config,
      template: bug,
      message: "…",
      apiKey: "k",
      chat: mockChat(JSON.stringify({ type: "bug", summary: "s", repro: "Klick", expected: "", actual: "" })),
    });
    expect(r.degraded).toBe(false);
    expect(r.missing.sort()).toEqual(["actual", "expected"]);
  });

  it("degrades (all required missing) on non-JSON output — never blocks", async () => {
    const r = await classifyAndExtract({ config, template: bug, message: "…", apiKey: "k", chat: mockChat("sorry, I cannot do that") });
    expect(r.degraded).toBe(true);
    expect(r.missing.sort()).toEqual(["actual", "expected", "repro"]);
  });

  it("degrades on an HTTP error", async () => {
    const r = await classifyAndExtract({ config, template: bug, message: "…", apiKey: "k", chat: mockChat("{}", 500) });
    expect(r.degraded).toBe(true);
    expect(r.degradeReason).toContain("500");
  });

  it("degrades (never throws) when the LLM returns bare null / array / scalar JSON", async () => {
    for (const content of ["null", "[]", "true", "42", '"hi"']) {
      const r = await classifyAndExtract({ config, template: bug, message: "…", apiKey: "k", chat: mockChat(content) });
      expect(r.degraded).toBe(true);
      expect(r.missing.sort()).toEqual(["actual", "expected", "repro"]);
    }
  });

  it("preserves values verbatim — never translates (German stays German)", async () => {
    const german = "Seite bleibt hängen";
    const r = await classifyAndExtract({
      config,
      template: bug,
      message: "…",
      apiKey: "k",
      chat: mockChat(JSON.stringify({ type: "bug", summary: "s", repro: "x", expected: "y", actual: german })),
    });
    expect(r.extracted.actual).toBe(german);
  });

  it("tolerates a ```json fenced response (common when structured output is off)", async () => {
    const r = await classifyAndExtract({
      config,
      template: bug,
      message: "…",
      apiKey: "k",
      chat: mockChat('```json\n{"type":"bug","summary":"s","repro":"x","expected":"y","actual":"z"}\n```'),
    });
    expect(r.degraded).toBe(false);
    expect(r.extracted.actual).toBe("z");
    expect(r.missing).toEqual([]);
  });

  it("does not corrupt raw JSON whose string value contains a ``` fence", async () => {
    const content = JSON.stringify({ type: "bug", summary: "s", repro: "run ```npm test``` then click", expected: "y", actual: "z" });
    const r = await classifyAndExtract({ config, template: bug, message: "…", apiKey: "k", chat: mockChat(content) });
    expect(r.degraded).toBe(false);
    expect(r.extracted.repro).toBe("run ```npm test``` then click");
  });

  it("omits response_format when structuredOutput is false (for endpoints that don't support it)", async () => {
    const off = FeedbackConfig.parse({ ...JSON.parse(JSON.stringify(config)), llm: { provider: "custom", model: "local", baseUrl: "http://localhost:11434/v1", structuredOutput: false } });
    let seenBody = "";
    const capture: ChatFn = async (req) => {
      seenBody = (req as { init: { body: string } }).init.body;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"type":"bug","summary":"s","repro":"a","expected":"b","actual":"c"}' } }] }), { status: 200 });
    };
    const r = await classifyAndExtract({ config: off, template: off.templates[0]!, message: "…", apiKey: "k", chat: capture });
    expect(JSON.parse(seenBody).response_format).toBeUndefined();
    expect(r.degraded).toBe(false);
  });

  it("passes provider data_collection:deny only for openrouter", async () => {
    let seenBody = "";
    const capture: ChatFn = async (req) => {
      seenBody = (req as { init: { body: string } }).init.body;
      return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 });
    };
    await classifyAndExtract({ config, template: bug, message: "…", apiKey: "k", chat: capture });
    expect(JSON.parse(seenBody).provider).toEqual({ data_collection: "deny" });
  });
});

describe("classifyAndExtract — session context & vision", () => {
  type Part = { type: string; text?: string; image_url?: { url: string } };
  type Body = { messages: Array<{ role: string; content: string | Part[] }> };
  function captureChat() {
    let body: Body | undefined;
    const chat: ChatFn = async (req) => {
      body = JSON.parse((req as { init: { body: string } }).init.body) as Body;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"type":"bug","summary":"s","repro":"a","expected":"b","actual":"c"}' } }] }), { status: 200 });
    };
    return { chat, get: () => body!.messages[1]!.content };
  }

  it("feeds page URL, device and console messages into the user prompt", async () => {
    const cap = captureChat();
    await classifyAndExtract({
      config,
      template: bug,
      message: "geht nicht",
      apiKey: "k",
      chat: cap.chat,
      pageUrl: "https://acme.dev/settings",
      deviceInfo: { browser: "Firefox 130", os: "macOS", viewport: { w: 1440, h: 900 }, language: "de" },
      consoleErrors: [{ level: "error", msg: "TypeError: x is not a function", ts: 1 }],
    });
    const c = cap.get();
    const text = typeof c === "string" ? c : c[0]!.text!;
    expect(text).toContain("Session context:");
    expect(text).toContain("https://acme.dev/settings");
    expect(text).toContain("Firefox 130");
    expect(text).toContain("TypeError: x is not a function");
  });

  it("attaches the screenshot as an image_url part when a data URL is given", async () => {
    const cap = captureChat();
    const dataUrl = "data:image/webp;base64,AAAA";
    await classifyAndExtract({ config, template: bug, message: "x", apiKey: "k", chat: cap.chat, screenshotDataUrl: dataUrl });
    const c = cap.get();
    expect(Array.isArray(c)).toBe(true);
    const img = (c as Part[]).find((p) => p.type === "image_url");
    expect(img?.image_url?.url).toBe(dataUrl);
  });

  it("adds no Session context block for plain text-only feedback (behaviour unchanged)", async () => {
    const cap = captureChat();
    await classifyAndExtract({ config, template: bug, message: "just text", apiKey: "k", chat: cap.chat });
    const c = cap.get();
    expect(typeof c).toBe("string");
    expect(c as string).not.toContain("Session context:");
  });
});

describe("extraction eval corpus (contract, mock LLM)", () => {
  for (const fx of BUG_FIXTURES) {
    it(`fixture: ${fx.name}`, async () => {
      const r = await classifyAndExtract({
        config,
        template: bug,
        message: fx.message,
        apiKey: "k",
        chat: mockChat(JSON.stringify({ type: "bug", summary: "s", ...fx.llmReturns })),
      });
      expect(r.missing.sort()).toEqual([...fx.expectMissing].sort());
    });
  }
});
