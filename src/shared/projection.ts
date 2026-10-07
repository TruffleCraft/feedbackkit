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
    // What the widget may auto-collect, the host's privacy link and the public
    // Turnstile site key are user-facing by nature; the Turnstile secret name is not.
    capture: { screenshot: config.capture.screenshot, console: config.capture.console },
    ...(config.privacyUrl ? { privacyUrl: config.privacyUrl } : {}),
    ...(config.turnstile ? { turnstileSiteKey: config.turnstile.siteKey } : {}),
    types: config.templates.map((t) => ({
      type: t.type,
      label: t.label,
      // guidance is user-facing copy (not an internal), so it's part of the projection.
      ...(t.guidance ? { guidance: t.guidance } : {}),
      fields: t.fields.map((f) => ({
        key: f.key,
        label: f.label,
        kind: f.kind,
        required: f.required,
        // select choices must reach the widget; everything else stays internal.
        ...(f.options ? { options: f.options } : {}),
      })),
    })),
  };
}
