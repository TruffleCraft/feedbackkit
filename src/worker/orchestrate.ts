import { WIRE_VERSION, type FeedbackConfig, type FeedbackPayload, type FeedbackResponse, type TemplateDefinition } from "../shared/contract.js";
import { classifyAndExtract, type ChatFn, type ExtractionResult } from "./llm/client.js";
import { createIssue, TrackerError, type FetchFn } from "./providers/github.js";
import { deriveTitle, renderIssueBody, type RenderContext } from "../shared/render.js";
import { publicUrl } from "./storage/r2.js";
import { hitRateLimit, dayWindow } from "./security/ratelimit.js";
import type { LoadedProject } from "./config.js";
import type { Env } from "./env.js";

// The core loop (P1.9): unstructured feedback → structured issue via the
// Extract-then-Form protocol. ONE LLM call on POST-1; POST-2 (completed fields)
// is deterministic and server-re-validated (never trusts a client title/fields).
// The create-anyway matrix guarantees feedback is never lost: an LLM, D1, or
// tracker failure downgrades the outcome, it never 500s the submission.

// Asking more than this many follow-up questions is worse UX than just creating
// the issue and tagging it for triage (ROADMAP field-ceiling).
const FIELD_CEILING = 3;

/** Real LLM transport (injected as `chat`); overridden by mocks in tests. */
export const realChat: ChatFn = (req, signal) => {
  const { url, init } = req as { url: string; init: RequestInit };
  return fetch(url, { ...init, signal });
};

export interface OrchestrateDeps {
  apiKey?: string;
  chat: ChatFn;
  fetchImpl?: FetchFn;
  now?: number;
  newId?: () => string;
}

function requiredAskable(t: TemplateDefinition) {
  return t.fields.filter((f) => f.required && f.askIfMissing);
}

// Dry-run preview for the /t/<key> test page: render the issue that WOULD be
// created, with no LLM call, no tracker call, and no D1 write (so a public test
// page can't spam the repo or burn budget). Pure.
export interface PreviewInput {
  type?: string;
  message?: string;
  fields?: Record<string, string>;
  pageUrl?: string;
}
export function dryRunPreview(config: FeedbackConfig, input: PreviewInput): { title: string; body: string } | null {
  const template = resolveTemplate(config, input.type);
  if (!template) return null;
  const ctx: RenderContext = {
    message: input.message ?? "",
    fields: input.fields ?? {},
    pageUrl: input.pageUrl ?? "(test page)",
    attachments: [],
    degraded: false,
  };
  return { title: deriveTitle(template, ctx), body: renderIssueBody(template, ctx, config.locale) };
}

/** type → template. A provided-but-unknown type is an error; absent → first. */
function resolveTemplate(config: FeedbackConfig, type?: string): TemplateDefinition | null {
  if (type) return config.templates.find((t) => t.type === type) ?? null;
  return config.templates[0] ?? null;
}

/** Public URLs for uploaded attachment keys (empty if no public base is set). */
function buildAttachments(config: FeedbackConfig, payload: FeedbackPayload): RenderContext["attachments"] {
  const base = config.storage.publicBaseUrl;
  if (!base) return [];
  return payload.attachmentKeys.map((k) => ({ url: publicUrl(base, k)!, kind: "upload" }));
}

function lbl(label: unknown, locale: string): string {
  if (typeof label === "string") return label;
  if (label && typeof label === "object") {
    const r = label as Record<string, string>;
    return r[locale] ?? Object.values(r)[0] ?? "";
  }
  return "";
}

/** A generic follow-up question from the missing fields' labels — used when the
 * LLM is off/over-budget (no model-composed question available). */
function fallbackQuestion(config: FeedbackConfig, template: TemplateDefinition, missingKeys: string[]): string {
  const de = config.locale.startsWith("de");
  const labels = template.fields.filter((f) => missingKeys.includes(f.key)).map((f) => lbl(f.label, config.locale)).filter(Boolean);
  if (!labels.length) return de ? "Magst du noch etwas ergänzen?" : "Anything you'd like to add?";
  return (de ? "Kurz noch: " : "One more thing: ") + labels.join(" · ");
}

interface ExtractExtras {
  screenshotDataUrl?: string;
  pageUrl?: string;
  deviceInfo?: FeedbackPayload["deviceInfo"];
  consoleErrors?: FeedbackPayload["consoleErrors"];
}

/** LLM extraction gated by the daily budget. Returns null when the LLM is
 * unavailable (provider off, no key, or budget spent) — the caller falls back. */
async function extractWithBudget(env: Env, config: FeedbackConfig, template: TemplateDefinition, message: string, deps: OrchestrateDeps, extras: ExtractExtras = {}): Promise<ExtractionResult | null> {
  if (config.llm.provider === "off" || !deps.apiKey) return null;
  const now = deps.now ?? Date.now();
  const within = (await hitRateLimit(env, `llm:${config.projectId}`, dayWindow(now), config.llm.dailyBudget)).allowed;
  if (!within) return null;
  return classifyAndExtract({ config, template, message, apiKey: deps.apiKey, chat: deps.chat, ...extras });
}

/** Session context (URL, device, console) fed to the extraction on both POSTs. */
function extractionContext(payload: FeedbackPayload): ExtractExtras {
  return { pageUrl: payload.pageUrl, deviceInfo: payload.deviceInfo, consoleErrors: payload.consoleErrors };
}

export async function orchestrateFeedback(
  env: Env,
  loaded: LoadedProject,
  payload: FeedbackPayload,
  deps: OrchestrateDeps,
): Promise<{ http: number; body: FeedbackResponse }> {
  const config = loaded.config;
  const now = deps.now ?? Date.now();
  const newId = deps.newId ?? (() => crypto.randomUUID());

  // Idempotency: replay a stored TERMINAL response (created/accepted_incomplete).
  // A D1 read failure here is a create-anyway signal, not a blocker.
  // Deliberate tradeoff: dedup is check-then-act (store happens AFTER createIssue),
  // so two *concurrent* identical feedbackId POSTs can both create an issue. We
  // choose never-lose over never-duplicate — a rare duplicate issue is a lighter
  // failure than a dropped submission, and GitHub has no idempotency key. The
  // common serial retry (client resends after a slow/failed response) IS caught.
  const dg = await dedupGet(env, payload.feedbackId);
  if (dg.resp) return { http: 200, body: dg.resp };
  const d1Degraded = dg.degraded;

  const template = resolveTemplate(config, payload.type);
  if (!template) return { http: 400, body: { v: WIRE_VERSION, status: "error", error: "unknown feedback type" } };

  const message = (payload.message ?? "").trim();
  const isCompletion = payload.followUpText !== undefined; // POST-2 carries the follow-up answer

  // ── POST-1: extract → ask ONE conversational follow-up, or create ────────────
  if (!isCompletion) {
    const shot = await screenshotDataUrl(env, payload);
    const result = await extractWithBudget(env, config, template, message, deps, { screenshotDataUrl: shot, ...extractionContext(payload) });
    const extracted = result?.extracted ?? {};
    // LLM unavailable (off/no-key/over-budget) → treat all required as missing → ask one generic question.
    const missing = result && !result.degraded ? result.missing : requiredAskable(template).map((f) => f.key);
    const create = (o: Partial<CreateOpts>) =>
      finalizeCreate(env, loaded, payload, template, { fields: extracted, degraded: false, incomplete: false, d1Degraded, now, newId, fetchImpl: deps.fetchImpl, ...o });

    if (result?.degraded) {
      // LLM ran but failed. onLlmError → create unenriched; else ask (generic question).
      if (config.createAnyway.onLlmError) return create({ fields: {}, degraded: true, incomplete: true });
      return { http: 200, body: { v: WIRE_VERSION, status: "follow_up", question: fallbackQuestion(config, template, missing), extracted: {} } };
    }
    if (missing.length === 0) return create({}); // nothing required missing (extracted all, or no required fields) → create
    // Too many to reasonably ask → create-anyway (if allowed) instead of a wall of questions.
    if (result && missing.length > FIELD_CEILING && config.createAnyway.onIncomplete) return create({ incomplete: true });
    // Ask ONE follow-up: the model-composed question, or a label-based fallback.
    const question = (result?.followUpQuestion && result.followUpQuestion.trim()) || fallbackQuestion(config, template, missing);
    return { http: 200, body: { v: WIRE_VERSION, status: "follow_up", question, extracted } };
  }

  // ── POST-2: ONE re-extraction of the freetext answer, then create (single-shot) ──
  const answer = (payload.followUpText ?? "").trim();
  const combined = [message, answer].filter(Boolean).join("\n\n");
  // Only re-extract when there's actually a new answer to parse. An empty answer
  // (the "send now"/"send anyway" bail) skips the LLM entirely and just uses what
  // POST-1 already understood (echoed) — no redundant call, no lost extraction.
  const reExtract = answer ? await extractWithBudget(env, config, template, combined, deps, extractionContext(payload)) : null; // context, text-only (no screenshot)
  let fields: Record<string, string> = { ...(payload.extracted ?? {}) };
  if (reExtract && !reExtract.degraded) fields = { ...fields, ...reExtract.extracted };
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) if (typeof v === "string" && v.trim()) cleaned[k] = v.trim();
  const stillMissing = requiredAskable(template)
    .filter((f) => !cleaned[f.key])
    .map((f) => f.key);
  // Always create now — never a second question (ADR-012). The answer is folded
  // into the issue via `combined` so it's never lost even if re-extraction fails.
  return finalizeCreate(env, loaded, payload, template, { fields: cleaned, message: combined, degraded: false, incomplete: stillMissing.length > 0, d1Degraded, now, newId, fetchImpl: deps.fetchImpl });
}

interface CreateOpts {
  fields: Record<string, string>;
  message?: string; // effective message for rendering (POST-2 folds in the follow-up answer)
  degraded: boolean; // LLM unenriched
  incomplete: boolean; // required fields still missing
  d1Degraded: boolean;
  now: number;
  newId: () => string;
  fetchImpl?: FetchFn;
}

async function finalizeCreate(
  env: Env,
  loaded: LoadedProject,
  payload: FeedbackPayload,
  template: TemplateDefinition,
  opts: CreateOpts,
): Promise<{ http: number; body: FeedbackResponse }> {
  const config = loaded.config;
  const id = opts.newId();

  const ctx: RenderContext = {
    message: opts.message ?? payload.message ?? "",
    fields: opts.fields,
    pageUrl: payload.pageUrl,
    deviceInfo: payload.deviceInfo,
    consoleErrors: payload.consoleErrors,
    attachments: buildAttachments(config, payload),
    degraded: opts.degraded,
  };
  const title = deriveTitle(template, ctx);
  const issueBody = renderIssueBody(template, ctx, config.locale);

  // noIssue template (e.g. praise): persist only, no tracker call.
  if (template.noIssue) {
    await persistFeedback(env, { id, projectId: config.projectId, outcome: "created", payload, issueUrl: null, now: opts.now });
    const resp: FeedbackResponse = { v: WIRE_VERSION, status: "created", id };
    await dedupPut(env, payload.feedbackId, resp, opts.now);
    return { http: 200, body: resp };
  }

  const pat = env[config.tracker.patSecret] as string | undefined;
  if (!pat) {
    // Persist for retry; surface a terminal-but-retryable status (not dedup-stored).
    await persistFeedback(env, { id, projectId: config.projectId, outcome: "issue_failed", payload, issueUrl: null, now: opts.now });
    return { http: 200, body: { v: WIRE_VERSION, status: "issue_failed", id, reason: "tracker credential not configured" } };
  }

  const repo = template.tracker.repo ?? config.tracker.defaultRepo;
  const labels = [...template.tracker.labels];
  if (opts.degraded) labels.push("ai-failed", "needs-triage");
  else if (opts.incomplete) labels.push("needs-triage");
  if (opts.d1Degraded) labels.push("d1-degraded");

  try {
    const issue = await createIssue({ pat, repo, title, body: issueBody, labels, fetchImpl: opts.fetchImpl });
    const outcome = opts.degraded ? "ai-failed" : opts.incomplete ? "accepted_incomplete" : "created";
    await persistFeedback(env, { id, projectId: config.projectId, outcome, payload, issueUrl: issue.url, now: opts.now });
    const status: "created" | "accepted_incomplete" = opts.degraded || opts.incomplete ? "accepted_incomplete" : "created";
    const resp: FeedbackResponse = { v: WIRE_VERSION, status, id, issueUrl: issue.url };
    await dedupPut(env, payload.feedbackId, resp, opts.now);
    return { http: 200, body: resp };
  } catch (e) {
    // Tracker failure NEVER loses feedback: persist the payload for admin retry.
    const reason = e instanceof TrackerError ? `tracker error ${e.status}` : "tracker request failed";
    await persistFeedback(env, { id, projectId: config.projectId, outcome: "issue_failed", payload, issueUrl: null, now: opts.now });
    return { http: 200, body: { v: WIRE_VERSION, status: "issue_failed", id, reason } };
  }
}

const MAX_LLM_IMAGE_BYTES = 1_500_000; // guard the vision payload (upload path caps at 2 MB)

/** Read the first uploaded attachment (the screenshot) from R2 and inline it as a
 * base64 data URL for the LLM's vision input. Robust where a public bucket URL is
 * not configured (or hasn't propagated) — that previously left the model blind to
 * the image, so follow-ups leaned only on the text. Best-effort: any failure →
 * undefined (extraction proceeds text-only, never blocks). */
async function screenshotDataUrl(env: Env, payload: FeedbackPayload): Promise<string | undefined> {
  const key = payload.attachmentKeys[0];
  if (!key) return undefined;
  try {
    const obj = await env.UPLOADS.get(key);
    if (!obj) return undefined;
    const buf = await obj.arrayBuffer();
    if (buf.byteLength > MAX_LLM_IMAGE_BYTES) return undefined;
    const mime = obj.httpMetadata?.contentType || "image/webp";
    return `data:${mime};base64,${base64FromBytes(new Uint8Array(buf))}`;
  } catch (e) {
    console.warn(`[feedbackkit] screenshot read for LLM vision failed (text-only): ${(e as Error).message}`);
    return undefined;
  }
}

/** ArrayBuffer bytes → base64, chunked so a large buffer can't blow the call stack. */
function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

// ── D1 journey (all best-effort: a write failure degrades, never blocks) ───────
async function dedupGet(env: Env, feedbackId: string): Promise<{ resp: FeedbackResponse | null; degraded: boolean }> {
  try {
    const row = await env.DB.prepare("SELECT response FROM dedup WHERE feedback_id = ?1").bind(feedbackId).first<{ response: string }>();
    return { resp: row ? (JSON.parse(row.response) as FeedbackResponse) : null, degraded: false };
  } catch (e) {
    console.warn(`[feedbackkit] dedup read failed (D1 degraded): ${(e as Error).message}`);
    return { resp: null, degraded: true };
  }
}

async function dedupPut(env: Env, feedbackId: string, resp: FeedbackResponse, now: number): Promise<void> {
  try {
    await env.DB.prepare("INSERT INTO dedup (feedback_id, response, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(feedback_id) DO NOTHING")
      .bind(feedbackId, JSON.stringify(resp), now)
      .run();
  } catch (e) {
    console.warn(`[feedbackkit] dedup write failed: ${(e as Error).message}`);
  }
}

interface FeedbackRow {
  id: string;
  projectId: string;
  outcome: string;
  payload: FeedbackPayload;
  issueUrl: string | null;
  now: number;
}
async function persistFeedback(env: Env, o: FeedbackRow): Promise<void> {
  try {
    await env.DB.prepare("INSERT INTO feedback (id, project_id, outcome, payload, issue_url, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(id) DO NOTHING")
      .bind(o.id, o.projectId, o.outcome, JSON.stringify(o.payload), o.issueUrl, o.now)
      .run();
  } catch (e) {
    console.warn(`[feedbackkit] feedback journey write failed (D1 degraded): ${(e as Error).message}`);
  }
}
