import type { Hono } from "hono";
import type { Env } from "../env.js";

// Admin shell pages (P2, step 3, ADR-014). The Worker renders three static
// shells: /admin (project list), /admin/projects/:id and /admin/system. They
// hold no data at all, not even the project id from the URL. dist/admin.js
// (built from src/admin/main.ts) asks /api/admin/me whether Cloudflare Access
// already signed the visitor in; if not, it reads the bearer token from
// sessionStorage. Then it calls /api/admin/* and fills the page with
// textContent only.
//
// CSP: scripts from 'self' (admin.js is a static asset next to the Worker) or
// with this response's nonce; styles only with the nonce, so the markup below
// carries no style attributes. img-src allows https: because each project's R2
// public base URL differs; listing those origins here would hand them to anyone
// who loads the (public, unauthenticated) shell.

export type AdminView = "projects" | "project" | "system";

export const ADMIN_CSP = (nonce: string) =>
  [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "font-src 'self'",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");

export function adminHeaders(nonce: string): Record<string, string> {
  return {
    "Content-Security-Policy": ADMIN_CSP(nonce),
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  };
}

/** Which shell a path gets, or null for anything that is not an admin page. */
export function adminViewFor(path: string): AdminView | null {
  if (path === "/admin" || path === "/admin/") return "projects";
  if (path === "/admin/system") return "system";
  if (/^\/admin\/projects\/[^/]+$/.test(path)) return "project";
  return null;
}

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'%3E%3Crect x='3' y='8' width='30' height='14' rx='7' fill='%237c3aed'/%3E%3Crect x='15' y='26' width='30' height='14' rx='7' fill='%23a78bfa'/%3E%3C/svg%3E";

const CSS = `
@font-face{font-family:"Urbanist";src:url("/urbanist.woff2") format("woff2");font-weight:100 900;font-style:normal;font-display:swap}
:root{
  --ground:#f6f6f7;--card:#fff;--ink:#1a1a1a;--ink-2:#52525b;--muted:#71717a;
  --line:#e7e7ea;--line-2:#d4d4d8;--accent:#7c3aed;--accent-text:#6d28d9;--accent-soft:rgba(124,58,237,.1);
  --block:#1a1a1a;--block-line:transparent;--danger:#b42318;--danger-soft:rgba(180,35,24,.09);
  --sans:"Urbanist",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  color-scheme:light;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --ground:#1a1a1a;--card:#202022;--ink:#fff;--ink-2:#a2a2a2;--muted:#8b8b90;
  --line:#2e2e31;--line-2:#48484d;--accent-text:#c4b5fd;--accent-soft:rgba(124,58,237,.24);
  --block:#111112;--block-line:#2e2e31;--danger:#fca5a5;--danger-soft:rgba(248,113,113,.16);color-scheme:dark}
  :root:not([data-theme="light"]) .when-light{display:none}
  :root:not([data-theme="light"]) .when-dark{display:block}
}
:root[data-theme="dark"]{
  --ground:#1a1a1a;--card:#202022;--ink:#fff;--ink-2:#a2a2a2;--muted:#8b8b90;
  --line:#2e2e31;--line-2:#48484d;--accent-text:#c4b5fd;--accent-soft:rgba(124,58,237,.24);
  --block:#111112;--block-line:#2e2e31;--danger:#fca5a5;--danger-soft:rgba(248,113,113,.16);color-scheme:dark}
:root[data-theme="dark"] .when-light{display:none}
:root[data-theme="dark"] .when-dark{display:block}
.when-dark{display:none}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{-webkit-text-size-adjust:100%}
body{margin:0;font-family:var(--sans);color:var(--ink);background:var(--ground);line-height:1.5;font-size:15px;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
h1,h2,h3,p{margin:0}
h1,h2,h3{font-weight:900;letter-spacing:-.02em;line-height:1.05}
h1{font-size:28px}
h2{font-size:22px}
h3{font-size:18px;font-weight:800;letter-spacing:-.01em;line-height:1.2}
code,pre,.mono{font-family:var(--mono)}
.mono{font-size:13px}
button,input{font-family:var(--sans)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
svg.i{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.muted{color:var(--muted)}
.sm{font-size:13px}
.stack{display:flex;flex-direction:column;gap:14px}
.row-flex{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.between{justify-content:space-between}
.center{justify-content:center}
.wrapany{overflow-wrap:anywhere}

.top{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:12px;height:60px;padding:0 24px;border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--ground) 92%,transparent);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
.brand{display:flex;align-items:center;gap:8px;font-weight:800;font-size:16px;white-space:nowrap}
.brand small{font-weight:600;color:var(--muted);font-size:14px}
.nav{display:flex;gap:4px;margin-left:10px}
.nav a{display:inline-flex;align-items:center;padding:7px 13px;border-radius:999px;font-weight:700;font-size:14px;color:var(--ink-2)}
.nav a:hover{color:var(--ink)}
.nav a[aria-current="page"]{background:var(--accent-soft);color:var(--accent-text)}
.top .end{margin-left:auto;display:flex;align-items:center;gap:10px}
.out{border:0;background:none;color:var(--muted);font-weight:600;font-size:14px;cursor:pointer;padding:6px 4px;white-space:nowrap}
.out:hover{color:var(--ink)}
a.out{display:inline-flex;align-items:center}
.who{color:var(--muted);font-size:14px;font-weight:600;min-width:0;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.top .end{min-width:0}
.icon-btn{width:36px;height:36px;border-radius:999px;border:1px solid var(--line-2);background:transparent;color:var(--ink);display:grid;place-items:center;cursor:pointer;padding:0}
.icon-btn:hover{border-color:var(--accent)}
main{max-width:1120px;margin:0 auto;padding:28px 24px 64px}

.b{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:42px;padding:0 18px;border-radius:999px;border:1.5px solid var(--ink);background:transparent;color:var(--ink);font:700 14px var(--sans);cursor:pointer;white-space:nowrap}
.b.violet{background:var(--accent);border-color:var(--accent);color:#fff}
.b.ghost{border-color:var(--line-2);color:var(--ink-2)}
.b.sm{height:32px;padding:0 13px;font-size:13px}
.b.full{width:100%}
.b:disabled{opacity:.45;cursor:not-allowed}
.b:not(:disabled):hover{filter:brightness(1.1)}

.field{display:flex;flex-direction:column;gap:6px}
.field>label{font-size:13px;font-weight:700;color:var(--ink-2)}
.in{height:46px;padding:0 16px;border:1.5px solid var(--line-2);border-radius:16px;background:var(--card);color:var(--ink);font:15px var(--sans);width:100%;min-width:0}
.in:focus{outline:0;border-color:var(--accent)}
.in.mono{font-family:var(--mono);font-size:14px}
.in.err{border-color:var(--danger)}
.help{font-size:13px;color:var(--muted)}
.help.err{color:var(--danger);font-weight:600}

.c{background:var(--card);border:1px solid var(--line);border-radius:22px;padding:20px}
.c.tight{padding:16px}
.c-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:12px}
.pagehead{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:20px}
.pagehead p{color:var(--muted);font-size:14px;margin-top:4px}
.crumb{font-size:13px;color:var(--muted);margin-bottom:6px}
.crumb a{color:var(--accent-text);font-weight:700}
.notice{padding:12px 16px;border-radius:16px;background:var(--danger-soft);color:var(--danger);font-weight:600;font-size:14px;margin-bottom:16px}
.loading{color:var(--muted);font-size:14px;padding:8px 0}

.badge{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:999px;font-size:12px;font-weight:800;white-space:nowrap;border:1px solid transparent}
.badge.created,.badge.ok{background:var(--accent-soft);color:var(--accent-text)}
.badge.incomplete{border-color:var(--line-2);color:var(--ink-2)}
.badge.failed{background:var(--danger-soft);color:var(--danger)}
.badge.aifail{border:1px dashed var(--line-2);color:var(--ink-2)}
.badge.stored{background:var(--ground);border-color:var(--line);color:var(--muted)}
.badge .i{width:13px;height:13px;stroke-width:2.6}
.t{display:inline-flex;align-items:center;height:22px;padding:0 10px;border:1px solid var(--line-2);border-radius:999px;font-size:12px;font-weight:700;color:var(--ink-2);white-space:nowrap}
.lnk{display:inline-flex;align-items:center;gap:5px;color:var(--accent-text);font-weight:700;font-size:14px;white-space:nowrap}
.lnk .i{width:14px;height:14px}
.danger{color:var(--danger);font-weight:700}

.tabs{display:flex;gap:18px;border-bottom:1px solid var(--line);margin:18px 0 20px;overflow-x:auto;scrollbar-width:none}
.tabs button{border:0;background:none;padding:10px 0;font:700 14px var(--sans);color:var(--muted);border-bottom:2px solid transparent;cursor:pointer;white-space:nowrap;margin-bottom:-1px}
.tabs button[aria-selected="true"]{color:var(--ink);border-bottom-color:var(--accent)}

.chips{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;padding-bottom:2px}
.chip{display:inline-flex;align-items:center;height:34px;padding:0 13px;border:1px solid var(--line-2);border-radius:999px;background:transparent;color:var(--ink-2);font:600 13px var(--sans);cursor:pointer;white-space:nowrap}
.chip[aria-pressed="true"]{border-color:var(--accent);background:var(--accent-soft);color:var(--accent-text)}

.tbl{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:22px}
.tbl table{border-collapse:collapse;width:100%;min-width:600px;font-size:14px}
.tbl th,.tbl td{padding:12px 14px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}
.tbl th{font-size:12px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);white-space:nowrap}
.tbl tr:last-child td{border-bottom:0}
.tbl td.num{font-variant-numeric:tabular-nums;font-weight:700;white-space:nowrap}
.tbl tbody tr:hover{background:color-mix(in srgb,var(--accent-soft) 40%,transparent)}
.tbl .name{font-weight:800}
.tbl a.name{color:var(--accent-text)}
.tbl.inset{border-radius:14px}
.tbl.inset table{min-width:520px;font-size:13.5px}
.tbl.inset th,.tbl.inset td{padding:9px 12px}
.tbl .w38{width:38%}

.thumb{width:56px;height:42px;flex:none;border-radius:10px;background:var(--ground);border:1px solid var(--line);display:grid;place-items:center;color:var(--muted);overflow:hidden}
.thumb img{width:100%;height:100%;object-fit:cover;display:block}
.thumb .i{width:18px;height:18px;stroke-width:1.8}
.thumb.none{background:transparent;border-style:dashed}
a.thumb:hover{border-color:var(--accent)}

.rows{display:flex;flex-direction:column;gap:10px}
.hrow{display:grid;grid-template-columns:56px minmax(0,1fr) auto;gap:14px;align-items:center;padding:14px 16px;background:var(--card);border:1px solid var(--line);border-radius:20px}
.hrow .top-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.hrow .sum{font-weight:700;margin-top:4px;line-height:1.35;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.hrow .meta{margin-top:3px;font-size:12.5px;color:var(--muted);overflow-wrap:anywhere}
.hrow .side{display:flex;flex-direction:column;align-items:flex-end;gap:8px}
.hrow .why{font-size:12.5px;margin-top:4px;color:var(--muted)}
.empty-msg{padding:22px;text-align:center;color:var(--muted);background:var(--card);border:1px dashed var(--line-2);border-radius:20px}

.funnel{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}
.fstep .fl{display:block;font-size:11.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.fstep b{display:block;font-size:26px;font-weight:900;line-height:1.1;margin-top:4px;font-variant-numeric:tabular-nums}
.fstep small{color:var(--muted);font-size:12.5px;font-weight:600}
.fstep i{display:block;height:6px;border-radius:999px;background:var(--line);margin-top:8px;overflow:hidden}
.fstep i::after{content:"";display:block;height:100%;width:var(--w,0%);background:var(--accent);border-radius:999px}
.fafter{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:14px;padding-top:12px;border-top:1px solid var(--line);font-size:13.5px;color:var(--ink-2)}
.fafter b{color:var(--ink);font-variant-numeric:tabular-nums}

.term{margin:0;background:var(--block);border:1px solid var(--block-line);border-radius:18px;padding:14px 16px;color:#e4e4e7;font:13px/1.7 var(--mono);overflow-x:auto;white-space:pre}

.steps{display:flex;flex-direction:column;gap:12px}
.step{display:grid;grid-template-columns:34px minmax(0,1fr);gap:12px;padding:16px;background:var(--card);border:1px solid var(--line);border-radius:20px}
.step .n{width:34px;height:34px;border-radius:999px;display:grid;place-items:center;font-weight:900;background:var(--accent);color:#fff}
.step.todo .n{background:transparent;border:1.5px solid var(--line-2);color:var(--muted)}
.step.done .n{background:var(--accent-soft);color:var(--accent-text)}
.step h3{font-size:16px}
.step p{color:var(--ink-2);font-size:14px;margin-top:3px}
.step .body{display:flex;flex-direction:column;gap:10px;min-width:0}

.login{display:flex;flex-direction:column;align-items:center;gap:16px;padding:28px 0 20px}
.login-card{width:100%;max-width:380px;display:flex;flex-direction:column;gap:16px;padding:28px;background:var(--card);border:1px solid var(--line);border-radius:30px}
.login-card p{color:var(--ink-2);font-size:14.5px}
.login-card p.help{font-size:13px;color:var(--muted)}
.login-card p.help.err{color:var(--danger)}
.hint{width:100%;max-width:380px;display:grid;grid-template-columns:20px minmax(0,1fr);gap:10px;font-size:13.5px;color:var(--ink-2)}
.hint .i{width:20px;height:20px;color:var(--accent-text);stroke-width:1.8}
.hint a{color:var(--accent-text);font-weight:700}

.tcard{background:var(--card);border:1px solid var(--line);border-radius:20px;overflow:hidden}
.tcard+.tcard{margin-top:10px}
.tcard summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:14px 16px;min-height:44px}
.tcard summary::-webkit-details-marker{display:none}
.tcard summary .nm{font-weight:800;font-size:16px}
.tcard summary .meta{color:var(--muted);font-size:13px}
.tcard summary::after{content:"+";margin-left:auto;color:var(--accent-text);font-size:22px;line-height:1;font-weight:700}
.tcard[open] summary::after{content:"\\2212"}
.tcard .inner{padding:0 16px 16px;display:flex;flex-direction:column;gap:12px}
.note{padding:12px 14px;border-radius:14px;background:var(--ground);border:1px solid var(--line);color:var(--ink-2);font-size:13.5px;font-weight:600}

.kv{display:flex;flex-direction:column}
.kv>div{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--line);font-size:14px}
.kv>div:last-child{border-bottom:0;padding-bottom:0}
.kv b{color:var(--ink)}
.bar{height:8px;border-radius:999px;background:var(--line);overflow:hidden;min-width:90px}
.bar span{display:block;height:100%;width:var(--w,0%);background:var(--accent);border-radius:999px}
.bar span.hot{background:var(--danger)}

@media (max-width:860px){
  main{padding:20px 20px 56px}
  .top{padding:0 16px}
}
@media (max-width:640px){
  main{padding:16px 16px 48px}
  .top{gap:8px;padding:0 12px}
  .brand small{display:none}
  .who{max-width:34vw;font-size:13px}
  .who-label{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
  .nav{margin-left:0}
  h1{font-size:24px}
  .funnel{grid-template-columns:repeat(2,minmax(0,1fr))}
  .hrow{grid-template-columns:44px minmax(0,1fr);gap:10px 12px;padding:12px}
  .hrow .thumb{width:44px;height:34px}
  .hrow .side{grid-column:1/-1;flex-direction:row;align-items:center;justify-content:space-between}
  .b,.b.sm,.chip,.nav a,.out,.tabs button{min-height:44px}
  .icon-btn{width:44px;height:44px}
  .lnk{min-height:44px}
  .tbl a.name{display:inline-flex;align-items:center;min-height:44px}
  .brand{min-height:44px}
}
@media (max-width:400px){.brand .name{display:none}}
.sprite{position:absolute;width:0;height:0;overflow:hidden}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
`;

const SPRITE = `<svg width="0" height="0" class="sprite" aria-hidden="true" focusable="false">
<symbol id="mark" viewBox="0 0 48 48"><rect x="3" y="8" width="30" height="14" rx="7" fill="#7c3aed"/><rect x="15" y="26" width="30" height="14" rx="7" fill="#a78bfa"/></symbol>
<symbol id="i-ext" viewBox="0 0 24 24"><path d="M15 3h6v6M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></symbol>
<symbol id="i-check" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></symbol>
<symbol id="i-image" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/></symbol>
<symbol id="i-shield" viewBox="0 0 24 24"><path d="M12 3l7 4v5c0 4.5-3 8-7 9-4-1-7-4.5-7-9V7z"/><path d="M9.5 12l2 2 3.5-3.5"/></symbol>
<symbol id="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></symbol>
<symbol id="i-moon" viewBox="0 0 24 24"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/></symbol>
</svg>`;

const icon = (name: string, cls = "i") => `<svg class="${cls}" aria-hidden="true"><use href="#${name}"/></svg>`;

const ACCESS_GUIDE = "https://github.com/TruffleCraft/feedbackkit/blob/main/docs/QUICKSTART.md#admin";

const LOGIN = `<section id="login" class="login" hidden aria-labelledby="login-h">
  <form class="login-card" id="login-form" novalidate>
    <svg width="40" height="40" aria-hidden="true"><use href="#mark"/></svg>
    <h1 id="login-h">Sign in</h1>
    <p>Paste the admin token you set with <code class="mono">wrangler secret put ADMIN_TOKEN</code>.</p>
    <div class="field">
      <label for="token">Admin token</label>
      <input class="in mono" id="token" name="token" type="password" autocomplete="off" spellcheck="false" placeholder="Paste token" aria-describedby="token-msg">
      <p class="help err" id="token-msg" role="alert" hidden></p>
    </div>
    <button class="b violet full" type="submit" id="login-btn">Sign in</button>
    <p class="help">The token stays in this tab and is gone once you close it.</p>
  </form>
  <div class="hint">${icon("i-shield")}<span>Put <code class="mono">/admin*</code> and <code class="mono">/api/admin/*</code> behind Cloudflare Access so each person signs in with their own account. <a href="${ACCESS_GUIDE}" target="_blank" rel="noopener noreferrer">Setup guide</a></span></div>
</section>`;

const PROJECTS = `<section id="view-projects" hidden>
  <div class="pagehead"><div><h1>Projects</h1><p id="projects-sub"></p></div></div>
  <div class="tbl" id="projects-table" hidden>
    <table>
      <thead><tr><th scope="col">Project</th><th scope="col">Reports, 7 days</th><th scope="col">Issues failed</th><th scope="col">Config</th><th scope="col">Edited</th></tr></thead>
      <tbody id="projects-rows"></tbody>
    </table>
  </div>
  <div id="projects-empty" hidden>
    <div class="pagehead"><div><h2>Set up your first project</h2><p>About 5 minutes</p></div></div>
    <div class="steps">
      <div class="step"><span class="n">1</span><div class="body"><div><h3>Import your config</h3><p>Send your <code class="mono">feedbackkit.config.json</code> to the gateway with the admin token. The answer contains the public key, the snippet and the test page.</p></div>
        <pre class="term" id="import-cmd"></pre></div></div>
      <div class="step todo"><span class="n">2</span><div class="body"><div><h3>Add the snippet to your site</h3><p>It's a single script tag, included in the import answer and on the project page.</p></div></div></div>
      <div class="step todo"><span class="n">3</span><div class="body"><div><h3>Send a test report</h3><p>The test page sends a dry run that doesn't open an issue.</p></div></div></div>
    </div>
  </div>
</section>`;

const PROJECT = `<section id="view-project" hidden>
  <div class="crumb"><a href="/admin">Projects</a> / <span id="p-crumb"></span></div>
  <div class="pagehead"><div><h1 id="p-name" class="wrapany"></h1><p class="mono wrapany" id="p-meta"></p></div><button class="b ghost sm" type="button" id="p-export" disabled>Export config</button></div>
  <div class="tabs" role="tablist" aria-label="Project sections">
    <button role="tab" type="button" id="tab-setup" data-tab="setup" aria-controls="panel-setup" aria-selected="false" tabindex="-1">Setup &amp; snippet</button>
    <button role="tab" type="button" id="tab-types" data-tab="types" aria-controls="panel-types" aria-selected="false" tabindex="-1">Types &amp; fields</button>
    <button role="tab" type="button" id="tab-history" data-tab="history" aria-controls="panel-history" aria-selected="true">Feedback history</button>
  </div>

  <div class="stack" id="panel-history" role="tabpanel" aria-labelledby="tab-history">
    <div class="c">
      <div class="c-head"><h3>Last 30 days</h3><span class="muted sm">Share of opens</span></div>
      <div class="funnel" id="funnel">
        <div class="fstep" data-ev="opened"><span class="fl">Opened</span><b>–</b><small></small><i></i></div>
        <div class="fstep" data-ev="typed"><span class="fl">Typed</span><b>–</b><small></small><i></i></div>
        <div class="fstep" data-ev="submitted"><span class="fl">Sent</span><b>–</b><small></small><i></i></div>
        <div class="fstep" data-ev="need_fields"><span class="fl">Asked back</span><b>–</b><small></small><i></i></div>
      </div>
      <div class="fafter">
        <span>Answered the follow-up <b data-ev="completed">–</b></span>
        <span>Sent anyway <b data-ev="sent_anyway">–</b></span>
        <span>Closed without sending <b data-ev="abandoned">–</b></span>
      </div>
    </div>
    <div class="chips" role="group" aria-label="Filter by outcome" id="filters">
      <button class="chip" type="button" data-filter="all" aria-pressed="true">All</button>
      <button class="chip" type="button" data-filter="created" aria-pressed="false">Issue created</button>
      <button class="chip" type="button" data-filter="saved" aria-pressed="false">Saved, no issue</button>
      <button class="chip" type="button" data-filter="accepted_incomplete" aria-pressed="false">Sent incomplete</button>
      <button class="chip" type="button" data-filter="issue_failed" aria-pressed="false">Issue failed</button>
      <button class="chip" type="button" data-filter="ai-failed" aria-pressed="false">AI failed</button>
    </div>
    <div class="rows" id="rows" aria-live="polite"></div>
    <p class="loading" id="rows-loading" hidden>Loading reports…</p>
    <div class="row-flex center"><button class="b ghost sm" type="button" id="more" hidden>Load 25 more</button></div>
  </div>

  <div id="panel-setup" role="tabpanel" aria-labelledby="tab-setup" hidden>
    <div class="steps">
      <div class="step" id="step-snippet"><span class="n">1</span><div class="body"><div><h3>Add the snippet</h3><p>Paste it before <code class="mono">&lt;/body&gt;</code> on every page that should show the button.</p></div>
        <pre class="term" id="snippet"></pre>
        <div class="row-flex"><button class="b ghost sm" type="button" id="copy">Copy snippet</button><span class="help" id="copy-msg" role="status"></span></div></div></div>
      <div class="step" id="step-origins"><span class="n">2</span><div class="body"><div><h3>Allow your origins</h3><p>The widget refuses to load anywhere else. To change the list, edit <code class="mono">auth.origins</code> and import the config again.</p></div>
        <div class="row-flex" id="origins"></div></div></div>
      <div class="step"><span class="n">3</span><div class="body"><div><h3>Check your CSP</h3><p>Only needed if your site sends a Content-Security-Policy. Add the gateway to <code class="mono">script-src</code>, <code class="mono">connect-src</code> and <code class="mono">font-src</code>, plus <code class="mono">img-src blob: data:</code> for screenshots.</p></div></div></div>
      <div class="step"><span class="n">4</span><div class="body"><div><h3>Send a test report</h3><p>The test page sends a dry run. It doesn't create an issue.</p></div>
        <div><a class="b ghost sm" id="testpage" target="_blank" rel="noopener noreferrer">Open test page ${icon("i-ext")}</a></div></div></div>
    </div>
  </div>

  <div class="stack" id="panel-types" role="tabpanel" aria-labelledby="tab-types" hidden>
    <p class="muted sm" id="types-note"></p>
    <div id="types-list"></div>
  </div>
</section>`;

const SYSTEM = `<section id="view-system" class="stack" hidden>
  <div class="pagehead"><div><h1>System</h1><p id="sys-sub"></p></div></div>
  <div class="c tight">
    <div class="c-head"><h3>Needs attention</h3><span class="badge" id="attn-count"></span></div>
    <div class="kv" id="attention"></div>
  </div>
  <p class="help">AI calls count per UTC day and reset at 00:00 UTC.</p>
  <div class="tbl">
    <table>
      <thead><tr><th scope="col">Project</th><th scope="col">AI calls today</th><th scope="col"><span class="sr">Used</span></th><th scope="col">GitHub token</th></tr></thead>
      <tbody id="sys-projects"></tbody>
    </table>
  </div>
  <div class="tbl">
    <table>
      <thead><tr><th scope="col">Gateway</th><th scope="col">Value</th><th scope="col">Status</th></tr></thead>
      <tbody id="sys-gateway"></tbody>
    </table>
  </div>
</section>`;

export function renderAdminPage(view: AdminView, nonce: string): string {
  const cur = (v: AdminView[]) => (v.includes(view) ? ' aria-current="page"' : "");
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>FeedbackKit admin</title>
<link rel="icon" href="${FAVICON}">
<style nonce="${nonce}">${CSS}</style>
</head><body data-view="${view}">
${SPRITE}
<header class="top">
  <a class="brand" href="/admin"><svg width="22" height="22" aria-hidden="true"><use href="#mark"/></svg><span class="name">FeedbackKit</span> <small>Admin</small></a>
  <nav class="nav" id="nav" aria-label="Admin" hidden><a href="/admin"${cur(["projects", "project"])}>Projects</a><a href="/admin/system"${cur(["system"])}>System</a></nav>
  <div class="end">
    <span class="who" id="who" hidden></span>
    <button class="out" type="button" id="signout" hidden>Sign out</button>
    <a class="out" id="signout-access" href="/cdn-cgi/access/logout" hidden>Sign out</a>
    <button class="icon-btn" type="button" id="theme" aria-label="Switch between light and dark">${icon("i-moon", "i when-light")}${icon("i-sun", "i when-dark")}</button>
  </div>
</header>
<main id="main">
<div class="notice" id="notice" role="alert" hidden></div>
<noscript><p class="notice">The admin pages need JavaScript.</p></noscript>
${LOGIN}
${view === "projects" ? PROJECTS : view === "project" ? PROJECT : SYSTEM}
</main>
<script src="/admin.js" nonce="${nonce}" defer></script>
</body></html>`;
}

type AppT = Hono<{ Bindings: Env }>;

/** GET /admin, /admin/projects/:id and /admin/system: static shells, no D1 access. */
export function registerAdminPages(app: AppT): void {
  const serve = (view: AdminView) => (c: import("hono").Context<{ Bindings: Env }>) => {
    const nonce = crypto.randomUUID().replace(/-/g, "");
    for (const [k, v] of Object.entries(adminHeaders(nonce))) c.header(k, v);
    return c.html(renderAdminPage(view, nonce));
  };
  app.get("/admin", serve("projects"));
  app.get("/admin/", serve("projects"));
  app.get("/admin/system", serve("system"));
  app.get("/admin/projects/:id", serve("project"));
}
