// Default theme, injected into the Shadow DOM. All knobs are CSS custom
// properties (`--fk-*`) so the P2 theming editor can override them on the host.
// The polished default is inspired by the SCTT widget (Linear/Sentry-style):
// glassy card, teal accent, serif heading + mono meta, expanding pill trigger,
// spring slide-up. Light + dark (dark uses SCTT's navy). Multi-operator, so it
// respects prefers-color-scheme and a data-theme override rather than forcing dark.
export const STYLES = `
:host {
  --fk-bg: #ffffff;
  --fk-bg-elev: #f6f8fa;
  --fk-text: #1f2937;
  --fk-text-soft: #4b5563;
  --fk-muted: #6b7280;
  --fk-border: #e2e8f0;
  --fk-border-strong: #cbd5e1;
  --fk-primary: #0f766e;              /* deep teal — button bg on light */
  --fk-primary-contrast: #ffffff;
  --fk-accent-ring: rgba(15,118,110,.30);
  --fk-radius: 14px;
  --fk-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --fk-font-serif: Georgia, "Times New Roman", serif;
  --fk-font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --fk-shadow: 0 16px 48px rgba(0,0,0,.18);
}
@media (prefers-color-scheme: dark) {
  :host {
    --fk-bg: #1B2735; --fk-bg-elev: #243343;
    --fk-text: rgba(255,255,255,.92); --fk-text-soft: rgba(255,255,255,.62); --fk-muted: rgba(255,255,255,.45);
    --fk-border: rgba(255,255,255,.12); --fk-border-strong: rgba(255,255,255,.22);
    --fk-primary: #86D9D2; --fk-primary-contrast: #10202b; --fk-accent-ring: rgba(134,217,210,.35);
    --fk-shadow: 0 16px 48px rgba(0,0,0,.45);
  }
}
:host([data-theme="dark"]) {
  --fk-bg: #1B2735; --fk-bg-elev: #243343;
  --fk-text: rgba(255,255,255,.92); --fk-text-soft: rgba(255,255,255,.62); --fk-muted: rgba(255,255,255,.45);
  --fk-border: rgba(255,255,255,.12); --fk-border-strong: rgba(255,255,255,.22);
  --fk-primary: #86D9D2; --fk-primary-contrast: #10202b; --fk-accent-ring: rgba(134,217,210,.35);
  --fk-shadow: 0 16px 48px rgba(0,0,0,.45);
}
* { box-sizing: border-box; }

/* Expanding pill trigger — icon only, reveals its label on hover/focus. */
.fk-trigger {
  position: fixed;
  bottom: max(20px, env(safe-area-inset-bottom, 20px));
  inset-inline-end: max(20px, env(safe-area-inset-right, 20px));
  display: flex; align-items: center; gap: 0;
  padding: 12px; cursor: pointer; overflow: hidden;
  font: 600 14px var(--fk-font);
  color: var(--fk-text); background: var(--fk-bg);
  border: 1px solid var(--fk-border); border-radius: 999px;
  box-shadow: var(--fk-shadow), 0 0 0 1px var(--fk-accent-ring);
  transition: transform .2s ease, box-shadow .2s ease, padding .25s ease, gap .25s ease;
}
.fk-trigger:hover { transform: translateY(-2px); padding: 12px 18px; gap: 10px; box-shadow: 0 20px 56px rgba(0,0,0,.4), 0 0 0 1px var(--fk-primary); }
.fk-trigger:focus-visible { outline: none; padding: 12px 18px; gap: 10px; box-shadow: var(--fk-shadow), 0 0 0 2px var(--fk-primary); }
.fk-trigger-icon { width: 22px; height: 22px; border-radius: 50%; flex: none; display: flex; align-items: center; justify-content: center; font-size: 13px; background: var(--fk-primary); color: var(--fk-primary-contrast); }
.fk-trigger-label { max-width: 0; opacity: 0; overflow: hidden; white-space: nowrap; transition: max-width .3s ease, opacity .2s ease .05s; }
.fk-trigger:hover .fk-trigger-label, .fk-trigger:focus-visible .fk-trigger-label { max-width: 160px; opacity: 1; }
@media (max-width: 600px) { .fk-trigger-label { display: none; } .fk-trigger { padding: 14px; } }

/* Backdrop anchors the panel to the trigger's corner (bottom-right). */
.fk-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.2); display: flex; align-items: flex-end; justify-content: flex-end; padding: 20px; }
.fk-panel {
  font-family: var(--fk-font); color: var(--fk-text); background: var(--fk-bg);
  width: 360px; max-width: calc(100vw - 32px); max-height: min(88dvh, 640px); overflow: auto;
  border: 1px solid var(--fk-border); border-radius: var(--fk-radius); box-shadow: var(--fk-shadow); padding: 18px;
  animation: fk-slideUp .22s cubic-bezier(.2,.8,.2,1);
}
@keyframes fk-slideUp { from { transform: translateY(12px); opacity: 0; } to { transform: none; opacity: 1; } }
.fk-head { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 12px; }
.fk-title { font-family: var(--fk-font-serif); font-size: 18px; font-weight: 500; margin: 0; }
.fk-x { background: none; border: 0; color: var(--fk-muted); font-size: 22px; line-height: 1; cursor: pointer; padding: 2px 4px; }
.fk-x:hover { color: var(--fk-text); }
.fk-types { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.fk-type { border: 1px solid var(--fk-border); background: transparent; color: var(--fk-text-soft); border-radius: 999px; padding: 6px 12px; font: inherit; font-size: 13px; cursor: pointer; }
.fk-type[aria-pressed="true"] { border-color: var(--fk-primary); color: var(--fk-primary); font-weight: 600; }
.fk-label { display: block; font-size: 13px; font-weight: 600; margin: 8px 0 6px; }
.fk-hint { font-size: 12px; color: var(--fk-muted); margin: 0 0 10px; }
.fk-question { font-size: 15px; font-weight: 500; margin: 4px 0 8px; color: var(--fk-text); }
textarea.fk-input, input.fk-input {
  width: 100%; font: inherit; color: var(--fk-text); background: var(--fk-bg-elev);
  border: 1px solid var(--fk-border); border-radius: 8px; padding: 10px; resize: vertical;
}
textarea.fk-input { min-height: 92px; }
.fk-input::placeholder { color: var(--fk-muted); }
.fk-input:focus-visible { outline: none; border-color: var(--fk-primary); box-shadow: 0 0 0 1px var(--fk-primary); }
.fk-actions { display: flex; align-items: center; gap: 12px; margin-top: 14px; }
.fk-btn { background: var(--fk-primary); color: var(--fk-primary-contrast); border: 0; border-radius: 8px; padding: 10px 16px; font: inherit; font-weight: 600; cursor: pointer; transition: transform .15s ease, background .15s ease; }
.fk-btn:hover:not([disabled]) { transform: translateY(-1px); }
.fk-btn[disabled] { opacity: .5; cursor: default; }
.fk-btn.fk-ghost { background: transparent; color: var(--fk-primary); border: 1px solid var(--fk-border-strong); }
.fk-link { background: none; border: 0; color: var(--fk-muted); text-decoration: underline; font: inherit; font-size: 13px; cursor: pointer; padding: 0; }
.fk-link:hover { color: var(--fk-text-soft); }
/* Media action row (screenshot toggle + file attach), dashed→solid like SCTT. */
.fk-media { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
.fk-check { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--fk-muted); cursor: pointer; }
.fk-check-input { width: 16px; height: 16px; accent-color: var(--fk-primary); flex: none; }
.fk-attach { display: inline-flex; align-items: center; gap: 8px; align-self: flex-start; border: 1px dashed var(--fk-border-strong); border-radius: 8px; padding: 8px 12px; font-size: 13px; color: var(--fk-text-soft); cursor: pointer; }
.fk-attach:hover { border-style: solid; border-color: var(--fk-primary); }
.fk-attach-name { font-family: var(--fk-font-mono); font-size: 11px; color: var(--fk-muted); }
.fk-status { display: flex; align-items: center; gap: 10px; color: var(--fk-text-soft); font-size: 14px; }
.fk-spinner { width: 18px; height: 18px; border: 2px solid var(--fk-border); border-top-color: var(--fk-primary); border-radius: 50%; animation: fk-spin .8s linear infinite; flex: none; }
@keyframes fk-spin { to { transform: rotate(360deg); } }
.fk-done { text-align: center; padding: 8px 0; }
.fk-done .fk-actions { justify-content: center; }
.fk-done-icon { width: 56px; height: 56px; margin: 0 auto 8px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 28px; background: color-mix(in srgb, var(--fk-primary) 18%, transparent); color: var(--fk-primary); }
.fk-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
[hidden] { display: none !important; }
`;
