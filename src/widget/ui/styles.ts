// FeedbackKit's own visual language, shared with the marketing site: DM Sans,
// violet accent, neutral surfaces, fine borders and restrained motion.
export const STYLES = `
:host {
  --fk-bg:#fff; --fk-soft:#f6f7f7; --fk-ink:#0a0a0b; --fk-ink-2:#52525b;
  --fk-muted:#8a8a90; --fk-line:#e7e8ea; --fk-line-2:#d9dbde;
  --fk-accent:#7c3aed; --fk-accent-ink:#fff; --fk-accent-soft:rgba(124,58,237,.1);
  --fk-font:"DM Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  --fk-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --fk-shadow:0 24px 56px -24px rgba(12,17,23,.4);
}
@media (prefers-color-scheme:dark) {
  :host { --fk-bg:#0c1117; --fk-soft:#11161d; --fk-ink:#e8eaed; --fk-ink-2:#a3a9b2;
    --fk-muted:#6b7280; --fk-line:#1f2630; --fk-line-2:#2b3442; --fk-accent:#8b5cf6;
    --fk-accent-soft:rgba(139,92,246,.12); --fk-shadow:0 24px 56px -24px rgba(0,0,0,.65); }
}
:host([data-theme="dark"]) { --fk-bg:#0c1117; --fk-soft:#11161d; --fk-ink:#e8eaed; --fk-ink-2:#a3a9b2;
  --fk-muted:#6b7280; --fk-line:#1f2630; --fk-line-2:#2b3442; --fk-accent:#8b5cf6;
  --fk-accent-soft:rgba(139,92,246,.12); --fk-shadow:0 24px 56px -24px rgba(0,0,0,.65); }
:host([data-theme="light"]) { --fk-bg:#fff; --fk-soft:#f6f7f7; --fk-ink:#0a0a0b; --fk-ink-2:#52525b;
  --fk-muted:#8a8a90; --fk-line:#e7e8ea; --fk-line-2:#d9dbde; --fk-accent:#7c3aed;
  --fk-accent-soft:rgba(124,58,237,.1); --fk-shadow:0 24px 56px -24px rgba(12,17,23,.4); }
* { box-sizing:border-box; }

.fk-trigger { position:fixed; z-index:2147483646; bottom:max(20px,env(safe-area-inset-bottom,20px));
  inset-inline-end:max(20px,env(safe-area-inset-right,20px)); display:flex; align-items:center; gap:8px;
  padding:10px 15px 10px 10px; cursor:pointer; font:600 13px var(--fk-font); color:var(--fk-ink);
  background:var(--fk-bg); border:1px solid var(--fk-line-2); border-radius:999px; box-shadow:var(--fk-shadow);
  transition:transform .18s ease,border-color .18s ease; }
.fk-trigger:hover { transform:translateY(-2px); border-color:var(--fk-accent); }
.fk-trigger:focus-visible { outline:2px solid var(--fk-accent); outline-offset:2px; }
.fk-trigger-icon { width:25px; height:25px; display:grid; place-items:center; flex:none; border-radius:9px;
  background:var(--fk-accent); color:#fff; font-size:14px; }
.fk-trigger-label { white-space:nowrap; }

.fk-backdrop { position:fixed; z-index:2147483645; inset:0; display:flex; align-items:center; justify-content:center;
  padding:20px; background:rgba(8,11,15,.48); backdrop-filter:blur(3px); }
.fk-panel { width:min(430px,calc(100vw - 32px)); max-height:min(90dvh,720px); overflow:auto;
  padding:22px; font-family:var(--fk-font); color:var(--fk-ink); background:var(--fk-bg);
  border:1px solid var(--fk-line); border-radius:18px; box-shadow:var(--fk-shadow);
  animation:fk-enter .2s cubic-bezier(.2,.8,.2,1); }
@keyframes fk-enter { from { opacity:0; transform:translateY(10px) scale(.985); } }
.fk-head { display:flex; align-items:center; gap:8px; margin-bottom:16px; }
.fk-title { margin:0; font-size:16px; font-weight:700; letter-spacing:-.01em; }
.fk-x { margin-left:auto; padding:4px; border:0; background:none; color:var(--fk-muted); font:20px/1 var(--fk-font); cursor:pointer; }
.fk-x:hover { color:var(--fk-ink); }
.fk-form { display:flex; flex-direction:column; gap:13px; }
.fk-tabs { display:flex; flex-wrap:wrap; gap:6px; }
.fk-type { padding:6px 13px; border:1px solid var(--fk-line-2); border-radius:999px; background:transparent;
  color:var(--fk-ink-2); font:600 12.5px var(--fk-font); cursor:pointer; }
.fk-type[aria-pressed="true"] { border-color:var(--fk-accent); background:var(--fk-accent-soft); color:var(--fk-accent); }
.fk-guidance { margin:0; padding:9px 11px; border:1px solid var(--fk-line); border-left:2px solid var(--fk-accent);
  border-radius:8px; background:var(--fk-soft); color:var(--fk-ink-2); font-size:12px; line-height:1.45; }
.fk-label { font-size:12.5px; font-weight:600; }
.fk-input { width:100%; min-height:96px; padding:12px 13px; resize:vertical; border:1px solid var(--fk-line-2);
  border-radius:10px; background:var(--fk-soft); color:var(--fk-ink); font:14px/1.5 var(--fk-font); }
.fk-input::placeholder { color:var(--fk-muted); }
.fk-input:focus-visible { outline:0; border-color:var(--fk-accent); box-shadow:0 0 0 1px var(--fk-accent); }

.fk-attach { display:flex; flex-direction:column; gap:9px; }
.fk-chips { display:flex; flex-wrap:wrap; gap:6px; }
.fk-chip { display:inline-flex; align-items:center; gap:6px; max-width:100%; padding:4px 8px; border:1px solid var(--fk-line-2);
  border-radius:7px; background:var(--fk-bg); color:var(--fk-muted); font:10.5px var(--fk-mono); }
.fk-chip .txt { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.fk-chip.shot { padding-right:4px; border-color:rgba(124,58,237,.45); background:var(--fk-accent-soft); color:var(--fk-accent); }
.fk-chip.shot.off { opacity:.5; }
.fk-chip .act { min-height:22px; padding:2px 6px; border:0; border-radius:4px; background:transparent;
  color:var(--fk-accent); font:600 10.5px var(--fk-font); cursor:pointer; }
.fk-chip .act.icon { width:22px; padding:0; font-size:15px; }
.fk-chip .act:hover:not(:disabled) { background:var(--fk-accent-soft); }
.fk-chip .act:disabled { opacity:.45; cursor:wait; }
.fk-drop { padding:14px; text-align:center; border:1.5px dashed var(--fk-line-2); border-radius:10px;
  background:var(--fk-soft); cursor:pointer; transition:border-color .15s ease,background .15s ease; }
.fk-drop:hover,.fk-drop.fk-dragover { border-color:var(--fk-accent); background:var(--fk-accent-soft); }
.fk-drop-t { color:var(--fk-ink-2); font-size:12.5px; }
.fk-drop-t b { color:var(--fk-accent); }
.fk-drop-s,.fk-hint,.fk-privacy { color:var(--fk-muted); font-size:11px; }
.fk-hint { margin:0; }
.fk-foot { display:flex; align-items:center; gap:12px; }
.fk-btn { margin-left:auto; padding:9px 18px; border:1px solid var(--fk-accent); border-radius:8px;
  background:var(--fk-accent); color:#fff; font:600 13.5px var(--fk-font); cursor:pointer; }
.fk-btn:hover:not(:disabled) { filter:brightness(1.07); }
.fk-btn.fk-ghost { background:transparent; color:var(--fk-accent); border-color:var(--fk-line-2); }
.fk-actions { display:flex; align-items:center; gap:10px; margin-top:14px; }
.fk-link { border:0; background:none; color:var(--fk-muted); text-decoration:underline; cursor:pointer; }
.fk-status { display:flex; align-items:center; gap:10px; color:var(--fk-ink-2); font:14px var(--fk-font); }
.fk-spinner { width:18px; height:18px; border:2px solid var(--fk-line); border-top-color:var(--fk-accent); border-radius:50%; animation:fk-spin .8s linear infinite; }
@keyframes fk-spin { to { transform:rotate(360deg); } }
.fk-question { color:var(--fk-ink); font:600 15px/1.5 var(--fk-font); }
.fk-done { text-align:center; font-family:var(--fk-font); }
.fk-done-icon { width:52px; height:52px; margin:0 auto 10px; display:grid; place-items:center; border-radius:50%; background:var(--fk-accent-soft); color:var(--fk-accent); font-size:25px; }

.fk-editor { position:fixed; z-index:2147483647; inset:0; display:flex; flex-direction:column; gap:14px;
  padding-top:max(24px,env(safe-area-inset-top)); padding-right:max(24px,env(safe-area-inset-right));
  padding-bottom:max(24px,env(safe-area-inset-bottom)); padding-left:max(24px,env(safe-area-inset-left));
  background:rgba(8,11,15,.84); font-family:var(--fk-font); }
.fk-editor-head { display:flex; align-items:center; gap:12px; color:#fff; }
.fk-editor-head h2 { margin:0; font-size:16px; }
.fk-editor-hint { color:rgba(255,255,255,.62); font-size:12px; }
.fk-editor-head .fk-x { color:rgba(255,255,255,.7); }
.fk-toolbar { display:flex; align-items:center; flex-wrap:wrap; gap:6px; }
.fk-tool-sep { flex:1; }
.fk-tool { width:38px; height:38px; display:grid; place-items:center; border:1px solid rgba(255,255,255,.16);
  border-radius:9px; background:rgba(255,255,255,.08); color:rgba(255,255,255,.8); font:600 16px var(--fk-font); cursor:pointer; }
.fk-tool[aria-pressed="true"] { border-color:var(--fk-accent); background:var(--fk-accent); color:#fff; }
.fk-tool:disabled { opacity:.35; }
.fk-canvas-wrap { position:relative; flex:1; min-height:0; display:flex; align-items:center; justify-content:center; overflow:auto; }
.fk-canvas { display:block; max-width:100%; max-height:100%; border-radius:8px; background:#fff; box-shadow:0 16px 48px rgba(0,0,0,.5); touch-action:none; }
.fk-canvas-text { position:absolute; min-width:120px; padding:3px 6px; border:1px dashed var(--fk-accent); border-radius:4px; background:#fff; color:var(--fk-accent); }
.fk-editor-foot { display:flex; justify-content:flex-end; gap:10px; }
.fk-editor-foot .fk-btn { margin-left:0; }
.fk-sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
[hidden] { display:none !important; }
@media (max-width:600px) { .fk-panel { padding:18px; } .fk-editor { padding-top:max(14px,env(safe-area-inset-top)); padding-right:max(14px,env(safe-area-inset-right)); padding-bottom:max(14px,env(safe-area-inset-bottom)); padding-left:max(14px,env(safe-area-inset-left)); } .fk-editor-hint { display:none; } }
`;
