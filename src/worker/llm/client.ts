import type { FeedbackConfig, TemplateDefinition } from "../../shared/contract.js";

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
  /** True if the LLM call/parse failed — caller must fall back, never block. */
  degraded: boolean;
  degradeReason?: string;
}

export type ChatFn = (req: unknown, signal: AbortSignal) => Promise<Response>;

const SYSTEM_PROMPT = [
  "You extract structured fields from a user's raw product feedback for a developer issue tracker.",
  "Rules: extract ONLY what the user actually stated; never invent facts.",
  "Keep values in the user's original language — never translate.",
  "Prefer verbatim spans; a short same-language paraphrase is allowed.",
  "Return JSON only, matching the requested schema. Leave a field as an empty string if the user did not provide it.",
].join(" ");

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
      required: ["type", "summary", ...template.fields.map((f) => f.key)],
      properties,
    },
  };
}

export interface ClassifyOpts {
  config: FeedbackConfig;
  template: TemplateDefinition;
  message: string;
  screenshotDataUrl?: string;
  apiKey: string;
  chat: ChatFn;
  timeoutMs?: number;
}

export async function classifyAndExtract(opts: ClassifyOpts): Promise<ExtractionResult> {
  const { config, template, message, screenshotDataUrl, apiKey, chat } = opts;
  const allTypes = config.templates.map((t) => t.type);

  const fieldLines = template.fields
    .map((f) => `- ${f.key} (${labelText(f.label, config.locale)})${f.extractionHint ? `: ${f.extractionHint}` : ""}`)
    .join("\n");
  const userText = `Feedback type: ${template.type}\nFields to extract:\n${fieldLines}\n\nUser feedback:\n${message}`;

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
    response_format: { type: "json_schema", json_schema: buildSchema(template, allTypes) },
  };
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

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return degraded(template, "llm returned non-JSON");
  }

  const extracted: Record<string, string> = {};
  for (const f of template.fields) {
    const v = parsed[f.key];
    if (typeof v === "string" && v.trim()) extracted[f.key] = v.trim();
  }
  const missing = template.fields.filter((f) => f.required && f.askIfMissing && !extracted[f.key]).map((f) => f.key);
  const typeVal = typeof parsed["type"] === "string" && allTypes.includes(parsed["type"] as string) ? (parsed["type"] as string) : undefined;
  const summary = typeof parsed["summary"] === "string" ? (parsed["summary"] as string).trim() : undefined;

  return { type: typeVal, extracted, missing, summary, degraded: false };
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
