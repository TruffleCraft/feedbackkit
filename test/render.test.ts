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

  it("caps by code point and never splits an emoji into lone surrogates", () => {
    const t = deriveTitle(bug, ctx({ summary: "😀".repeat(100) }));
    expect(Array.from(t).length).toBeLessThanOrEqual(72);
    // A split pair would surface a lone high/low surrogate as its own element.
    expect([...t].every((ch) => ch !== "\uD83D" && ch !== "\uDE00")).toBe(true);
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

  it("neutralizes markdown injection from untrusted message + fields (no live mention/ref/link)", () => {
    const body = renderIssueBody(
      bug,
      ctx({
        message: "ping @maintainer, see #1, [click](https://evil)\n### Fake heading\n> forged",
        fields: { repro: "@team `code` <b>x</b>", expected: "ok" },
      }),
    );
    expect(body).not.toContain("@maintainer"); // ZWSP inserted → not an autolinked mention
    expect(body).toContain("@​maintainer");
    expect(body).toContain("#​1"); // issue cross-ref defanged
    expect(body).toContain("\\[click\\]"); // link syntax broken
    expect(body).toContain("&lt;b&gt;x&lt;/b&gt;"); // html escaped
    expect(body).toContain("\\`code\\`"); // code span/fence broken
    expect(body).toContain("> &gt; forged"); // their leading `>` escaped; only our prefix quotes
  });

  it("drops non-https attachments and percent-encodes link delimiters", () => {
    const body = renderIssueBody(
      bug,
      ctx({
        attachments: [
          { url: "javascript:alert(1)", kind: "upload" },
          { url: "https://r2/a(b).png", kind: "screenshot" },
        ],
      }),
    );
    expect(body).not.toContain("javascript:");
    expect(body).toContain("![attachment](https://r2/a%28b%29.png)");
  });
});
