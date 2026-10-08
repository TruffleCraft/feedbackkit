// Wire contract v:1 — the single source of truth for every shape the widget,
// worker, and admin exchange. Zod stays internal (never in exported signatures
// of the public API); this module is the hard validation gate.
import { z } from "zod";
import { CONTEXT_KEY_RE, MAX_CONTEXT_KEYS, MAX_CONTEXT_VALUE } from "./limits.js";

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
  // Optional short inline hint rendered in the widget under the type selector
  // ("what a good report of this kind needs"). Sets expectations up front so the
  // user supplies the key facts in one shot — fewer follow-up round-trips, better
  // issues out the back (P2 categories). Guidance only; never asked/validated.
  guidance: Label.optional(),
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
  // What the widget may collect automatically. Apps whose pages show sensitive
  // content (health data, private answers) turn the page screenshot and/or the
  // console capture off; user-picked image attachments stay possible.
  capture: z
    .object({
      screenshot: z.enum(["optional", "off"]).default("optional"),
      console: z.boolean().default(true),
    })
    .default({ screenshot: "optional", console: true }),
  // Linked from the widget's privacy line (the host's own privacy policy).
  privacyUrl: z.string().url().startsWith("https://").optional(),
  // Return the created issue's URL to the widget ("View ticket"). Switch off for
  // public sites whose tracker is private or should stay unnamed.
  issueLink: z.boolean().default(true),
  // Optional Cloudflare Turnstile gate on POST /api/feedback. `secret` names the
  // TURNSTILE_SECRET_<name> worker secret (like tracker.patSecret).
  turnstile: z.object({ siteKey: z.string().min(1), secret: z.string().regex(/^TURNSTILE_SECRET_[A-Za-z0-9_]+$/) }).optional(),
});
export type FeedbackConfig = z.infer<typeof FeedbackConfig>;

// ── Public projection (what /api/config returns — never internals) ────────────
export const PublicConfig = z.object({
  v: z.literal(WIRE_VERSION),
  enabled: z.boolean(),
  locale: z.string(),
  askType: z.boolean(),
  // True when the gateway infers the type itself (LLM on, askType off, several
  // types): the widget then shows no type picker. Optional for older gateways.
  autoType: z.boolean().optional(),
  configVersion: z.number().int(),
  // Optional for compatibility with gateways that predate these fields.
  capture: z.object({ screenshot: z.enum(["optional", "off"]), console: z.boolean() }).optional(),
  privacyUrl: z.string().optional(),
  turnstileSiteKey: z.string().optional(),
  types: z.array(
    z.object({
      type: z.string(),
      label: Label,
      // Inline "what's needed" hint for this type (see TemplateDefinition.guidance).
      guidance: Label.optional(),
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
export const ConsoleEntry = z.object({ level: z.string().max(24), msg: z.string().max(2000), ts: z.number() });
// Type aliases so the widget can `import type` these shapes WITHOUT pulling zod
// into its browser bundle (verbatimModuleSyntax erases type-only imports).
export type DeviceInfoT = z.infer<typeof DeviceInfo>;
export type ConsoleEntryT = z.infer<typeof ConsoleEntry>;

// Host-supplied debug context (e.g. an opaque user id, app version), set by the
// embedding page via window.FeedbackKitContext. Flat, bounded, never verified —
// rendered into the issue as such and NEVER sent to the LLM.
export const HostContext = z
  .record(z.union([z.string().max(MAX_CONTEXT_VALUE), z.number().finite(), z.boolean()]))
  .refine((o) => Object.keys(o).length <= MAX_CONTEXT_KEYS && Object.keys(o).every((k) => CONTEXT_KEY_RE.test(k)), "invalid context");
export type HostContextT = Record<string, string | number | boolean>;

export const FeedbackPayload = z.object({
  v: z.literal(WIRE_VERSION),
  feedbackId: z.string().uuid(),
  type: z.string().optional(),
  message: z.string().max(10_000).optional(),
  pageUrl: z.string().max(2048),
  followUpText: z.string().max(4000).optional(), // 2nd POST: freetext answer to the follow-up question
  extracted: z.record(z.string().max(4000)).optional(), // echoed back on 2nd POST — capped (no size-bypass)
  summary: z.string().max(500).optional(), // LLM output echoed by the widget on POST-2
  autoTyped: z.boolean().optional(), // POST-2: the type came from the gateway, so the answer may still change it
  attachmentKeys: z.array(z.string()).max(5).default([]),
  deviceInfo: DeviceInfo.optional(),
  consoleErrors: z.array(ConsoleEntry).max(10).default([]),
  context: HostContext.optional(),
  turnstileToken: z.string().max(2048).optional(), // fresh token per POST when the project enables Turnstile
  hpField: z.string().max(0).optional(), // honeypot: must be empty
});
export type FeedbackPayload = z.infer<typeof FeedbackPayload>;

// ── Feedback response (worker → widget) ───────────────────────────────────────
export type FeedbackResponse =
  // `type` and `summary` let the widget show how the feedback was understood.
  | { v: 1; status: "created"; id: string; issueUrl?: string; type?: string; summary?: string }
  // One conversational follow-up (ADR-012): a single natural-language question,
  // answered in freetext — not a multi-field form.
  | { v: 1; status: "follow_up"; question: string; extracted: Record<string, string>; summary?: string; type?: string; typeUnclear?: boolean }
  | { v: 1; status: "accepted_incomplete"; id: string; issueUrl?: string; type?: string; summary?: string }
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
