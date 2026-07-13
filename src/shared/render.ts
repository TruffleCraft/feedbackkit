import type { TemplateDefinition } from "./contract.js";

// Renders the GitHub issue title + body. Server-side only (POST-2 trust model:
// the title is re-derived here, never taken from the client). Pure + testable.

export interface RenderContext {
  message: string;
  fields: Record<string, string>;
  summary?: string;
  pageUrl: string;
  deviceInfo?: { browser?: string; os?: string; viewport?: { w: number; h: number }; language?: string };
  attachments?: Array<{ url: string; kind: string }>;
  degraded?: boolean; // LLM unenriched → mark for triage
}

function labelText(label: unknown, locale = "en"): string {
  if (typeof label === "string") return label;
  if (label && typeof label === "object") {
    const rec = label as Record<string, string>;
    return rec[locale] ?? Object.values(rec)[0] ?? "";
  }
  return "";
}

// Every value below (user message, LLM-extracted fields, deviceInfo, pageUrl) is
// UNTRUSTED and rendered into GitHub-Flavored Markdown in the maintainer's repo.
// Neutralize before interpolation so anonymous input can't fire @mention
// notifications, inject #cross-references, forge headings/blockquotes, or embed
// links/images. GitHub already strips <script>/javascript: — the risk here is
// social (mentions/refs/forgery), so we defang those constructs specifically.
function mdInline(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;") // kills leading-`>` blockquote breakout + autolinks
    .replace(/([`[\]])/g, "\\$1") // kills code spans/fences + [text](url) link syntax
    .replace(/([@#])/g, "$1​"); // ZWSP breaks @mentions and #123 issue refs, text unchanged
}

// Attachment hrefs go inside `[..](url)` / `![..](url)`. Require https and
// percent-encode the delimiters so a `)` can't close the link early and inject
// trailing markdown. Returns null for anything not safely renderable → skipped.
function safeAttachmentUrl(u: string): string | null {
  if (!/^https:\/\//i.test(u)) return null;
  // encodeURIComponent leaves ( ) alone, so map the delimiters explicitly.
  const enc: Record<string, string> = { "(": "%28", ")": "%29", "<": "%3C", ">": "%3E", " ": "%20" };
  return u.replace(/[()<>\s]/g, (c) => enc[c] ?? encodeURIComponent(c));
}

/** `[BUG] <summary or first line>`, capped. Never uses a client-supplied title. */
export function deriveTitle(template: TemplateDefinition, ctx: RenderContext): string {
  const base = (ctx.summary || ctx.message || "feedback").replace(/\s+/g, " ").trim();
  const tag = template.type.toUpperCase();
  const room = Math.max(1, 72 - tag.length - 3); // clamp: a long custom type must not go negative
  // Slice by code points, not UTF-16 units, so an emoji at the boundary isn't
  // split into lone surrogates (→ replacement chars in the GitHub title).
  const cps = Array.from(base);
  const text = cps.length > room ? `${cps.slice(0, room - 1).join("")}…` : base;
  return `[${tag}] ${text}`;
}

export function renderIssueBody(template: TemplateDefinition, ctx: RenderContext, locale = "en"): string {
  const parts: string[] = [];

  if (template.body.length > 0) {
    for (const section of template.body) {
      const heading = section.heading ? `### ${labelText(section.heading, locale)}\n` : "";
      const filled = section.template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
        const v = ctx.fields[key];
        return v && v.trim() ? mdInline(v) : "_(not provided)_";
      });
      parts.push(heading + filled);
    }
  } else {
    // No custom body: dump the required fields, falling back to the raw message.
    for (const f of template.fields) {
      const v = ctx.fields[f.key];
      parts.push(`### ${labelText(f.label, locale)}\n${v && v.trim() ? mdInline(v) : "_(not provided)_"}`);
    }
  }

  // Cross-cutting blocks appended after the template body.
  const env = ctx.deviceInfo;
  if (env) {
    const rows = [
      env.browser && `Browser: ${mdInline(env.browser)}`,
      env.os && `OS: ${mdInline(env.os)}`,
      env.viewport && `Viewport: ${env.viewport.w}×${env.viewport.h}`,
      env.language && `Language: ${mdInline(env.language)}`,
      `URL: ${mdInline(ctx.pageUrl)}`,
    ].filter(Boolean);
    parts.push(`### Environment\n${rows.join("\n")}`);
  } else {
    parts.push(`### Environment\nURL: ${mdInline(ctx.pageUrl)}`);
  }

  if (ctx.attachments?.length) {
    const media = ctx.attachments
      .map((a) => {
        const href = safeAttachmentUrl(a.url);
        if (!href) return null;
        return a.kind === "screenshot" || /\.(png|jpe?g|webp|gif)$/i.test(href) ? `![attachment](${href})` : `[attachment](${href})`;
      })
      .filter(Boolean)
      .join("\n");
    if (media) parts.push(`### Attachments\n${media}`);
  }

  // Verbatim user text: neutralize inline markdown, then apply OUR blockquote prefix.
  const quoted = mdInline(ctx.message)
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  parts.push(`### Original feedback\n${quoted}`);

  if (ctx.degraded) {
    parts.push("_Structured automatically without AI enrichment — please triage._");
  }

  return parts.join("\n\n");
}
