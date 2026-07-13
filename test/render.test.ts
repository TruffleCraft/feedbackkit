import { describe, it, expect } from "vitest";
import { deriveTitle, renderIssueBody, type RenderContext } from "../src/shared/render.js";
import { TemplateDefinition } from "../src/shared/contract.js";

const bug = TemplateDefinition.parse({
  type: "bug",
  label: "Bug",
  fields: [
    { key: "repro", label: "Steps", kind: "longtext", required: true },
    { key: "expected", label: "Expected", kind: "longtext", required: true },
  ],
  body: [
    { heading: "Steps to reproduce", template: "{{repro}}" },
    { heading: "Expected vs actual", template: "Expected: {{expected}}\nActual: {{actual}}" },
  ],
});

const ctx = (over: Partial<RenderContext> = {}): RenderContext => ({
  message: "save button does nothing",
  fields: { repro: "click save", expected: "it saves" },
  pageUrl: "https://acme.dev/form",
  deviceInfo: { browser: "Chrome", os: "macOS", viewport: { w: 1440, h: 900 } },
  ...over,
});

describe("deriveTitle", () => {
  it("tags with the type and uses summary over message; never a client title", () => {
    expect(deriveTitle(bug, ctx({ summary: "Save broken" }))).toBe("[BUG] Save broken");
  });
  it("caps long titles", () => {
    const t = deriveTitle(bug, ctx({ summary: "x".repeat(200) }));
    expect(t.length).toBeLessThanOrEqual(72);
    expect(t.endsWith("…")).toBe(true);
  });
});

describe("renderIssueBody", () => {
  it("substitutes fields into body sections and marks missing ones", () => {
    const body = renderIssueBody(bug, ctx());
    expect(body).toContain("### Steps to reproduce\nclick save");
    expect(body).toContain("Expected: it saves");
    expect(body).toContain("Actual: _(not provided)_"); // 'actual' not in fields
  });

  it("appends environment, original feedback, and (when degraded) a triage note", () => {
    const body = renderIssueBody(bug, ctx({ degraded: true }));
    expect(body).toContain("### Environment");
    expect(body).toContain("Chrome");
    expect(body).toContain("URL: https://acme.dev/form");
    expect(body).toContain("### Original feedback\n> save button does nothing");
    expect(body).toContain("please triage");
  });

  it("renders image attachments inline, others as links", () => {
    const body = renderIssueBody(bug, ctx({ attachments: [{ url: "https://r2/x.png", kind: "screenshot" }, { url: "https://r2/log.txt", kind: "upload" }] }));
    expect(body).toContain("![attachment](https://r2/x.png)");
    expect(body).toContain("[attachment](https://r2/log.txt)");
  });
});
