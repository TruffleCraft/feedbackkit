import type { ConsoleEntryT, DeviceInfoT, FeedbackConfig, TemplateDefinition } from "../../shared/contract.js";

// One OpenAI-compatible client covers OpenRouter (default), LiteLLM, Ollama, vLLM,
// local models (ADR-007). Structured output is requested best-effort; the HARD gate
// is our own validation of the returned JSON (ADR-008). Any failure → degraded, and
// the caller falls back to a plain form (create-anyway).

export interface ExtractionResult {
  /** LLM-suggested feedback type, only if it matches a configured template. */
  type?: string;
  /** Extracted field values, keyed by field key. Empty/absent = not found. */
  extracted: Record<string, string>;
  /** Required field keys the LLM could not fill. */
  missing: string[];
  summary?: string;
  /** ONE short natural-language follow-up question for the missing info (ADR-012),
   * in the user's language; empty when nothing required is missing. */
  followUpQuestion?: string;
  /** True if the LLM call/parse failed — caller must fall back, never block. */
  degraded: boolean;
  degradeReason?: string;
}

export type ChatFn = (req: unknown, signal: AbortSignal) => Promise<Response>;

const SYSTEM_PROMPT = [
  "You extract structured fields from a user's raw product feedback for a developer issue tracker.",
  "You are given the user's text and, when available, a SCREENSHOT of the page they were on plus session context (page URL, device, recent console messages).",
  "Use ALL of these as evidence: read the screenshot for the visible UI state, any error message shown, and what the user is pointing at; treat the console messages and URL as corroborating technical detail.",
  "Rules: extract ONLY what is supported by the user's text, the screenshot, or the session context — never invent facts that none of them show.",
  "Write summary and free-text issue fields in the requested issue language. Preserve technical strings such as errors, URLs and identifiers verbatim. Select fields must use their configured value exactly and must never be translated.",
  "Return JSON only, matching the requested schema. Leave a field as an empty string if none of the inputs provide it.",
  "followUpQuestion: if any REQUIRED field is still empty AFTER using every input, write ONE short, friendly question (in the user's language) for the single most important missing thing — combine multiple missing items into one natural question, and do NOT ask for anything the screenshot or context already answered. If nothing required is missing, use an empty string.",
].join(" ");

// Models commonly wrap JSON in a ```json … ``` fence even when asked not to.
// Strip it before parsing (the fence is never valid JSON on its own).
function stripFence(raw: string): string {
  const t = raw.trim();
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return m ? m[1]!.trim() : t;
}

function labelText(label: unknown, locale: string): string {
  if (typeof label === "string") return label;
  if (label && typeof label === "object") {
    const rec = label as Record<string, string>;
    return rec[locale] ?? Object.values(rec)[0] ?? "";
  }
  return "";
}

/** Build an OpenAI json_schema for the template's fields (+ type/summary). */
function buildSchema(template: TemplateDefinition, allTypes: string[]) {
  const properties: Record<string, unknown> = {
    type: { type: "string", enum: allTypes },
    summary: { type: "string" },
    followUpQuestion: { type: "string" },
  };
  for (const f of template.fields) {
    properties[f.key] =
      f.kind === "select" && f.options?.length
        ? { type: "string", enum: f.options.map((o) => o.value) }
        : { type: "string" };
  }
  return {
    name: "feedback_extraction",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["type", "summary", "followUpQuestion", ...template.fields.map((f) => f.key)],
      properties,
    },
  };
}

export interface ClassifyOpts {
  config: FeedbackConfig;
  template: TemplateDefinition;
  message: string;
  screenshotDataUrl?: string;
  // Session context fed to the model alongside the text + screenshot so the
  // extraction and the follow-up question are grounded in more than the prose
  // (fixes thin, text-only follow-ups). All optional — absent = omitted.
  pageUrl?: string;
  deviceInfo?: DeviceInfoT;
  consoleErrors?: ConsoleEntryT[];
  apiKey: string;
  chat: ChatFn;
  timeoutMs?: number;
}

/** Render the optional session context as a compact block for the user message.
 * Empty string when there's nothing to add (so text-only feedback is unchanged). */
function renderContext(opts: ClassifyOpts): string {
  const lines: string[] = [];
  if (opts.pageUrl) lines.push(`Page URL: ${opts.pageUrl}`);
  const d = opts.deviceInfo;
  if (d) {
    const parts: string[] = [];
    if (d.browser) parts.push(d.browser);
    if (d.os) parts.push(d.os);
    if (d.viewport) parts.push(`viewport ${d.viewport.w}×${d.viewport.h}`);
    if (d.language) parts.push(`lang ${d.language}`);
    if (parts.length) lines.push(`Device: ${parts.join(", ")}`);
  }
  // Client-side PII-filtered and capped already; take the most recent few.
  const errs = (opts.consoleErrors ?? []).slice(-8);
  if (errs.length) {
    lines.push("Recent console messages (may be unrelated — corroborate, don't assume):");
    for (const e of errs) lines.push(`  [${e.level}] ${e.msg}`);
  }
  return lines.length ? `\n\nSession context:\n${lines.join("\n")}` : "";
}

export async function classifyAndExtract(opts: ClassifyOpts): Promise<ExtractionResult> {
  const { config, template, message, screenshotDataUrl, apiKey, chat } = opts;
  const allTypes = config.templates.map((t) => t.type);

  const fieldLines = template.fields
    .map((f) => {
      const allowed = f.kind === "select" && f.options?.length ? ` Allowed exact values: ${f.options.map((option) => option.value).join(", ")}.` : "";
      return `- ${f.key} (${labelText(f.label, config.locale)})${f.extractionHint ? `: ${f.extractionHint}` : ""}${allowed}`;
    })
    .join("\n");
  // Naming the exact key set helps models that run WITHOUT json_schema (below).
  const keyList = ["type", "summary", "followUpQuestion", ...template.fields.map((f) => f.key)].join(", ");
  const userText = `Feedback type: ${template.type}\nIssue language: ${config.locale}\nTranslate summary and extracted issue fields into that language when needed. Keep followUpQuestion in the user's language.${"\n"}Fields to extract:\n${fieldLines}\n\nReturn a JSON object with exactly these keys: ${keyList}.${renderContext(opts)}\n\nUser feedback:\n${message}`;

  const content: unknown = screenshotDataUrl
    ? [
        { type: "text", text: userText },
        { type: "image_url", image_url: { url: screenshotDataUrl } },
      ]
    : userText;

  const req: Record<string, unknown> = {
    model: config.llm.model,
    temperature: 0,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content },
    ],
  };
  // Structured output is best-effort (ADR-008). Endpoints that don't support it
  // return EMPTY content when it's forced, so it's opt-out per project.
  if (config.llm.structuredOutput !== false) {
    req["response_format"] = { type: "json_schema", json_schema: buildSchema(template, allTypes) };
  }
  // OpenRouter-only privacy hint; other endpoints may reject unknown top-level keys.
  if (config.llm.provider === "openrouter") {
    req["provider"] = { data_collection: "deny" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  let raw: string;
  try {
    const base = (config.llm.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
    const res = await chat(
      {
        url: `${base}/chat/completions`,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(req),
        },
      },
      controller.signal,
    );
    if (!res.ok) return degraded(template, `llm http ${res.status}`);
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    raw = json.choices?.[0]?.message?.content ?? "";
  } catch (e) {
    return degraded(template, `llm call failed: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  let parsed: unknown;
  try {
    // Try raw first so valid JSON containing a ``` inside a string value isn't
    // corrupted by the fence-stripper; only strip fences if raw parse fails.
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = JSON.parse(stripFence(raw));
    }
  } catch {
    return degraded(template, "llm returned non-JSON");
  }
  // `JSON.parse("null")` / `"[]"` / `"true"` succeed but are not extractable
  // objects; indexing them (e.g. `null[key]`) would throw and break the
  // never-blocks contract. A non-conforming shape → degrade, never throw.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return degraded(template, "llm returned a non-object");
  }
  const obj = parsed as Record<string, unknown>;

  const extracted: Record<string, string> = {};
  for (const f of template.fields) {
    const v = obj[f.key];
    if (typeof v !== "string" || !v.trim()) continue;
    const value = v.trim();
    if (f.kind === "select" && f.options?.length && !f.options.some((option) => option.value === value)) continue;
    extracted[f.key] = value;
  }
  const missing = template.fields.filter((f) => f.required && f.askIfMissing && !extracted[f.key]).map((f) => f.key);
  const typeVal = typeof obj["type"] === "string" && allTypes.includes(obj["type"] as string) ? (obj["type"] as string) : undefined;
  const summary = typeof obj["summary"] === "string" ? (obj["summary"] as string).trim() : undefined;
  const followUpQuestion = typeof obj["followUpQuestion"] === "string" ? (obj["followUpQuestion"] as string).trim() : undefined;

  return { type: typeVal, extracted, missing, summary, followUpQuestion, degraded: false };
}

function degraded(template: TemplateDefinition, reason: string): ExtractionResult {
  // On any LLM failure, everything required is "missing" and the caller decides
  // (need_fields or, if create-anyway, an unenriched issue). Feedback is never lost.
  return {
    extracted: {},
    missing: template.fields.filter((f) => f.required).map((f) => f.key),
    degraded: true,
    degradeReason: reason,
  };
}
