// Wire contract v:1 — the single source of truth for every shape the widget,
// worker, and admin exchange. Zod stays internal (never in exported signatures
// of the public API); this module is the hard validation gate.
import { z } from "zod";

export const WIRE_VERSION = 1 as const;
export const SCHEMA_VERSION = 1 as const;

// ── Template schema (per ADR-002/005) ────────────────────────────────────────
export const FieldKind = z.enum(["text", "longtext", "select", "url"]);

// A localized label: a plain string (single locale) or a { locale: string } map.
export const Label = z.union([z.string(), z.record(z.string())]);

export const FieldSpec = z.object({
  key: z.string().min(1),
  label: Label,
  kind: FieldKind,
  required: z.boolean().default(false),
  // "required" drives the follow-up loop; "nice-to-extract" is filled but never asked.
  askIfMissing: z.boolean().default(true),
  extractionHint: z.string().default(""),
  options: z.array(z.object({ value: z.string(), label: Label })).optional(),
});
export type FieldSpec = z.infer<typeof FieldSpec>;

export const BodySection = z.object({
  heading: Label.optional(),
  template: z.string(), // may reference {{fieldKey}}
});

export const TemplateDefinition = z.object({
  type: z.string().min(1), // bug | idea | improvement | question | praise | custom
  label: Label,
  fields: z.array(FieldSpec).default([]),
  body: z.array(BodySection).default([]),
  tracker: z
    .object({
      repo: z.string().optional(),
      labels: z.array(z.string()).default([]),
      boardItemType: z.string().optional(),
    })
    .default({ labels: [] }),
  noIssue: z.boolean().default(false), // praise → persist only
});
export type TemplateDefinition = z.infer<typeof TemplateDefinition>;

export const FeedbackConfig = z.object({
  projectId: z.string().min(1),
  locale: z.string().default("en"),
  enabled: z.boolean().default(true),
  askType: z.boolean().default(false),
  templates: z.array(TemplateDefinition).min(1),
  createAnyway: z
    .object({ onIncomplete: z.boolean().default(true), onLlmError: z.boolean().default(true) })
    .default({ onIncomplete: true, onLlmError: true }),
  llm: z.object({
    provider: z.enum(["openrouter", "github-models", "custom", "off"]).default("openrouter"),
    model: z.string().default(""),
    baseUrl: z.string().url().optional(),
    dailyBudget: z.number().int().positive().default(200),
    // Send OpenAI `response_format: json_schema`. Many free/local endpoints
    // (Ollama, vLLM, free OpenRouter tiers) don't honor strict schema and return
    // EMPTY content when it's forced — set false there and rely on the prompt +
    // fence-tolerant parse instead (ADR-007/008).
    structuredOutput: z.boolean().default(true),
  }),
  tracker: z.object({
    kind: z.literal("github"),
    defaultRepo: z.string().min(1),
    patSecret: z.string().min(1), // name of the GITHUB_PAT_<name> worker secret
  }),
  storage: z
    .object({
      kind: z.enum(["r2", "none"]).default("r2"),
      publicBaseUrl: z.string().url().optional(),
      // App-level retention (ADR-006): assets get expires_at = now + days; the
      // daily cron deletes them. Omit = keep until an explicit GDPR delete.
      retentionDays: z.number().int().positive().optional(),
    })
    .default({ kind: "r2" }),
  auth: z.object({ origins: z.array(z.string()).default([]) }),
  rateLimit: z.object({ perHour: z.number().int().positive().default(75) }).default({ perHour: 75 }),
});
export type FeedbackConfig = z.infer<typeof FeedbackConfig>;

// ── Public projection (what /api/config returns — never internals) ────────────
export const PublicConfig = z.object({
  v: z.literal(WIRE_VERSION),
  enabled: z.boolean(),
  locale: z.string(),
  askType: z.boolean(),
  configVersion: z.number().int(),
  types: z.array(
    z.object({
      type: z.string(),
      label: Label,
      fields: z.array(
        z.object({
          key: z.string(),
          label: Label,
          kind: FieldKind,
          required: z.boolean(),
          // select fields need their choices to render; still no internals.
          options: z.array(z.object({ value: z.string(), label: Label })).optional(),
        }),
      ),
    }),
  ),
});
export type PublicConfig = z.infer<typeof PublicConfig>;

// ── Feedback payload (widget → worker) ────────────────────────────────────────
export const DeviceInfo = z.object({
  browser: z.string().optional(),
  os: z.string().optional(),
  viewport: z.object({ w: z.number(), h: z.number() }).optional(),
  language: z.string().optional(),
});
export const ConsoleEntry = z.object({ level: z.string(), msg: z.string(), ts: z.number() });

export const FeedbackPayload = z.object({
  v: z.literal(WIRE_VERSION),
  feedbackId: z.string().uuid(),
  type: z.string().optional(),
  message: z.string().max(10_000).optional(),
  pageUrl: z.string().max(2048),
  fields: z.record(z.string().max(4000)).optional(), // 2nd POST: completed fields
  extracted: z.record(z.string()).optional(), // echoed back on 2nd POST
  attachmentKeys: z.array(z.string()).max(5).default([]),
  deviceInfo: DeviceInfo.optional(),
  consoleErrors: z.array(ConsoleEntry).max(10).default([]),
  hpField: z.string().max(0).optional(), // honeypot: must be empty
});
export type FeedbackPayload = z.infer<typeof FeedbackPayload>;

// ── Feedback response (worker → widget) ───────────────────────────────────────
export type FeedbackResponse =
  | { v: 1; status: "created"; id: string; issueUrl?: string }
  | { v: 1; status: "need_fields"; missing: string[]; extracted: Record<string, string> }
  | { v: 1; status: "accepted_incomplete"; id: string; issueUrl?: string }
  | { v: 1; status: "issue_failed"; id: string; reason: string }
  | { v: 1; status: "error"; error: string; degraded?: boolean };

// ── Funnel events (enum-only, never content) ──────────────────────────────────
export const EventName = z.enum([
  "opened",
  "typed",
  "submitted",
  "need_fields",
  "completed",
  "sent_anyway",
  "abandoned",
]);
export type EventName = z.infer<typeof EventName>;

export const EventPayload = z.object({
  v: z.literal(WIRE_VERSION),
  project: z.string(),
  name: EventName,
});
