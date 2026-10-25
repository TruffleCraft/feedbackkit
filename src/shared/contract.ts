// Wire contract v:1 — the single source of truth for every shape the widget,
// worker, and admin exchange. Zod stays internal (never in exported signatures
// of the public API); this module is the hard validation gate.
import { z } from "zod";
import { CONTEXT_KEY_RE, MAX_CONTEXT_KEYS, MAX_CONTEXT_VALUE } from "./limits.js";

export const WIRE_VERSION = 1 as const;
export const SCHEMA_VERSION = 4 as const;

// What this release does with the delivery model (#109). The promote workflow
// writes it to meta.delivery_capability once a release is live on stable; config
// writers refuse shapes the stored value does not cover (FK_CONFIG_SHAPE_UNSUPPORTED),
// because dev and stable share one D1 and stable must understand every stored config.
//   0  issue delivery and noIssue only (≤ 0.1.13)
//   1  reads delivery / tracker.project / absent tracker; delivers issue and local
//   2  also delivers to a GitHub Project
export const DELIVERY_CAPABILITY = 2 as const;

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
      // GitHub issue type by name ("Bug", "Feature", "Task"). Issue types exist only
      // in organisation repos; elsewhere GitHub drops it silently.
      type: z.string().min(1).optional(),
      // Organisation issue fields (e.g. Priority, a "Source" select), by numeric
      // field id: `gh api orgs/<org>/issue-fields`. Single select takes the option
      // name. Non-org repos drop them silently.
      issueFields: z
        .array(
          z.object({
            fieldId: z.number().int().positive(),
            value: z.union([z.string().min(1), z.number(), z.array(z.string().min(1)).min(1)]),
          }),
        )
        .default([]),
    })
    .default({ labels: [] }),
  noIssue: z.boolean().default(false), // praise → persist only (read as delivery "local")
  // Where reports of this type go; see resolveDelivery for the order.
  delivery: z.enum(["issue", "project", "local"]).optional(),
});
export type TemplateDefinition = z.infer<typeof TemplateDefinition>;

export const Delivery = z.enum(["issue", "project", "local"]);
export type Delivery = z.infer<typeof Delivery>;

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
  // Project-wide default for templates without their own delivery.
  delivery: z.enum(["issue", "project", "local"]).optional(),
  // Optional when every type is delivered locally.
  tracker: z
    .object({
      kind: z.literal("github"),
      defaultRepo: z.string().min(1).optional(), // required when a type opens issues
      patSecret: z.string().min(1), // name of the GITHUB_PAT_<name> worker secret
      // Private organisation GitHub Project for delivery "project" (number from its URL).
      project: z
        .object({
          org: z.string().min(1),
          number: z.number().int().positive(),
          // Separate token for the Projects permission (least privilege); default: tracker.patSecret.
          patSecret: z.string().min(1).optional(),
          // Option of the feedback type field per template type; default: the type itself.
          typeOptions: z.record(z.string().min(1)).default({}),
          // Names of the three fields FeedbackKit fills; missing fields are skipped with a warning.
          fields: z
            // Not "Type": organisation projects already have a built-in Type field (issue types).
            .object({ type: z.string().min(1).default("Feedback type"), page: z.string().min(1).default("Page"), source: z.string().min(1).default("Source") })
            .default({ type: "Feedback type", page: "Page", source: "Source" }),
        })
        .optional(),
    })
    .optional(),
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
}).superRefine((cfg, ctx) => {
  const explicit = cfg.delivery !== undefined || cfg.templates.every((t) => t.delivery !== undefined);
  if (cfg.tracker?.project && !explicit) {
    // A Project next to a repo must never fall back to public issues by accident.
    ctx.addIssue({ code: "custom", path: ["delivery"], message: 'tracker.project is set: set delivery explicitly ("issue", "project" or "local")' });
  }
  cfg.templates.forEach((t, i) => {
    if (t.noIssue && t.delivery === "issue") {
      ctx.addIssue({ code: "custom", path: ["templates", i, "delivery"], message: 'noIssue: true contradicts delivery "issue"; remove one of them' });
      return;
    }
    const d = resolveDelivery(cfg, t);
    if (d === "issue" && !cfg.tracker) ctx.addIssue({ code: "custom", path: ["tracker"], message: `type "${t.type}" opens issues: tracker is required` });
    else if (d === "issue" && !t.tracker.repo && !cfg.tracker?.defaultRepo) {
      ctx.addIssue({ code: "custom", path: ["tracker", "defaultRepo"], message: `type "${t.type}" opens issues: set tracker.defaultRepo or templates[${i}].tracker.repo` });
    }
    if (d === "project" && !cfg.tracker?.project) ctx.addIssue({ code: "custom", path: ["tracker", "project"], message: `type "${t.type}" is delivered to a GitHub Project: tracker.project is required` });
  });
});
export type FeedbackConfig = z.infer<typeof FeedbackConfig>;

/** Where a template's reports go. Order: the template's delivery, then its
 * noIssue (local; a project default never overrides it), then the project's
 * delivery, then issue with a tracker and local without. */
export function resolveDelivery(
  config: { delivery?: Delivery; tracker?: unknown },
  template: { delivery?: Delivery; noIssue?: boolean },
): Delivery {
  if (template.delivery) return template.delivery;
  if (template.noIssue) return "local";
  if (config.delivery) return config.delivery;
  return config.tracker ? "issue" : "local";
}

/** Capability a stored config needs (see DELIVERY_CAPABILITY). Works on the raw
 * JSON, so writers can check before or without parsing. Mirrored in
 * scripts/seed-config.mjs (a test keeps both in step). */
export function requiredDeliveryCapability(raw: unknown): number {
  if (!raw || typeof raw !== "object") return 0;
  const cfg = raw as { delivery?: unknown; tracker?: { project?: unknown } | null; templates?: unknown };
  const templates = Array.isArray(cfg.templates) ? (cfg.templates as Array<{ delivery?: unknown } | null>) : [];
  const deliveries = [cfg.delivery, ...templates.map((t) => t?.delivery)].filter((d) => d !== undefined);
  if (deliveries.includes("project") || cfg.tracker?.project !== undefined) return 2;
  if (deliveries.length > 0 || !cfg.tracker) return 1;
  return 0;
}

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
  // `code` is a stable machine-readable reason (docs/ERRORS.md); `retryable` tells
  // the client that resending the same submission may succeed.
  | { v: 1; status: "error"; error: string; degraded?: boolean; code?: ErrorCode; retryable?: boolean };

export type ErrorCode = "FK_PERSIST_FAILED" | "FK_CONFIG_SHAPE_UNSUPPORTED";

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
