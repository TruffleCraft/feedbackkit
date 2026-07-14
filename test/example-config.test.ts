import { describe, it, expect } from "vitest";
import { FeedbackConfig } from "../src/shared/contract.js";
import exampleJson from "../config/example.json";

// The seed example is what operators copy — it must always be a valid config.
describe("config/example.json", () => {
  it("validates against the FeedbackConfig schema (minus the seed-only publicKey)", () => {
    const { publicKey: _pk, ...raw } = exampleJson as Record<string, unknown> & { publicKey?: string };
    const parsed = FeedbackConfig.safeParse(raw);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});
