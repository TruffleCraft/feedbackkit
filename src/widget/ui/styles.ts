// Default theme as a CSS string injected into the Shadow DOM. All knobs are CSS
// custom properties (`--fk-*`) so the P2 theming editor can override them by
// setting values on the host element — no CSS-file edits (Zero-Touch-Code).
export const STYLES = `
:host {
  --fk-primary: #4f46e5;
  --fk-primary-contrast: #fff;
  --fk-bg: #ffffff;
  --fk-text: #1f2937;
  --fk-muted: #6b7280;
  --fk-border: #e5e7eb;
  --fk-radius: 12px;
  --fk-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --fk-shadow: 0 10px 40px rgba(0,0,0,.18);
}
@media (prefers-color-scheme: dark) {
  :host {
    --fk-bg: #1f2430; --fk-text: #e5e7eb; --fk-muted: #9ca3af; --fk-border: #374151;
    --fk-shadow: 0 10px 40px rgba(0,0,0,.5);
  }
}
* { box-sizing: border-box; }
.fk-trigger {
  position: fixed; bottom: 20px; inset-inline-end: 20px;
  font-family: var(--fk-font); font-size: 14px; font-weight: 600;
  background: var(--fk-primary); color: var(--fk-primary-contrast);
  border: 0; border-radius: 999px; padding: 12px 18px; cursor: pointer;
  box-shadow: var(--fk-shadow);
}
.fk-trigger:focus-visible { outline: 3px solid var(--fk-primary); outline-offset: 2px; }
/* Anchor the panel to the corner the trigger sits in (bottom-right) so it opens
   where the button was, on every viewport — not a centered modal. */
.fk-backdrop {
  position: fixed; inset: 0; background: rgba(0,0,0,.2);
  display: flex; align-items: flex-end; justify-content: flex-end; padding: 20px;
}
.fk-panel {
  font-family: var(--fk-font); color: var(--fk-text); background: var(--fk-bg);
  width: 100%; max-width: 400px; max-height: min(90dvh, 640px); overflow: auto;
  border: 1px solid var(--fk-border); border-radius: var(--fk-radius);
  box-shadow: var(--fk-shadow); padding: 18px;
}
.fk-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.fk-title { font-size: 16px; font-weight: 700; margin: 0; }
.fk-x { background: none; border: 0; color: var(--fk-muted); font-size: 22px; line-height: 1; cursor: pointer; padding: 4px; }
.fk-types { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.fk-type { border: 1px solid var(--fk-border); background: transparent; color: var(--fk-text);
  border-radius: 999px; padding: 6px 12px; font-size: 13px; cursor: pointer; }
.fk-type[aria-pressed="true"] { border-color: var(--fk-primary); color: var(--fk-primary); font-weight: 600; }
.fk-label { display: block; font-size: 13px; font-weight: 600; margin: 10px 0 4px; }
.fk-hint { font-size: 12px; color: var(--fk-muted); margin: 0 0 12px; }
textarea.fk-input, input.fk-input {
  width: 100%; font: inherit; color: var(--fk-text); background: var(--fk-bg);
  border: 1px solid var(--fk-border); border-radius: 8px; padding: 10px; resize: vertical;
}
textarea.fk-input { min-height: 96px; }
.fk-input:focus-visible { outline: 2px solid var(--fk-primary); outline-offset: 1px; }
.fk-check { display: flex; align-items: center; gap: 8px; margin-top: 12px; font-size: 13px; color: var(--fk-muted); cursor: pointer; }
.fk-check-input { width: 16px; height: 16px; accent-color: var(--fk-primary); flex: none; }
.fk-actions { display: flex; align-items: center; gap: 12px; margin-top: 14px; }
.fk-btn {
  background: var(--fk-primary); color: var(--fk-primary-contrast); border: 0;
  border-radius: 8px; padding: 10px 16px; font: inherit; font-weight: 600; cursor: pointer;
}
.fk-btn[disabled] { opacity: .5; cursor: default; }
.fk-btn.fk-ghost { background: transparent; color: var(--fk-primary); padding: 6px; }
.fk-link { background: none; border: 0; color: var(--fk-muted); text-decoration: underline; font: inherit; font-size: 13px; cursor: pointer; padding: 0; }
.fk-status { display: flex; align-items: center; gap: 10px; color: var(--fk-muted); font-size: 14px; }
.fk-spinner { width: 18px; height: 18px; border: 2px solid var(--fk-border); border-top-color: var(--fk-primary); border-radius: 50%; animation: fk-spin .8s linear infinite; }
@keyframes fk-spin { to { transform: rotate(360deg); } }
.fk-done-icon { font-size: 28px; }
.fk-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.fk-field-auto { font-size: 11px; color: var(--fk-primary); margin-left: 6px; font-weight: 600; }
[hidden] { display: none !important; }
`;
