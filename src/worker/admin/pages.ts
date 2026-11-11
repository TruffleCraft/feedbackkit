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
// who loads the (public, unauthenticated) shell. blob: is the page's own object
// URLs for private screenshots, which are fetched with the admin credentials.

export type AdminView = "projects" | "project" | "system";

export const ADMIN_CSP = (nonce: string) =>
  [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "font-src 'self'",
    "img-src 'self' blob: data: https:",
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

export const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'%3E%3Crect x='3' y='8' width='30' height='14' rx='7' fill='%237c3aed'/%3E%3Crect x='15' y='26' width='30' height='14' rx='7' fill='%23a78bfa'/%3E%3C/svg%3E";

// The stylesheet of every admin page, the account pages and the OAuth consent page. Plain and quiet
// (docs/design/mockups/admin-plain.md): neutral ground, one accent for the one primary button and the
// current page, rows instead of cards, red only for failure, the system font.
export const CSS = `
:root{--ground:#fbfbfa;--surface:#fff;--raised:#f2f2f0;--line:#e6e6e3;--field:#8d8d93;--ink:#1b1b1d;--muted:#68686f;--accent:#6d28d9;--on-accent:#fff;--danger:#b42318;
--sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--ground:#161617;--surface:#1d1d1f;--raised:#26262a;--line:#2c2c30;--field:#6f6f76;--ink:#ececee;--muted:#9a9aa1;--accent:#a78bfa;--on-accent:#14101f;--danger:#f19a93;color-scheme:dark}}
:root[data-theme="dark"]{--ground:#161617;--surface:#1d1d1f;--raised:#26262a;--line:#2c2c30;--field:#6f6f76;--ink:#ececee;--muted:#9a9aa1;--accent:#a78bfa;--on-accent:#14101f;--danger:#f19a93;color-scheme:dark}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--ground);color:var(--ink);font:400 15px/1.5 var(--sans);-webkit-font-smoothing:antialiased}
a{color:inherit}
h1,h2,h3,p,ul,ol,dl,dd{margin:0}
h1{font-size:24px;line-height:30px;font-weight:600;letter-spacing:-.01em}
h2{font-size:17px;line-height:24px;font-weight:600}
h3{font-size:15px;font-weight:600}
code,pre,.mono{font-family:var(--mono);font-size:13px}
b,strong{font-weight:600}
button,input,select,textarea{font-family:var(--sans)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.muted{color:var(--muted)}.sm{font-size:13px}.num{font-variant-numeric:tabular-nums}
.sprite{position:absolute;width:0;height:0;overflow:hidden}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.stack{display:flex;flex-direction:column;gap:14px}
.row-flex{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.center{justify-content:center}
.wrapany{overflow-wrap:anywhere}
svg.i{width:14px;height:14px;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;vertical-align:-2px}

.app{display:grid;grid-template-columns:240px minmax(0,1fr);min-height:100vh}
.bare .app{display:block}.bare .side{display:none}
.side{display:flex;flex-direction:column;gap:2px;padding:20px 12px;border-right:1px solid var(--line);position:sticky;top:0;align-self:start;height:100vh;overflow:auto}
.sidehead{display:flex;align-items:center;justify-content:space-between;padding:0 8px 14px;border-bottom:1px solid var(--line);margin-bottom:12px}
.brand{display:inline-flex;align-items:center;gap:8px;font-weight:600;text-decoration:none;white-space:nowrap}
.brand small{font-weight:400;color:var(--muted);font-size:14px}
.side .menubtn{display:none}
.side nav{display:flex;flex-direction:column;gap:2px;flex:1}
.side nav a,.side .linkbtn{display:block;width:100%;padding:7px 10px;border:0;border-radius:8px;background:none;color:var(--ink);font:14px var(--sans);text-align:left;text-decoration:none;cursor:pointer}
.side nav a:hover,.side .linkbtn:hover{background:var(--raised)}
.side nav a[aria-current]{background:var(--raised);font-weight:600}
.side .lbl{margin:14px 10px 4px;font-size:12px;font-weight:500;color:var(--muted)}
.side .sub{margin:2px 0 6px 12px;padding-left:8px;border-left:1px solid var(--line)}
.side .sub a{color:var(--muted)}
.side .sub a[aria-current]{color:var(--ink);background:none;font-weight:600;box-shadow:inset 2px 0 0 var(--accent);border-radius:0 8px 8px 0;margin-left:-9px;padding-left:17px}
.side .foot{margin-top:auto;border-top:1px solid var(--line);padding-top:10px}
.side .who{padding:4px 10px 6px;font-size:13px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.side .who a{display:inline;padding:0;width:auto;color:var(--ink);text-decoration:underline;text-underline-offset:2px}
.content{min-width:0;padding:32px 36px 96px}
.content>section{max-width:760px}
.content>section.wide{max-width:none}
.content>.notice{max-width:760px}

.b{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:36px;padding:0 14px;border-radius:8px;border:1px solid var(--field);background:transparent;color:var(--ink);font:500 14px var(--sans);text-decoration:none;white-space:nowrap;cursor:pointer}
.b:hover{background:var(--raised)}
.b.violet{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.b.violet:hover{background:var(--accent);filter:brightness(1.08)}
.b.quiet{border-color:transparent;background:var(--raised)}
.b.text{border-color:transparent;padding:0 8px}
.b.sm{min-height:32px;padding:0 12px;font-size:13px}
.b.full{width:100%}
.b.danger,.danger{color:var(--danger)}
.b:disabled{opacity:.45;cursor:not-allowed}
summary.b{list-style:none}summary.b::-webkit-details-marker{display:none}

.field{display:flex;flex-direction:column;gap:6px;margin-bottom:16px}
.field>label,.field>.lbl,legend{padding:0;font-size:14px;font-weight:500}
.in{height:40px;padding:0 12px;border:1px solid var(--field);border-radius:8px;background:var(--surface);color:var(--ink);font:15px var(--sans);width:100%;min-width:0}
.in:focus{outline:2px solid var(--accent);outline-offset:0;border-color:var(--accent)}
.in.mono{font-family:var(--mono);font-size:14px}
.in.err{border-color:var(--danger)}
.in[readonly]{color:var(--muted);background:var(--raised)}
.help{font-size:13px;color:var(--muted)}
.help.err,.why.err,.err{color:var(--danger)}
.mt4{margin-top:4px}.mt10{margin-top:10px}
fieldset{border:0;margin:0 0 16px;padding:0;min-width:0}
legend{margin-bottom:6px}
.opts{display:flex;flex-direction:column;gap:8px}
.opt{display:grid;grid-template-columns:20px minmax(0,1fr);gap:2px 10px;cursor:pointer}
.opt input{margin:3px 0 0;accent-color:var(--accent);width:18px;height:18px}
.opt b{font-weight:500}
.opt .help{grid-column:2}
.checks{display:flex;flex-direction:column;gap:6px;margin:8px 0 0 28px}
.checks label{display:flex;align-items:center;gap:10px;min-height:32px;font-size:14px}
.checks input{accent-color:var(--accent);width:18px;height:18px}
.copybox{display:flex;gap:8px;flex-wrap:wrap}
.copybox .in{flex:1 1 220px}
.switch{appearance:none;width:42px;height:26px;border-radius:13px;background:var(--field);position:relative;cursor:pointer;flex:none;margin:0}
.switch::after{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;transition:transform .15s}
.switch:checked{background:var(--accent)}
.switch:checked::after{transform:translateX(16px)}
@media (prefers-reduced-motion:reduce){.switch::after{transition:none}}

.pagehead{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:20px}
.pagehead p{color:var(--muted);margin-top:4px;font-size:14px}
.crumb{font-size:13px;color:var(--muted);margin-bottom:4px}
.crumb a{text-decoration:none}.crumb a:hover{color:var(--ink)}
.back{display:none;margin-bottom:12px;color:var(--muted);text-decoration:none;font-size:14px}
.back:hover{color:var(--ink)}
.notice{padding:12px 14px;border-radius:8px;background:var(--raised);color:var(--danger);font-size:14px;margin-bottom:16px}
.loading{color:var(--muted);font-size:14px;padding:8px 0}
.note{padding:12px 14px;border-radius:8px;background:var(--raised);font-size:14px}
.note.sm{font-size:13px}
.empty-msg{padding:24px 4px;color:var(--muted)}
.empty-msg b{color:var(--ink);font-weight:600}
.lnk{color:var(--ink);font-weight:500;text-underline-offset:2px;white-space:nowrap}
.t{display:inline-block;color:var(--muted);font-size:13px;white-space:nowrap}
.t+.t::before{content:"\\00B7";margin:0 6px}
.term{margin:0;padding:12px 14px;border:1px solid var(--line);border-radius:8px;background:var(--raised);font:13px/1.6 var(--mono);overflow-x:auto;white-space:pre-wrap;overflow-wrap:anywhere}
.term.diff .add{color:var(--accent)}.term.diff .del{color:var(--danger)}
.issues{margin:0;padding-left:18px;color:var(--danger);font-size:13px;display:flex;flex-direction:column;gap:4px}

.list{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
.item{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 16px;align-items:center;padding:12px 4px;border-bottom:1px solid var(--line);text-decoration:none;color:inherit}
a.item:hover{background:var(--raised)}
.item .main{min-width:0;display:flex;flex-direction:column;gap:2px}
.item .ttl{font-weight:500;overflow-wrap:anywhere}
.item .meta{color:var(--muted);font-size:13px;overflow-wrap:anywhere}
.item .end{display:flex;align-items:center;gap:8px;justify-self:end;color:var(--muted);font-size:13px;text-align:right}
.item .acts{display:flex;gap:4px;flex-wrap:wrap;justify-self:end}
.item.gone .ttl{color:var(--muted)}
.chev::after{content:"\\203A";margin-left:6px;color:var(--muted);font-size:18px;line-height:1}
.st{white-space:nowrap}
.st.bad{color:var(--danger)}
.st.bad::before{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--danger);margin-right:6px;vertical-align:1px}
.grp{background:var(--surface);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.grp>.item{padding:12px 16px}.grp>.item:last-child{border-bottom:0}
.grp-label{margin:24px 0 8px;font-size:13px;font-weight:500;color:var(--muted)}
.grp-note{margin:8px 4px 0;font-size:13px;color:var(--muted)}
.kv{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
.kv .item{grid-template-columns:minmax(0,170px) minmax(0,1fr);align-items:baseline}
.kv .item>:first-child{color:var(--muted);font-size:14px}
.kv .item>:last-child{overflow-wrap:anywhere}
.kv.acct .item{grid-template-columns:minmax(0,1fr) auto;align-items:center}
.bar{height:6px;border-radius:3px;background:var(--line);overflow:hidden;width:min(100%,160px)}
.bar span{display:block;height:100%;width:var(--w,0%);background:var(--accent)}
.bar span.hot{background:var(--danger)}
.toolbar{display:flex;gap:12px;align-items:center;margin:0 0 12px}
.toolbar .field{margin:0;max-width:260px}
.funnel{margin-bottom:16px}.funnel summary{cursor:pointer;font-size:13px}.funnel .kv{margin-top:8px}
.menu{position:relative}
.menu .pop{position:absolute;right:0;top:calc(100% + 6px);z-index:30;min-width:200px;padding:6px;background:var(--surface);border:1px solid var(--line);border-radius:10px;display:flex;flex-direction:column}
.menu .pop button{display:block;width:100%;text-align:left;padding:9px 10px;border:0;border-radius:6px;background:none;color:var(--ink);font:14px var(--sans);cursor:pointer}
.menu .pop button:hover{background:var(--raised)}
.menu .pop hr{border:0;border-top:1px solid var(--line);margin:6px 0;width:100%}
.menu .pop .danger{color:var(--danger)}

.split{display:grid;grid-template-columns:minmax(300px,400px) minmax(0,1fr);border-top:1px solid var(--line)}
.pane-list{padding:12px 0 0;border-right:1px solid var(--line);min-width:0}
.pane-list .list{border-top:0}
.pane-list .item{padding:12px 14px}
.pane-list .item[aria-current="true"]{background:var(--raised)}
.pane-list .toolbar{padding:0 14px}
.pane-list .loading,.pane-list .more{padding:8px 14px}
.pane-list .empty-msg{padding:20px 14px}
.pane-detail{padding:20px 0 0 32px;min-width:0}
.rd .pagehead{margin-bottom:16px}
.rd .shot img{display:block;max-width:420px;width:100%;border:1px solid var(--line);border-radius:8px}
.rd .shot a{display:block;max-width:420px}
.rd .shot .none{display:grid;place-items:center;aspect-ratio:16/10;max-width:420px;border:1px dashed var(--field);border-radius:8px;color:var(--muted);font-size:13px}
.rd p.body{white-space:pre-wrap;overflow-wrap:anywhere}
.note-edit{display:flex;gap:8px;align-items:flex-end;margin-top:8px}
.note-in{height:auto;min-height:60px;padding:10px 12px;resize:vertical;font:14px var(--sans)}
.rd .acts{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.why{font-size:13px;color:var(--muted)}

.login{display:flex;flex-direction:column;align-items:center;gap:20px;padding:48px 0 20px}
.login-card{width:100%;max-width:380px;display:flex;flex-direction:column;gap:14px}
.login-card p{color:var(--muted);font-size:14.5px}
.login-card p.help{font-size:13px}
.login-card p.help.err{color:var(--danger)}
.login-card .field{margin-bottom:0}
.hint{width:100%;max-width:380px;font-size:13.5px;color:var(--muted)}
.hint a{color:var(--ink);font-weight:500}
.login-card .term,.hint .term{white-space:pre-wrap;overflow-wrap:anywhere}
details.lo summary{cursor:pointer;color:var(--muted);font-size:13px;min-height:32px;display:flex;align-items:center}
details.lo[open] summary{margin-bottom:8px}
details.lo p,details.lo .term{margin-top:8px}

.steps{display:flex;flex-direction:column}
.step{padding:14px 4px;border-bottom:1px solid var(--line)}
.steps{border-top:1px solid var(--line)}
.step h3{font-weight:600}
.step p{color:var(--muted);font-size:14px;margin-top:3px}
.step .body{display:flex;flex-direction:column;gap:10px;min-width:0}
.step .done-mark{color:var(--muted);font-weight:400;font-size:13px;margin-left:6px}
.tcard{border-bottom:1px solid var(--line)}
.tcard summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 4px;min-height:44px}
.tcard summary::-webkit-details-marker{display:none}
.tcard summary .nm{font-weight:500}
.tcard summary .meta{color:var(--muted);font-size:13px}
.tcard summary::after{content:"\\203A";margin-left:auto;color:var(--muted);font-size:18px;transition:transform .15s}
.tcard[open] summary::after{transform:rotate(90deg)}
.tcard .inner{padding:0 4px 14px;display:flex;flex-direction:column;gap:12px}
.upd{margin-bottom:20px}.upd p{margin-bottom:10px}
.upd .term{margin:2px 0 10px}
.upd .dev-only{display:none}
.upd[data-channel="dev"] .dev-only{display:inline}
.upd[data-channel="dev"] .stable-only{display:none}

.editor{display:grid;grid-template-columns:auto minmax(0,1fr);border:1px solid var(--field);border-radius:8px;background:var(--surface);overflow:hidden}
.editor:focus-within{border-color:var(--accent)}
.editor pre{margin:0;padding:12px 8px 12px 12px;text-align:right;color:var(--muted);font:13px/1.6 var(--mono);background:var(--raised);border-right:1px solid var(--line);overflow:hidden;user-select:none;max-height:520px}
.editor textarea{border:0;outline:0;resize:vertical;min-height:360px;max-height:520px;padding:12px;font:13px/1.6 var(--mono);color:var(--ink);background:transparent;white-space:pre;overflow:auto;width:100%}

dialog{width:calc(100% - 32px);max-width:480px;padding:24px;border:1px solid var(--line);border-radius:12px;background:var(--surface);color:var(--ink)}
dialog::backdrop{background:rgba(0,0,0,.4)}
dialog h2{margin-bottom:6px}
.dlg-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:4px}

.settings-nav{display:flex;gap:22px;border-bottom:1px solid var(--line);margin:0 0 20px;overflow-x:auto}
.settings-nav button{border:0;border-bottom:2px solid transparent;margin-bottom:-1px;padding:10px 0;background:none;color:var(--muted);font:500 14px var(--sans);cursor:pointer;white-space:nowrap}
.settings-nav button[aria-pressed="true"]{color:var(--ink);border-bottom-color:var(--accent)}
.settings-content{min-width:0}
.settings-content>h3{display:none}
.settings-field{margin:0 0 16px}
.settings-field>label{display:block;font-weight:500;font-size:14px;margin-bottom:6px}
.settings-field>h3{font-size:14px;font-weight:500;margin-bottom:6px}
.settings-field input,.settings-field textarea,.settings-field select{display:block;width:100%;max-width:100%;min-height:40px;padding:8px 12px;border:1px solid var(--field);border-radius:8px;background:var(--surface);color:var(--ink);font:inherit}
.settings-field input.switch{width:42px;min-height:26px;padding:0;border:0;background:var(--field)}
.settings-field:has(>input.switch){display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px 12px}
.settings-field:has(>input.switch)>.settings-unset{flex:0 0 100%;text-align:left;margin-top:0}
.settings-field:has(>input.switch)>label{margin:0}
.settings-field input.switch:checked{background:var(--accent)}
.settings-field textarea{min-height:84px}
.settings-field input[readonly]{color:var(--muted);background:var(--raised)}
.settings-field>p{font-size:13px;color:var(--muted);margin-top:6px}
.settings-field>details{border:1px solid var(--line);border-radius:10px;background:var(--surface);padding:12px 16px}
.settings-field>details>summary{cursor:pointer;font-weight:600;font-size:14px}
.settings-field>details[open]>summary{margin-bottom:12px}
.settings-field>details .settings-field:last-child{margin-bottom:0}
.settings-item{padding:12px 14px;border:1px solid var(--line);border-radius:10px;margin:0 0 10px;display:flex;gap:8px;flex-wrap:wrap;align-items:flex-start}
.settings-item>.settings-field{flex:1 1 100%;margin-bottom:4px}
.settings-unset{border:0;background:transparent;color:var(--muted);font:inherit;font-size:12px;text-decoration:underline;cursor:pointer;margin-top:6px;padding:0}
.b+.settings-unset{margin-left:10px}
.settings-content>.b{margin:0 8px 8px 0}
.settings-defaults{margin-top:24px}

@media (max-width:1179px){
  .split{display:block;border-top:0}
  .pane-list{border-right:0;padding:0}
  .pane-list .item{padding:14px 2px}
  .pane-list .toolbar,.pane-list .loading,.pane-list .more,.pane-list .empty-msg{padding-left:0;padding-right:0}
  .pane-detail{padding:0}
  .pane-detail .back{display:inline-block}
  #view-project:not(.has-detail) .pane-detail{display:none}
  #view-project.has-detail .pane-list,#view-project.has-detail .rep-head{display:none}
}
@media (max-width:859px){
  .app{display:block}
  .side{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line);padding:12px 16px}
  .sidehead{border-bottom:0;margin:0;padding:0}
  .side .menubtn{display:inline-flex}
  .side nav{display:none;margin-top:12px}
  .side.open nav{display:flex}
  .side nav a,.side .linkbtn{padding:12px 10px;line-height:20px}
  .content{padding:20px 16px 80px}
  .b,.b.sm,.b.text{min-height:44px}
  .funnel summary{display:flex;align-items:center;min-height:44px}
  .pane-detail .back{display:inline-flex;align-items:center;min-height:44px}
  .in{height:44px}
  .settings-field input,.settings-field select{min-height:44px}
  .item{padding:14px 2px}
  .kv .item{grid-template-columns:minmax(0,1fr);gap:2px}
  .kv.acct .item{grid-template-columns:minmax(0,1fr)}
  .login{padding-top:24px}
}
@media (max-width:480px){.brand small{display:none}}
`;

export const SPRITE = `<svg width="0" height="0" class="sprite" aria-hidden="true" focusable="false">
<symbol id="mark" viewBox="0 0 48 48"><rect x="3" y="8" width="30" height="14" rx="7" fill="#7c3aed"/><rect x="15" y="26" width="30" height="14" rx="7" fill="#a78bfa"/></symbol>
<symbol id="i-ext" viewBox="0 0 24 24"><path d="M15 3h6v6M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></symbol>
</svg>`;

export const icon = (name: string, cls = "i") => `<svg class="${cls}" aria-hidden="true"><use href="#${name}"/></svg>`;

/** The sidebar of every signed-in page. The projects and the sections of the current one arrive from the API (shell.ts). */
export const SIDEBAR = `<aside class="side" id="side">
  <div class="sidehead"><a class="brand" href="/admin"><svg width="20" height="20" aria-hidden="true"><use href="#mark"/></svg><span class="name">FeedbackKit</span> <small>Admin</small></a><button class="b quiet menubtn" type="button" id="menu-btn" aria-expanded="false" aria-controls="nav">Menu</button></div>
  <nav id="nav" aria-label="Admin" hidden>
    <a href="/admin" data-nav="projects">All projects</a>
    <div class="lbl">Projects</div>
    <div id="side-projects"></div>
    <div class="lbl">Gateway</div>
    <a href="/admin/system" data-nav="system">System</a>
    <div id="side-owner" hidden><a href="/admin/tokens" data-nav="tokens">API tokens</a><a href="/admin/users" data-nav="users">Users</a></div>
    <div class="foot">
      <div class="who" id="who" hidden></div>
      <button class="linkbtn" type="button" id="theme">Theme: Auto</button>
      <button class="linkbtn" type="button" id="signout" hidden>Sign out</button>
      <a class="linkbtn" id="signout-access" href="/cdn-cgi/access/logout" hidden>Sign out</a>
    </div>
  </nav>
</aside>`;

const ACCESS_GUIDE = "https://github.com/TruffleCraft/feedbackkit/blob/main/docs/QUICKSTART.md#admin";

const LOGIN = `<section id="login" class="login" hidden aria-labelledby="login-h">
  <form class="login-card" id="login-form" novalidate>
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
  <p class="hint">No accounts yet? Run <code class="mono">feedbackkit-admin setup-link</code> on the server (on Cloudflare: <code class="mono">pnpm admin:link</code>) and open the link it prints to sign in with a passkey. The admin token stops working once the first owner exists.</p>
  <p class="hint">Put <code class="mono">/admin*</code> and <code class="mono">/api/admin/*</code> behind Cloudflare Access so each person signs in with their own account. <a href="${ACCESS_GUIDE}" target="_blank" rel="noopener noreferrer">Setup guide</a></p>
</section>`;

const PROJECTS = `<section id="view-projects" hidden>
  <div class="pagehead"><div><h1>Projects</h1><p id="projects-sub"></p></div><button class="b violet" type="button" id="new-project">New project</button></div>
  <dialog id="new-project-dialog"><form id="new-project-form" class="stack">
    <h2>Create a project</h2><p class="help">Start with the FeedbackKit inbox. No GitHub or AI credentials are needed. You can change delivery and AI settings afterwards.</p>
    <div class="field"><label for="new-project-id">Project ID</label><input class="in" id="new-project-id" required pattern="[a-z0-9][a-z0-9_\\-]{0,63}" maxlength="64" placeholder="my-website"></div>
    <div class="field"><label for="new-project-origin">Website origin</label><input class="in" id="new-project-origin" type="url" required placeholder="https://example.org"><p class="help">Include scheme and hostname. No page path.</p></div>
    <div class="field"><label for="new-project-locale">Issue language</label><select class="in" id="new-project-locale"><option value="en">English</option><option value="de">Deutsch</option></select></div>
    <p class="help" id="new-project-msg" role="status"></p><div class="dlg-actions"><button class="b violet" type="submit" id="create-project">Create project</button><button class="b ghost" type="button" id="cancel-project">Cancel</button></div>
  </form></dialog>
  <div id="projects-table" hidden><div class="list" id="projects-rows"></div></div>
  <div id="projects-empty" hidden>
    <div class="pagehead"><div><h2>Set up your first project</h2><p>About 5 minutes</p></div></div>
    <div class="steps">
      <div class="step"><div class="body"><div><h3>1. Create your first project</h3><p>Use <b>New project</b> above. The project page provides your snippet and test page. Existing configurations can also be imported through the API below.</p></div>
        <pre class="term" id="import-cmd"></pre></div></div>
      <div class="step"><div><h3>2. Add the snippet to your site</h3><p>It's a single script tag, included in the import answer and on the project page.</p></div></div>
      <div class="step"><div><h3>3. Send a test report</h3><p>The test page sends a dry run that doesn't open an issue.</p></div></div>
    </div>
  </div>
</section>`;

const FILTER_OPTIONS: Array<[string, string]> = [
  ["all", "All reports"],
  ["open", "Inbox: open"],
  ["done", "Inbox: handled"],
  ["undecided", "Needs a decision"],
  ["created", "Issue created"],
  ["saved", "Saved, no issue"],
  ["accepted_incomplete", "Sent incomplete"],
  ["issue_failed", "Issue failed"],
  ["ai-failed", "AI failed"],
];

const PROJECT = `<section id="view-project" class="wide" hidden>
  <div class="crumb"><a href="/admin">Projects</a> / <span id="p-crumb"></span></div>

  <div id="panel-history" class="wide" role="region" aria-label="Reports" hidden>
    <div class="rep-head">
      <div class="pagehead"><div><h1>Reports</h1></div></div>
      <p class="help">This log records receipt and delivery, not the current status of GitHub tickets. Follow the destination link for open/closed status, comments and triage. Only reports stored in the FeedbackKit inbox have a local Open/Done state.</p>
      <details class="funnel">
        <summary class="muted" id="funnel-sum">Last 30 days</summary>
        <div class="kv" id="funnel">
          <div class="item" data-ev="opened"><span>Opened</span><span class="num"><b>–</b> <span class="pct"></span></span></div>
          <div class="item" data-ev="typed"><span>Typed</span><span class="num"><b>–</b> <span class="pct"></span></span></div>
          <div class="item" data-ev="submitted"><span>Sent</span><span class="num"><b>–</b> <span class="pct"></span></span></div>
          <div class="item" data-ev="need_fields"><span>Asked back</span><span class="num"><b>–</b> <span class="pct"></span></span></div>
          <div class="item"><span>Answered the follow-up</span><span class="num"><b data-ev="completed">–</b></span></div>
          <div class="item"><span>Sent anyway</span><span class="num"><b data-ev="sent_anyway">–</b></span></div>
          <div class="item"><span>Closed without sending</span><span class="num"><b data-ev="abandoned">–</b></span></div>
        </div>
      </details>
    </div>
    <div class="split" id="split">
      <div class="pane-list">
        <div class="toolbar"><div class="field"><label class="sr" for="filter">Show</label><select class="in" id="filter">${FILTER_OPTIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></div></div>
        <div class="list" id="rows" aria-live="polite"></div>
        <p class="loading" id="rows-loading" hidden>Loading reports…</p>
        <div class="more"><button class="b sm" type="button" id="more" hidden>Load 25 more</button></div>
      </div>
      <div class="pane-detail"><a class="back" href="#history" id="back">‹ Reports</a><div id="detail"></div></div>
    </div>
  </div>

  <div id="panel-setup" role="region" aria-label="Setup" hidden>
    <div class="pagehead"><div><h1>Setup</h1><p>Three things to do on the project's website.</p></div></div>
    <div class="steps">
      <div class="step" id="step-snippet"><div class="body"><div><h3>1. Add the snippet <span class="done-mark" hidden>Done</span></h3><p>Paste it before <code class="mono">&lt;/body&gt;</code> on every page that should show the button.</p></div>
        <pre class="term" id="snippet"></pre>
        <div class="row-flex"><button class="b sm" type="button" id="copy">Copy snippet</button><span class="help" id="copy-msg" role="status"></span></div></div></div>
      <div class="step" id="step-origins"><div class="body"><div><h3>2. Allow your origins <span class="done-mark" hidden>Done</span></h3><p>The widget refuses to load anywhere else. Change the list under Settings, General.</p></div>
        <div class="row-flex" id="origins"></div></div></div>
      <div class="step"><div><h3>3. Check your CSP</h3><p>Only needed if your site sends a Content-Security-Policy. Add the gateway to <code class="mono">script-src</code>, <code class="mono">connect-src</code> and <code class="mono">font-src</code>, plus <code class="mono">img-src blob: data:</code> for screenshots.</p></div></div>
      <div class="step"><div class="body"><div><h3>4. Send a test report</h3><p>The test page sends a dry run. It doesn't create an issue.</p></div>
        <div><a class="b sm" id="testpage" target="_blank" rel="noopener noreferrer">Open test page ${icon("i-ext")}</a></div></div></div>
      <div class="step"><div class="body"><div><h3>5. Send a real test report</h3><p>Goes through the first type's real destination (an issue, a draft in the GitHub Project, or the history here) without the AI. It's marked as a test and left out of the counts.</p></div>
        <div class="row-flex"><button class="b sm" type="button" id="test-report">Send test report</button><span class="help" id="test-report-msg" role="status"></span></div></div></div>
    </div>
  </div>

  <div id="panel-types" role="region" aria-label="Types" hidden>
    <div class="pagehead"><div><h1>Types</h1><p id="types-note"></p></div></div>
    <div id="types-list"></div>
  </div>

  <div class="stack" id="panel-config" role="region" aria-label="Settings" hidden>
    <div class="pagehead"><div><h1>Settings</h1><p class="mono" id="p-meta"></p></div><button class="b sm" type="button" id="p-export" disabled>Export config</button></div>
    <p class="muted sm">Settings for <b id="cfg-id"></b>. Review changes before publishing. Settings revisions count edits to this project, not FeedbackKit software releases. Widgets pick up published settings within 60 seconds.</p>
    <div id="cfg-form"></div>
    <details id="cfg-advanced"><summary>Advanced JSON</summary><p class="help">The same draft as the forms. Close this section to load JSON edits into the forms.</p>
    <div class="editor"><pre id="cfg-lines" aria-hidden="true"></pre><textarea id="cfg-text" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="Config JSON"></textarea></div></details>
    <div class="row-flex"><button class="b" type="button" id="cfg-validate" disabled>Review changes</button><button class="b violet" type="button" id="cfg-publish" disabled>Publish</button><span class="help" id="cfg-msg" role="status"></span></div>
    <div class="stack" id="cfg-out"></div>
  </div>
</section>`;

const SYSTEM = `<section id="view-system" hidden>
  <div class="pagehead"><div><h1>System</h1><p id="sys-sub"></p></div></div>
  <div class="note upd" id="upd" role="status" hidden>
    <h3><span class="stable-only">FeedbackKit</span><span class="dev-only">Dev build</span> <span id="upd-v"></span> is available</h3>
    <p>This gateway runs <span id="upd-cur"></span><span class="dev-only">. You follow the dev channel, so dev builds count too</span>. <a class="lnk" id="upd-link" href="/admin/system" target="_blank" rel="noopener noreferrer">Release notes</a></p>
    <p class="muted sm">To update, run this on the server:</p>
    <pre class="term">/opt/feedbackkit/current/feedbackkit-update</pre>
    <p class="help">Nothing changes until you run it. Add --check to preview. Checked <span id="upd-at"></span> with one request to GitHub. It says nothing about this installation.</p>
  </div>
  <div class="grp-label">Needs attention <span id="attn-count"></span></div>
  <div class="list" id="attention"></div>
  <div class="grp-label">AI calls today</div>
  <p class="help mt4">AI calls count per UTC day and reset at 00:00 UTC.</p>
  <div class="list" id="sys-projects"></div>
  <div class="grp-label">Gateway</div>
  <div class="kv" id="sys-gateway"></div>
</section>`;

export function renderAdminPage(view: AdminView, nonce: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>FeedbackKit admin</title>
<link rel="icon" href="${FAVICON}">
<style nonce="${nonce}">${CSS}</style>
</head><body data-view="${view}">
${SPRITE}
<div class="app">
${SIDEBAR}
<main id="main" class="content">
<div class="notice" id="notice" role="alert" hidden></div>
<noscript><p class="notice">The admin pages need JavaScript.</p></noscript>
${LOGIN}
${view === "projects" ? PROJECTS : view === "project" ? PROJECT : SYSTEM}
</main>
</div>
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
