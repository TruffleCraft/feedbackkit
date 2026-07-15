import { describe, it, expect } from "vitest";
import { FeedbackConfig } from "../src/shared/contract.js";
import { toPublicConfig } from "../src/shared/projection.js";

const config = FeedbackConfig.parse({
  projectId: "demo",
  locale: "en",
  templates: [
    {
      type: "bug",
      label: "Bug",
      fields: [
        { key: "repro", label: "Steps", kind: "longtext", required: true, extractionHint: "SECRET-HINT-do-not-leak" },
      ],
      tracker: { repo: "acme/private-repo", labels: ["type/bug"] },
    },
  ],
  llm: { provider: "openrouter", model: "google/gemini-flash-1.5", baseUrl: "https://openrouter.ai/api/v1" },
  tracker: { kind: "github", defaultRepo: "acme/private-repo", patSecret: "GITHUB_PAT_secret_name" },
  auth: { origins: ["https://acme.dev"] },
});

describe("toPublicConfig", () => {
  const pub = toPublicConfig(config, 3);
  const json = JSON.stringify(pub);

  it("exposes what the widget needs", () => {
    expect(pub.v).toBe(1);
    expect(pub.enabled).toBe(true);
    expect(pub.configVersion).toBe(3);
    expect(pub.types[0]!.type).toBe("bug");
    expect(pub.types[0]!.fields[0]).toEqual({ key: "repro", label: "Steps", kind: "longtext", required: true });
  });

  it("leaks NO internals (hint, repo, secret name, llm, origins)", () => {
    expect(json).not.toContain("SECRET-HINT");
    expect(json).not.toContain("private-repo");
    expect(json).not.toContain("GITHUB_PAT_secret_name");
    expect(json).not.toContain("openrouter");
    expect(json).not.toContain("acme.dev");
    expect(json).not.toContain("extractionHint");
  });

  it("projects per-type guidance when present, omits the key when absent", () => {
    const withGuidance = FeedbackConfig.parse({
      projectId: "demo",
      templates: [
        { type: "bug", label: "Bug", guidance: "What you did, expected, and saw.", fields: [] },
        { type: "idea", label: "Idea", fields: [] },
      ],
      llm: { provider: "openrouter", model: "m" },
      tracker: { kind: "github", defaultRepo: "acme/site", patSecret: "GITHUB_PAT_default" },
      auth: { origins: [] },
    });
    const types = toPublicConfig(withGuidance, 1).types;
    expect(types[0]!.guidance).toBe("What you did, expected, and saw.");
    expect("guidance" in types[1]!).toBe(false); // no guidance → key absent, not undefined
  });

  it("carries select-field options so the widget can render them", () => {
    const withSelect = FeedbackConfig.parse({
      projectId: "demo",
      templates: [
        {
          type: "bug",
          label: "Bug",
          fields: [
            {
              key: "severity",
              label: "Severity",
              kind: "select",
              required: true,
              options: [
                { value: "low", label: "Low" },
                { value: "high", label: "High" },
              ],
            },
          ],
        },
      ],
      llm: { provider: "openrouter", model: "m" },
      tracker: { kind: "github", defaultRepo: "acme/site", patSecret: "GITHUB_PAT_default" },
      auth: { origins: [] },
    });
    const field = toPublicConfig(withSelect, 1).types[0]!.fields[0]!;
    expect(field.options).toEqual([
      { value: "low", label: "Low" },
      { value: "high", label: "High" },
    ]);
  });
});
