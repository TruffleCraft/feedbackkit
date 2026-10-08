// FeedbackKit's own visual language: Urbanist (self-hosted by the gateway),
// one violet accent, neutral surfaces, generous radii (30px panel, pill
// controls), fine borders and restrained motion. Dark is a near-black ground
// with light ink; both themes keep text at 4.5:1 or more.
// Phones (max-width:600px): a full-screen sheet in three zones (head, scrolling content,
// input at the bottom), sized to the visual viewport so the input stays above the keyboard.
export const STYLES = `
:host {
  --fk-bg:#fff; --fk-soft:#f6f6f7; --fk-ink:#1a1a1a; --fk-ink-2:#52525b;
  --fk-muted:#71717a; --fk-line:#e7e7ea; --fk-line-2:#d4d4d8;
  --fk-accent:#7c3aed; --fk-accent-ink:#fff; --fk-accent-soft:rgba(124,58,237,.1); --fk-accent-text:#6d28d9;
  --fk-font:"FK Urbanist",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  --fk-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --fk-shadow:0 40px 80px -30px rgba(26,26,26,.35);
}
@media (prefers-color-scheme:dark) {
  :host { --fk-bg:#202022; --fk-soft:#2a2a2d; --fk-ink:#fff; --fk-ink-2:#a2a2a2;
    --fk-muted:#8b8b90; --fk-line:#2e2e31; --fk-line-2:#48484d; --fk-accent:#7c3aed;
    --fk-accent-soft:rgba(124,58,237,.24); --fk-accent-text:#c4b5fd; --fk-shadow:0 40px 80px -30px rgba(0,0,0,.75); }
}
:host([data-theme="dark"]) { --fk-bg:#202022; --fk-soft:#2a2a2d; --fk-ink:#fff; --fk-ink-2:#a2a2a2;
    --fk-muted:#8b8b90; --fk-line:#2e2e31; --fk-line-2:#48484d; --fk-accent:#7c3aed;
    --fk-accent-soft:rgba(124,58,237,.24); --fk-accent-text:#c4b5fd; --fk-shadow:0 40px 80px -30px rgba(0,0,0,.75); }
:host([data-theme="light"]) { --fk-bg:#fff; --fk-soft:#f6f6f7; --fk-ink:#1a1a1a; --fk-ink-2:#52525b;
  --fk-muted:#71717a; --fk-line:#e7e7ea; --fk-line-2:#d4d4d8;
  --fk-accent:#7c3aed; --fk-accent-ink:#fff; --fk-accent-soft:rgba(124,58,237,.1); --fk-accent-text:#6d28d9;
  --fk-shadow:0 40px 80px -30px rgba(26,26,26,.35); }
* { box-sizing:border-box; }

.fk-trigger { position:fixed; z-index:2147483646; bottom:max(20px,env(safe-area-inset-bottom,20px));
  inset-inline-end:max(20px,env(safe-area-inset-right,20px)); display:flex; align-items:center; gap:8px;
  padding:10px 16px 10px 10px; cursor:pointer; font:700 14px var(--fk-font); color:var(--fk-ink);
  background:var(--fk-bg); border:1px solid var(--fk-line-2); border-radius:999px; box-shadow:var(--fk-shadow);
  transition:transform .18s ease,border-color .18s ease; }
.fk-trigger:hover { transform:translateY(-2px); border-color:var(--fk-accent); }
.fk-trigger-icon,.fk-avatar { width:26px; height:26px; display:grid; place-items:center; flex:none; border-radius:999px;
  background:var(--fk-accent); color:#fff; }
.fk-trigger-icon svg,.fk-avatar svg { width:14px; height:14px; }
.fk-trigger-label { white-space:nowrap; }
.fk-ic { display:inline-flex; } .fk-ic svg { width:18px; height:18px; }

.fk-backdrop { position:fixed; z-index:2147483645; inset:0; display:flex; align-items:flex-end; justify-content:flex-end;
  padding:max(20px,env(safe-area-inset-bottom)) max(20px,env(safe-area-inset-right)); background:rgba(0,0,0,.05); }
.fk-panel { width:min(440px,calc(100vw - 32px)); max-height:min(90dvh,760px); overflow:auto;
  display:flex; flex-direction:column; gap:18px; padding:26px; font-family:var(--fk-font); color:var(--fk-ink);
  background:var(--fk-bg); border:1px solid var(--fk-line); border-radius:30px; box-shadow:var(--fk-shadow);
  animation:fk-enter .2s cubic-bezier(.2,.8,.2,1); }
@keyframes fk-enter { from { opacity:0; transform:translateY(10px) scale(.985); } }
@keyframes fk-fade { from { opacity:0; } }
.fk-panel button,.fk-panel a { font-family:var(--fk-font); cursor:pointer; }
.fk-panel :focus-visible,.fk-trigger:focus-visible { outline:2px solid var(--fk-accent); outline-offset:2px; }
.fk-head { display:flex; align-items:center; gap:10px; }
.fk-mark svg { display:block; width:24px; height:24px; }
.fk-brand { font-size:15px; font-weight:700; color:var(--fk-ink-2); }
.fk-x { margin-left:auto; width:36px; height:36px; display:grid; place-items:center; padding:0; border:0;
  border-radius:999px; background:var(--fk-soft); color:var(--fk-ink-2); }
.fk-x:hover { color:var(--fk-ink); }
.fk-view { display:flex; flex-direction:column; gap:16px; }
.fk-h { margin:0; font-size:28px; line-height:1.15; font-weight:900; }
.fk-tabs { display:flex; flex-wrap:wrap; gap:6px; }
.fk-type { padding:6px 13px; border:1px solid var(--fk-line-2); border-radius:999px; background:transparent;
  color:var(--fk-ink-2); font-size:13px; font-weight:600; }
.fk-type[aria-pressed="true"],.fk-pill[aria-pressed="true"] { border-color:var(--fk-accent); background:var(--fk-accent-soft); color:var(--fk-accent-text); }
.fk-guidance { margin:0; color:var(--fk-ink-2); font-size:13px; line-height:1.45; }

.fk-composer { display:flex; flex-direction:column; gap:10px; padding:16px; background:var(--fk-soft);
  border:1.5px solid var(--fk-line-2); border-radius:22px; transition:border-color .15s ease; }
.fk-composer:focus-within,.fk-composer.fk-dragover,.fk-answer:focus-within { border-color:var(--fk-accent); }
.fk-text { min-height:150px; padding:0; resize:none; border:0; outline:0; background:transparent; color:var(--fk-ink); font:16px/1.5 var(--fk-font); }
.fk-text::placeholder,.fk-answer input::placeholder { color:var(--fk-muted); }
.fk-tools { display:flex; align-items:center; gap:8px; }
.fk-icon-btn,.fk-pill { height:40px; display:inline-flex; align-items:center; justify-content:center; gap:8px; padding:0 14px;
  border:1px solid var(--fk-line-2); border-radius:999px; background:transparent; color:var(--fk-ink-2); font-size:14px; font-weight:600; }
.fk-icon-btn { width:40px; flex:none; padding:0; }
.fk-pill { min-width:0; overflow:hidden; white-space:nowrap; }
.fk-pill .txt { min-width:0; overflow:hidden; text-overflow:ellipsis; }
.fk-pill .fk-ic { flex:none; }
.fk-pill .fk-ic svg { width:16px; height:16px; }
.fk-pill:disabled { opacity:.5; cursor:wait; }
.fk-send { margin-left:auto; width:44px; height:44px; flex:none; display:grid; place-items:center; padding:0; border:0;
  border-radius:999px; background:var(--fk-accent); color:var(--fk-accent-ink); }
.fk-send .fk-ic svg { width:20px; height:20px; }
.fk-send:hover,.fk-btn:hover { filter:brightness(1.08); }
.fk-files,.fk-thumbs { display:flex; flex-wrap:wrap; gap:6px; }
.fk-files:empty,.fk-thumbs:empty { display:none; }
.fk-thumbs { gap:12px; padding-top:6px; }
.fk-thumb { position:relative; }
.fk-thumb-img { position:relative; display:block; width:76px; height:56px; padding:0; overflow:hidden; border:1px solid var(--fk-line-2); border-radius:12px; background:var(--fk-bg); }
.fk-thumb-img img { display:block; width:100%; height:100%; object-fit:cover; }
.fk-thumb-pen { position:absolute; right:4px; bottom:4px; width:22px; height:22px; display:grid; place-items:center; border-radius:999px; background:var(--fk-accent); color:var(--fk-accent-ink); }
.fk-thumb-pen svg { width:12px; height:12px; }
.fk-thumb-x { position:absolute; top:-9px; right:-9px; width:26px; height:26px; display:grid; place-items:center; padding:0; border:2px solid var(--fk-soft); border-radius:999px; background:var(--fk-ink); color:var(--fk-bg); }
.fk-thumb-x svg { width:12px; height:12px; }
.fk-chip { max-width:100%; padding:4px 10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; border:1px solid var(--fk-line-2);
  border-radius:999px; background:var(--fk-bg); color:var(--fk-muted); font:11px var(--fk-mono); }
.fk-chip.file[data-status="failed"],.fk-chip.file[data-status="limit"] { color:#b42318; border-color:rgba(180,35,24,.35); }
.fk-hint { margin:0; color:var(--fk-muted); font-size:13px; line-height:1.45; }
.fk-foot { display:flex; align-items:center; gap:12px; color:var(--fk-ink-2); font-size:13px; }
.fk-disclose { display:inline-flex; align-items:center; gap:6px; padding:0; border:0; background:none; color:inherit; font-size:13px; font-weight:600; }
.fk-disclose .fk-ic svg { width:16px; height:16px; }
.fk-privacy { margin-left:auto; color:inherit; }
.fk-sent { margin:0; padding:12px 16px 12px 32px; border-radius:16px; background:var(--fk-soft); color:var(--fk-ink-2); font-size:13px; line-height:1.6; overflow-wrap:anywhere; }

.fk-thread { display:flex; flex-direction:column; gap:14px; }
.fk-me { align-self:flex-end; max-width:85%; max-height:180px; overflow:auto; padding:14px 16px; background:var(--fk-soft);
  border-radius:22px 22px 6px 22px; font-size:16px; line-height:1.45; white-space:pre-wrap; overflow-wrap:anywhere; }
.fk-bot { display:flex; align-items:center; gap:8px; color:var(--fk-ink-2); font-size:14px; }
.fk-avatar { width:28px; height:28px; }
.fk-busy .fk-avatar { animation:fk-pulse 1.2s ease-in-out infinite; }
@keyframes fk-pulse { 50% { opacity:.4; } }
.fk-tag { align-self:flex-start; padding:5px 12px; border-radius:999px; background:var(--fk-accent-soft); color:var(--fk-accent-text); font-size:13px; font-weight:700; }
.fk-q { align-self:flex-start; max-width:90%; margin:0; padding:14px 16px; background:var(--fk-accent-soft); border:1px solid var(--fk-accent);
  border-radius:22px 22px 22px 6px; font-size:18px; line-height:1.4; font-weight:700; }
.fk-answer { display:flex; align-items:center; gap:8px; padding:8px 8px 8px 18px; background:var(--fk-soft);
  border:1.5px solid var(--fk-line-2); border-radius:999px; }
.fk-panel .fk-text,.fk-panel .fk-answer input { outline:0; }
.fk-answer input { flex:1; min-width:0; padding:0; border:0; outline:0; background:transparent; color:var(--fk-ink); font:16px var(--fk-font); }
.fk-linkbtn { align-self:flex-start; padding:0; border:0; background:none; color:var(--fk-accent-text); font-size:13px; font-weight:700;
  text-decoration:underline; text-underline-offset:3px; }
.fk-foot .fk-linkbtn { margin-left:auto; }

.fk-done-head { display:flex; align-items:center; gap:14px; }
.fk-check { width:52px; height:52px; flex:none; display:grid; place-items:center; border-radius:999px; background:var(--fk-accent); color:#fff; }
.fk-check svg { width:26px; height:26px; }
.fk-card { display:flex; flex-direction:column; gap:12px; padding:18px; background:var(--fk-soft); border-radius:22px; }
.fk-eyebrow { color:var(--fk-ink-2); font-size:13px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; }
.fk-summary { margin:0; font-size:18px; line-height:1.35; font-weight:800; overflow-wrap:anywhere; }
.fk-row { display:flex; gap:10px; }
.fk-btn { flex:1; min-height:48px; display:inline-flex; align-items:center; justify-content:center; gap:8px; padding:0 20px;
  border:1px solid var(--fk-accent); border-radius:999px; background:var(--fk-accent); color:var(--fk-accent-ink);
  font:700 15px var(--fk-font); text-decoration:none; cursor:pointer; }
.fk-btn .fk-ic svg { width:16px; height:16px; }
.fk-btn.fk-ghost { background:transparent; color:var(--fk-ink); border-color:var(--fk-line-2); }

.fk-editor { position:fixed; z-index:2147483647; inset:0; display:flex; flex-direction:column; gap:14px;
  padding-top:max(24px,env(safe-area-inset-top)); padding-right:max(24px,env(safe-area-inset-right));
  padding-bottom:max(24px,env(safe-area-inset-bottom)); padding-left:max(24px,env(safe-area-inset-left));
  background:rgba(8,11,15,.84); font-family:var(--fk-font); }
.fk-editor-head { display:flex; align-items:center; gap:12px; color:#fff; }
.fk-editor-head h2 { margin:0; font-size:16px; }
.fk-editor-hint { color:rgba(255,255,255,.62); font-size:12px; }
.fk-editor-head .fk-x { background:none; color:rgba(255,255,255,.7); font:20px/1 var(--fk-font); }
.fk-toolbar { display:flex; align-items:center; flex-wrap:wrap; gap:6px; }
.fk-text-size { display:flex; gap:4px; }
.fk-tool-sep { flex:1; }
.fk-tool { width:38px; height:38px; display:grid; place-items:center; border:1px solid rgba(255,255,255,.16);
  border-radius:12px; background:rgba(255,255,255,.08); color:rgba(255,255,255,.8); font:600 16px var(--fk-font); cursor:pointer; }
.fk-tool[aria-pressed="true"] { border-color:var(--fk-accent); background:var(--fk-accent); color:#fff; }
.fk-tool:disabled { opacity:.35; }
.fk-canvas-wrap { position:relative; flex:1; min-height:0; display:flex; align-items:center; justify-content:center; overflow:auto; }
.fk-canvas { display:block; max-width:100%; max-height:100%; border-radius:16px; background:#fff; box-shadow:0 16px 48px rgba(0,0,0,.5); touch-action:none; }
.fk-canvas-text { position:absolute; min-width:0; max-width:100%; padding:3px 6px; border:1px dashed var(--fk-accent); border-radius:4px; background:#fff; color:var(--fk-accent); }
.fk-editor-foot { display:flex; justify-content:flex-end; gap:10px; }
.fk-editor-foot .fk-btn { flex:none; min-height:44px; }
.fk-sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
[hidden] { display:none !important; }
@media (max-width:600px) { .fk-backdrop { align-items:flex-start; padding:0; }
  .fk-panel { width:100%; height:var(--fk-vvh,100dvh); max-height:none; margin-top:var(--fk-vvtop,0px); gap:0; padding:0; border:0; border-radius:0; animation:fk-fade .2s ease; }
  .fk-head { flex:none; padding:max(8px,env(safe-area-inset-top)) max(12px,env(safe-area-inset-right)) 8px max(20px,env(safe-area-inset-left)); border-bottom:1px solid var(--fk-line); }
  .fk-x { width:44px; height:44px; }
  .fk-view { flex:1; min-height:0; overflow:auto; overscroll-behavior:contain; padding:18px max(20px,env(safe-area-inset-right)) max(16px,env(safe-area-inset-bottom)) max(20px,env(safe-area-inset-left)); }
  .fk-composer,.fk-answer { order:1; } .fk-composer,.fk-view > .fk-row { margin-top:auto; } .fk-thread { flex:1 0 auto; }
  .fk-row { flex-direction:column-reverse; }
  .fk-h { font-size:24px; } .fk-text { min-height:96px; } .fk-tools { gap:6px; }
  .fk-icon-btn,.fk-pill { height:44px; } .fk-icon-btn { width:44px; } .fk-pill { padding:0 12px; }
  .fk-disclose,.fk-privacy,.fk-linkbtn { min-height:44px; display:inline-flex; align-items:center; } .fk-editor { padding-top:max(14px,env(safe-area-inset-top)); padding-right:max(14px,env(safe-area-inset-right)); padding-bottom:max(14px,env(safe-area-inset-bottom)); padding-left:max(14px,env(safe-area-inset-left)); } .fk-editor-hint { display:none; } }
`;
