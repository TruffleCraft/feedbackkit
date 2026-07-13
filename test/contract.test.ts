import { describe, it, expect } from "vitest";
import { FeedbackConfig, FeedbackPayload, WIRE_VERSION } from "../src/shared/contract.js";

const baseConfig = {
  projectId: "demo",
  templates: [{ type: "bug", label: "Bug", fields: [{ key: "repro", label: "Steps", kind: "longtext", required: true }] }],
  llm: { provider: "openrouter", model: "google/gemini-flash-1.5" },
  tracker: { kind: "github", defaultRepo: "acme/site", patSecret: "GITHUB_PAT_default" },
  auth: { origins: ["https://acme.dev"] },
};

describe("FeedbackConfig", () => {
  it("parses a minimal config and applies defaults", () => {
    const cfg = FeedbackConfig.parse(baseConfig);
    expect(cfg.locale).toBe("en"); // default
    expect(cfg.enabled).toBe(true);
    expect(cfg.createAnyway.onIncomplete).toBe(true);
    expect(cfg.rateLimit.perHour).toBe(75);
    expect(cfg.templates[0]!.fields[0]!.required).toBe(true);
  });

  it("rejects a config with no templates", () => {
    expect(() => FeedbackConfig.parse({ ...baseConfig, templates: [] })).toThrow();
  });
});

describe("FeedbackPayload", () => {
  const uuid = "00000000-0000-4000-8000-000000000000";
  it("accepts a valid first POST", () => {
    const p = FeedbackPayload.parse({ v: WIRE_VERSION, feedbackId: uuid, pageUrl: "https://acme.dev/x", message: "it broke" });
    expect(p.attachmentKeys).toEqual([]);
  });

  it("rejects a filled honeypot", () => {
    expect(() =>
      FeedbackPayload.parse({ v: WIRE_VERSION, feedbackId: uuid, pageUrl: "https://acme.dev/x", hpField: "bot" }),
    ).toThrow();
  });
});
