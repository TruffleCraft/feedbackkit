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

/** `[BUG] <summary or first line>`, capped. Never uses a client-supplied title. */
export function deriveTitle(template: TemplateDefinition, ctx: RenderContext): string {
  const base = (ctx.summary || ctx.message || "feedback").replace(/\s+/g, " ").trim();
  const tag = template.type.toUpperCase();
  const room = 72 - tag.length - 3;
  const text = base.length > room ? `${base.slice(0, room - 1)}…` : base;
  return `[${tag}] ${text}`;
}

export function renderIssueBody(template: TemplateDefinition, ctx: RenderContext, locale = "en"): string {
  const parts: string[] = [];

  if (template.body.length > 0) {
    for (const section of template.body) {
      const heading = section.heading ? `### ${labelText(section.heading, locale)}\n` : "";
      const filled = section.template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
        const v = ctx.fields[key];
        return v && v.trim() ? v : "_(not provided)_";
      });
      parts.push(heading + filled);
    }
  } else {
    // No custom body: dump the required fields, falling back to the raw message.
    for (const f of template.fields) {
      const v = ctx.fields[f.key];
      parts.push(`### ${labelText(f.label, locale)}\n${v && v.trim() ? v : "_(not provided)_"}`);
    }
  }

  // Cross-cutting blocks appended after the template body.
  const env = ctx.deviceInfo;
  if (env) {
    const rows = [
      env.browser && `Browser: ${env.browser}`,
      env.os && `OS: ${env.os}`,
      env.viewport && `Viewport: ${env.viewport.w}×${env.viewport.h}`,
      env.language && `Language: ${env.language}`,
      `URL: ${ctx.pageUrl}`,
    ].filter(Boolean);
    parts.push(`### Environment\n${rows.join("\n")}`);
  } else {
    parts.push(`### Environment\nURL: ${ctx.pageUrl}`);
  }

  if (ctx.attachments?.length) {
    const media = ctx.attachments
      .map((a) => (a.kind === "screenshot" || /\.(png|jpe?g|webp|gif)$/i.test(a.url) ? `![attachment](${a.url})` : `[attachment](${a.url})`))
      .join("\n");
    parts.push(`### Attachments\n${media}`);
  }

  parts.push(`### Original feedback\n> ${ctx.message.replace(/\n/g, "\n> ")}`);

  if (ctx.degraded) {
    parts.push("_Structured automatically without AI enrichment — please triage._");
  }

  return parts.join("\n\n");
}
