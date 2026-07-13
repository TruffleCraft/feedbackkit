import { WIRE_VERSION, type FeedbackConfig, type PublicConfig } from "./contract.js";

// The public projection returned by GET /api/config. Whitelist-only: it carries
// exactly what the widget needs to render and NOTHING internal — no extractionHint,
// no tracker/repo, no llm config, no secrets, no origin allowlist.
export function toPublicConfig(config: FeedbackConfig, configVersion: number): PublicConfig {
  return {
    v: WIRE_VERSION,
    enabled: config.enabled,
    locale: config.locale,
    askType: config.askType,
    configVersion,
    types: config.templates.map((t) => ({
      type: t.type,
      label: t.label,
      fields: t.fields.map((f) => ({
        key: f.key,
        label: f.label,
        kind: f.kind,
        required: f.required,
      })),
    })),
  };
}
