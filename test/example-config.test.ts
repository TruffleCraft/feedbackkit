import { describe, it, expect } from "vitest";
import { FeedbackConfig } from "../src/shared/contract.js";
import exampleJson from "../config/example.json";
import demoJson from "../config/demo.json";

// The seed example is what operators copy — it must always be a valid config.
describe("config/example.json", () => {
  it("validates against the FeedbackConfig schema (minus the seed-only publicKey)", () => {
    const { publicKey: _pk, ...raw } = exampleJson as Record<string, unknown> & { publicKey?: string };
    const parsed = FeedbackConfig.safeParse(raw);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});

describe("config/demo.json", () => {
  it("keeps improvement feedback conversational by requiring a desired outcome", () => {
    const { publicKey: _pk, ...raw } = demoJson as Record<string, unknown> & { publicKey?: string };
    const parsed = FeedbackConfig.parse(raw);
    const improvement = parsed.templates.find((template) => template.type === "improvement");
    expect(improvement?.fields.filter((field) => field.required).map((field) => field.key)).toEqual(["what", "desired"]);
  });
});
