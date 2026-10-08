// FeedbackKit marketing / demo site — a standalone Cloudflare Worker, separate
// from the gateway. Introduces FeedbackKit, embeds the live widget (cross-origin
// from the gateway, wired to the feedbackkit-demo project), and carries the legal
// pages (Impressum + Datenschutz) required for a publicly reachable German site.
//
// Design (v3, FeedbackKit design system): Urbanist (self-hosted for GDPR/CSP,
// served at /fonts/urbanist.woff2), violet accent, light ground with dark blocks
// (stats, architecture, quickstart, closing) and the logo's two chat pills as the
// hero. The theme follows the visitor's system setting until they pick one
// (data-theme attribute + /theme.js, no inline scripts, so script-src stays tight).
//
// No inline JS or third-party origins → script-src is 'self' (theme toggle,
// same-origin) plus the gateway origin (widget bundle). style-src
// 'unsafe-inline' covers the page CSS and the widget's shadow styles. font-src
// 'self' for the self-hosted woff2 — no Google Fonts or other CDN.

import { URBANIST_WOFF2_B64 } from "./font.js";
import { WIDGET_VER } from "./widget-ver.js";

const GATEWAY = "https://feedbackkit.trufflecraft.workers.dev";
const DEMO_PROJECT_KEY = "fk_pub_64a564982de5";

const CSP = [
  "default-src 'self'",
  `script-src 'self' ${GATEWAY}`,
  "style-src 'unsafe-inline'",
  "img-src 'self' data: blob:",
  `font-src 'self' ${GATEWAY}`,
  `connect-src 'self' ${GATEWAY}`,
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

const CSS = `
@font-face{font-family:"Urbanist";src:url("/fonts/urbanist.woff2") format("woff2");font-weight:100 900;font-style:normal;font-display:swap}
:root{
  --ground:#f6f6f7; --card:#ffffff; --ink:#1a1a1a; --ink-2:#52525b; --muted:#71717a;
  --line:#e7e7ea; --line-2:#d4d4d8; --accent:#7c3aed; --accent-text:#6d28d9; --accent-soft:rgba(124,58,237,.1);
  --lav:#ddd6fe; --lav-ink:#4c1d95; --block:#1a1a1a; --block-line:transparent;
  --sans:"Urbanist",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  --wrap:1180px;
}
[data-theme="dark"]{
  --ground:#1a1a1a; --card:#202022; --ink:#ffffff; --ink-2:#a2a2a2; --muted:#8b8b90;
  --line:#2e2e31; --line-2:#48484d; --accent-text:#c4b5fd; --accent-soft:rgba(124,58,237,.24);
  --lav:#3b2a63; --lav-ink:#ede9fe; --block:#111112; --block-line:#2e2e31;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}
body{margin:0;font-family:var(--sans);color:var(--ink);background:var(--ground);line-height:1.55;font-size:17px;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
h1,h2,h3{margin:0;font-weight:900;line-height:1.02;letter-spacing:-.02em}
p{margin:0}
code,pre{font-family:var(--mono)}
.wrap{max-width:var(--wrap);margin:0 auto;padding:0 24px}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
::selection{background:var(--accent-soft)}

/* header */
header{position:sticky;top:0;z-index:10;background:color-mix(in srgb,var(--ground) 88%,transparent);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
.nav{display:flex;align-items:center;gap:28px;height:76px}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:19px;letter-spacing:.2px}
.nav .links{display:flex;gap:26px;margin-left:auto}
.nav .links a{color:var(--ink-2);font-size:15px;font-weight:600}
.nav .links a:hover{color:var(--ink)}
.nav .right{display:flex;align-items:center;gap:12px}
@media(max-width:860px){.nav .links{display:none}.nav .right{margin-left:auto}}
.icon-btn{width:44px;height:44px;border-radius:999px;border:1px solid var(--line-2);background:transparent;color:var(--ink);display:grid;place-items:center;cursor:pointer;padding:0}
.icon-btn:hover{border-color:var(--accent)}
.icon-btn svg{width:18px;height:18px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:10px;height:54px;padding:0 28px;border-radius:999px;border:1.5px solid var(--ink);background:transparent;color:var(--ink);font:700 16px var(--sans);white-space:nowrap;cursor:pointer}
.btn svg{width:18px;height:18px}
.btn.solid{background:var(--ink);color:var(--ground)}
.btn.violet{background:var(--accent);border-color:var(--accent);color:#fff}
.btn.sm{height:44px;padding:0 20px;font-size:15px}
.btn:hover{filter:brightness(1.1)}
.btn .short{display:none}
@media(max-width:480px){.btn.sm .long{display:none}.btn.sm .short{display:inline}}

/* hero */
.hero{padding:40px 0 72px}
.hero h1{font-size:clamp(52px,9vw,112px);line-height:.95;letter-spacing:-.03em}
.hero h1 span{color:var(--accent)}
.hero .row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,660px);gap:56px;align-items:start;margin-top:48px}
@media(max-width:900px){.hero .row{grid-template-columns:minmax(0,1fr);gap:32px;margin-top:28px}.hero .convo{order:-1}}
.lede{color:var(--ink-2);font-size:19px;max-width:34em}
.cta{display:flex;gap:12px;flex-wrap:wrap;margin-top:28px}
@media(max-width:560px){.cta{flex-direction:column}.cta .btn{width:100%}}
.snippet{margin-top:24px;max-width:100%;overflow-x:auto;white-space:nowrap;padding:12px 16px;border:1px solid var(--line);border-radius:16px;background:var(--card);font:13px var(--mono);color:var(--ink-2)}
.snippet .t{color:var(--accent-text)}
.hint{margin-top:10px;color:var(--muted);font-size:14px}
.convo{display:flex;flex-direction:column;gap:14px}
.bubble{max-width:560px;padding:20px 28px;border-radius:999px;font-weight:700;font-size:clamp(17px,2vw,24px);line-height:1.3}
.bubble.me{align-self:flex-start;background:var(--accent);color:#fff}
.bubble.ai{align-self:flex-end;background:var(--lav);color:var(--lav-ink)}
@media(max-width:560px){.bubble{border-radius:28px;padding:16px 22px}}
.issue{margin-left:clamp(0px,10%,120px);padding:22px 24px;border-radius:30px;background:var(--block);border:1px solid var(--block-line);color:#fff;font:14px/1.6 var(--mono)}
@media(max-width:900px){.issue{margin-left:0;font-size:12.5px}}
.issue b{display:block;font:800 19px/1.3 var(--sans)}
.issue .labels{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}
.issue .labels span{padding:3px 10px;border-radius:999px;background:#2a2a2d;color:#c9c9cf}
.issue .labels span:first-child{background:rgba(124,58,237,.35);color:#ddd6fe}
.issue .body{color:#c9c9cf}
.issue .more{margin-top:8px;color:#8b8b90}

/* stats */
.stats{max-width:calc(var(--wrap) + 16px);margin:0 auto;padding:40px;border-radius:30px;background:var(--block);border:1px solid var(--block-line);color:#fff;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:32px}
@media(max-width:900px){.stats{grid-template-columns:repeat(2,minmax(0,1fr));margin:0 12px;padding:32px 22px;gap:24px}}
.stat .v{font-size:clamp(40px,4.4vw,54px);font-weight:900;line-height:1}
.stat .l{margin-top:8px;color:#a2a2a2;font-size:14px;line-height:1.35}

/* sections */
section{padding:88px 0}
.kicker{font-size:13px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--accent-text);margin-bottom:14px}
section h2,.block h2{font-size:clamp(34px,5vw,56px);max-width:18ch}
section .sub,.block .sub{color:var(--ink-2);max-width:40em;margin-top:18px;font-size:18px}
.grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-top:40px}
@media(max-width:900px){.grid3{grid-template-columns:minmax(0,1fr)}}
.card{padding:28px;border-radius:30px;background:var(--card);display:flex;flex-direction:column;gap:12px}
.card h3{font-size:24px}
.card p{color:var(--ink-2);font-size:16px}
.card .pill{align-self:flex-start;height:36px;display:inline-flex;align-items:center;padding:0 16px;border-radius:999px;background:var(--accent);color:#fff;font-weight:800;font-size:15px}
.card svg{width:28px;height:28px;color:var(--accent)}

/* dark blocks: architecture, quickstart, closing */
.block{border-radius:30px;background:var(--block);border:1px solid var(--block-line);color:#fff;padding:56px 48px}
@media(max-width:700px){.block{padding:36px 22px;border-radius:24px}}
.block h2{color:#fff}
.block .kicker{color:#c4b5fd}
.block .sub{color:#a2a2a2}
.block code{color:#c4b5fd}
.node{padding:24px;border-radius:24px;background:#202022;border:1px solid #2e2e31;display:flex;flex-direction:column;gap:10px}
.node.mid{border-color:#7c3aed}
.node-label{font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#8b8b90}
.node.mid .node-label{color:#c4b5fd}
.node h3{font-size:22px;color:#fff}
.node p{color:#a2a2a2;font-size:15px}
.node .tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:auto}
.node .tags span,.chips span{padding:4px 12px;border-radius:999px;background:#2a2a2d;color:#c9c9cf;font:12px var(--mono)}
.node .out{margin-top:auto;font:13px var(--mono);color:#c4b5fd}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:24px;align-items:center}
.chips .lbl{background:none;padding:0 6px 0 0;color:#8b8b90;font:800 12px var(--sans);letter-spacing:.08em;text-transform:uppercase}
.chips b{color:#c4b5fd;font-weight:400}
.term{padding:22px;border-radius:24px;background:#202022;border:1px solid #2e2e31}
.term .bar{font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#8b8b90;margin-bottom:10px}
.term pre{margin:0;font:13px/1.8 var(--mono);color:#e4e4e7;white-space:pre-wrap}
.term .a{color:#c4b5fd}.term .d{color:#8b8b90}
.term p{margin-top:10px;color:#a2a2a2;font-size:14px}
.block .btn{border-color:#fff;color:#fff}
.block .btn.solid{background:#fff;color:#1a1a1a}

/* roadmap */
.roadmap{display:flex;flex-direction:column;gap:12px;margin-top:40px}
.phase{display:grid;grid-template-columns:auto minmax(0,1fr);gap:18px;align-items:start;padding:24px;border-radius:24px;background:var(--card)}
.phase .tag{height:40px;min-width:56px;display:grid;place-items:center;padding:0 14px;border-radius:999px;background:var(--accent);color:#fff;font-weight:900}
.phase.next .tag{background:var(--accent-soft);color:var(--accent-text)}
.phase.later .tag{background:transparent;border:1.5px solid var(--line-2);color:var(--muted)}
.phase h3{font-size:21px;line-height:1.2}
.phase p{margin-top:6px;color:var(--ink-2);font-size:15.5px}
.phase.later h3,.phase.later p{color:var(--muted)}
.state{display:inline-block;margin-left:8px;padding:2px 10px;border-radius:999px;font:800 11px var(--sans);letter-spacing:.06em;vertical-align:middle;border:1px solid var(--line-2);color:var(--muted)}
.state.build{background:var(--accent);border-color:var(--accent);color:#fff}
.state.committed{border-color:var(--accent);color:var(--accent-text)}

/* compare */
.compare{overflow-x:auto;margin-top:40px;border-radius:24px;background:var(--card)}
.compare table{border-collapse:collapse;width:100%;min-width:720px;font-size:15px}
.compare th,.compare td{padding:15px 16px;border-bottom:1px solid var(--line);text-align:center}
.compare td:first-child,.compare th:first-child{text-align:left;color:var(--ink-2)}
.compare th{font-weight:800;color:var(--ink-2)}
.compare th.us,.compare td.yes{color:var(--accent-text);font-weight:900}
.compare td.no{color:var(--muted)}
.compare tr:last-child td{border-bottom:0}
.fineprint{margin-top:18px;color:var(--muted);font-size:15px;max-width:44em}
.fineprint a{text-decoration:underline}

/* faq */
.faq{margin-top:36px;display:flex;flex-direction:column;gap:10px;max-width:860px}
.faq details{border-radius:22px;background:var(--card);padding:0 24px}
.faq summary{list-style:none;cursor:pointer;padding:22px 0;font-weight:800;font-size:18px;display:flex;justify-content:space-between;align-items:center;gap:16px}
.faq summary::-webkit-details-marker{display:none}
.faq summary::after{content:"+";color:var(--accent-text);font-size:26px;line-height:1}
.faq details[open] summary::after{content:"–"}
.faq details p{padding:0 0 22px;color:var(--ink-2);max-width:42em}
.faq a{text-decoration:underline}

/* closing */
.closing{text-align:center}
.closing h2{margin:0 auto;max-width:16ch}
.closing .sub{margin:16px auto 0}
.closing .cta{justify-content:center}

/* footer */
footer{margin-top:24px;padding:56px 0 32px;border-top:1px solid var(--line)}
footer .top{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:32px}
@media(max-width:820px){footer .top{grid-template-columns:1fr 1fr}}
footer p.tag{margin-top:14px;color:var(--ink-2);font-size:15px;max-width:30ch}
footer h4{margin:0 0 12px;font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
footer .col a{display:block;padding:5px 0;color:var(--ink-2);font-size:15px}
footer .col a:hover{color:var(--ink)}
footer .bottom{margin-top:40px;padding-top:20px;border-top:1px solid var(--line);display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;color:var(--muted);font-size:14px}

/* legal pages */
.legal{padding-top:56px;padding-bottom:40px;max-width:760px}
.legal h1{font-size:clamp(36px,6vw,56px)}
.legal .stand{color:var(--muted);font-size:14px;margin-top:10px}
.legal h2{font-size:22px;margin:38px 0 10px;line-height:1.2}
.legal h3{font-size:17px;margin:22px 0 6px;font-weight:800}
.legal p,.legal li{color:var(--ink-2);font-size:16px}
.legal ul{padding-left:20px;margin:8px 0}
.legal li{margin:5px 0}
.legal a{color:var(--accent-text);text-decoration:underline}
.legal .back{display:inline-block;margin-top:24px;color:var(--ink-2);text-decoration:none}
`;

// Line icons for the theme toggle (static markup, never user input).
const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/></svg>';
const ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

// Vanilla-JS theme toggle, served same-origin so CSP needs no 'unsafe-inline'
// on script-src. Loaded synchronously in <head> (not deferred) so the theme
// applies before first paint. Without a stored choice it follows the system.
const THEME_JS = `(function(){
var KEY='fk-theme', SUN=${JSON.stringify(SUN)}, MOON=${JSON.stringify(MOON)};
function stored(){try{return localStorage.getItem(KEY)}catch(e){return null}}
function current(){return stored()||(window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')}
function apply(t){document.documentElement.setAttribute('data-theme',t);var b=document.getElementById('fk-theme-btn');if(b)b.innerHTML=t==='dark'?SUN:MOON}
apply(current());
document.addEventListener('DOMContentLoaded',function(){
  var b=document.getElementById('fk-theme-btn');
  if(!b)return;
  apply(current());
  b.addEventListener('click',function(){var next=current()==='dark'?'light':'dark';try{localStorage.setItem(KEY,next)}catch(e){}apply(next)});
});
})();`;

function logoMark(size = 28): string {
  return `<svg viewBox="0 0 48 48" width="${size}" height="${size}" style="display:block;flex-shrink:0" aria-hidden="true"><rect x="3" y="8" width="30" height="14" rx="7" fill="var(--accent)"></rect><rect x="15" y="26" width="30" height="14" rx="7" fill="#a78bfa"></rect></svg>`;
}

function head(title: string, description: string): string {
  return `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><meta name="description" content="${description}">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'%3E%3Crect x='3' y='8' width='30' height='14' rx='7' fill='%237c3aed'/%3E%3Crect x='15' y='26' width='30' height='14' rx='7' fill='%23a78bfa'/%3E%3C/svg%3E">
<style>${CSS}</style>
<script src="/theme.js"></script>`;
}

const HEADER = `<header><div class="wrap nav">
  <a class="brand" href="/">${logoMark()} FeedbackKit</a>
  <nav class="links" aria-label="Main"><a href="/#how">How it works</a><a href="/#architecture">Architecture</a><a href="/#roadmap">Roadmap</a><a href="/#faq">FAQ</a><a href="https://github.com/TruffleCraft/feedbackkit" target="_blank" rel="noopener">GitHub</a></nav>
  <div class="right">
    <button type="button" class="icon-btn" id="fk-theme-btn" aria-label="Toggle dark mode" title="Toggle dark mode">${MOON}</button>
    <a class="btn violet sm" href="/#try"><span class="long">Try the demo</span><span class="short">Demo</span></a>
  </div>
</div></header>`;

const FOOTER = `<footer><div class="wrap">
  <div class="top">
    <div>
      <div class="brand">${logoMark()} FeedbackKit</div>
      <p class="tag">Open feedback infrastructure you host yourself. One script tag on the front end, structured issues on the back.</p>
    </div>
    <div class="col"><h4>Product</h4>
      <a href="/#how">How it works</a><a href="/#architecture">Architecture</a><a href="/#roadmap">Roadmap</a></div>
    <div class="col"><h4>Project</h4>
      <a href="https://github.com/TruffleCraft/feedbackkit" target="_blank" rel="noopener">GitHub</a><a href="/#try">Live demo</a></div>
    <div class="col"><h4>Legal</h4>
      <a href="/impressum">Impressum</a><a href="/datenschutz">Datenschutz</a></div>
  </div>
  <div class="bottom"><span>© 2026 TruffleCraft · Michel Schieder</span><span>Made with FeedbackKit on Cloudflare Workers</span></div>
</div></footer>`;

function shell(opts: { title: string; description: string; body: string; widget?: boolean }): string {
  return `<!doctype html><html lang="en"><head>${head(opts.title, opts.description)}</head><body>
${HEADER}
${opts.body}
${FOOTER}
${opts.widget ? `<script src="${GATEWAY}/widget.js?v=${WIDGET_VER}" data-project="${DEMO_PROJECT_KEY}"></script>` : ""}
</body></html>`;
}

function compareTable(): string {
  const cols = ["FeedbackKit", "BugDrop", "Sentry UF", "Marker.io", "Formbricks"];
  const rows: Array<[string, boolean[]]> = [
    ["Sync LLM follow-up before the issue exists", [true, false, false, false, false]],
    ["Per-project feedback types with required fields", [true, false, false, true, true]],
    ["Self-hosted, no SaaS", [true, true, false, false, true]],
    ["No session replay / surveillance", [true, true, false, false, true]],
    ["Local / private LLM capable", [true, false, false, false, false]],
  ];
  const headRow = `<tr><th></th>${cols.map((c, i) => `<th${i === 0 ? ' class="us"' : ""}>${c}</th>`).join("")}</tr>`;
  const bodyRows = rows
    .map(([label, vals]) => `<tr><td>${label}</td>${vals.map((v) => `<td class="${v ? "yes" : "no"}">${v ? "✓" : "—"}</td>`).join("")}</tr>`)
    .join("");
  return `<div class="compare"><table>${headRow}${bodyRows}</table></div>`;
}

function homePage(): string {
  const body = `
<section class="hero" id="top"><div class="wrap">
  <h1>Complete feedback,<br><span>at the source.</span></h1>
  <div class="row">
    <div>
      <p class="lede">Users rarely know what developers need. FeedbackKit closes the loop while they are still on the page: they write one sentence, an AI structures it and asks one follow-up if something is missing, and a complete, agent-ready GitHub issue lands in your repo.</p>
      <div class="cta">
        <a class="btn solid" href="#try">Try the live demo ${ARROW}</a>
        <a class="btn" href="#how">How it works</a>
      </div>
      <div class="snippet"><span class="t">&lt;script</span> src="…/widget.js" data-project="fk_pub_…"<span class="t">&gt;&lt;/script&gt;</span></div>
      <p class="hint">Two attributes. All config comes from the gateway, so the snippet never goes stale.</p>
    </div>
    <div class="convo" aria-label="Example conversation">
      <div class="bubble me">everything is GONE again?!? i wrote a whole page</div>
      <div class="bubble ai">What did you do right before it disappeared?</div>
      <div class="issue">
        <b>[BUG] Editor loses an unsaved draft on navigation</b>
        <div class="labels"><span>type/bug</span><span>source/feedbackkit</span></div>
        <div class="body">## Steps<br>1. Write in /editor/draft-7<br>2. Leave the page, come back: the text is gone</div>
        <div class="more">+ 2 screenshots · console: autosave 409</div>
      </div>
    </div>
  </div>
</div></section>

<div class="stats">
  <div class="stat"><div class="v">2</div><div class="l">attributes in the snippet</div></div>
  <div class="stat"><div class="v">~22 kB</div><div class="l">widget, gzipped</div></div>
  <div class="stat"><div class="v">1</div><div class="l">follow-up question at most</div></div>
  <div class="stat"><div class="v">0</div><div class="l">cookies and trackers</div></div>
  <div class="stat"><div class="v">MIT</div><div class="l">license, self-hosted</div></div>
</div>

<section id="how"><div class="wrap">
  <div class="kicker">01 · How it works</div>
  <h2>One sentence in. A structured issue out.</h2>
  <p class="sub">No wizards and no required fields up front. If the AI call fails, times out or is over budget, the issue is created anyway, so feedback is never lost.</p>
  <div class="grid3">
    <div class="card"><span class="pill">Step 1</span><h3>The user writes freely</h3><p>One text box, plus screenshots if they want. "everything is GONE again?!" is a fine report.</p></div>
    <div class="card"><span class="pill">Step 2</span><h3>The AI asks once</h3><p>One call reads the text, the screenshots and the page context, picks the type and asks for the one thing that is missing.</p></div>
    <div class="card"><span class="pill">Step 3</span><h3>An issue lands</h3><p>A titled, labelled GitHub issue with screenshots and environment, structured enough for a coding agent to act on.</p></div>
  </div>
</div></section>

<div class="wrap" id="architecture"><div class="block">
  <div class="kicker">02 · Architecture</div>
  <h2>One Worker. One deploy. Your account.</h2>
  <p class="sub">A single Cloudflare Worker serves the widget, the config and the API, backed by D1 and R2 on free tiers. Run <code>pnpm deploy</code> and you are live. There is no central FeedbackKit service.</p>
  <div class="grid3">
    <div class="node">
      <span class="node-label">Your website, any stack</span>
      <h3>Widget</h3>
      <p>Vanilla TS in a Shadow DOM. Free text, screenshots, session context. It never fights your CSS.</p>
      <div class="out">POST /api/feedback</div>
    </div>
    <div class="node mid">
      <span class="node-label">Self-hosted on Cloudflare</span>
      <h3>Gateway Worker</h3>
      <p>Origin allowlist, rate limit and honeypot, then one structured-output LLM call with server-side validation as the hard gate.</p>
      <div class="tags"><span>D1</span><span>R2</span><span>budget cap</span><span>your own LLM</span></div>
    </div>
    <div class="node">
      <span class="node-label">Your repo</span>
      <h3>GitHub issue</h3>
      <p>Titled, labelled, attachments inlined. GitLab, Jira and Trello are on the roadmap.</p>
      <div class="out">issue_created</div>
    </div>
  </div>
  <div class="chips">
    <span class="lbl">Create anyway</span>
    <span>LLM down: issue unenriched <b>ai-failed</b></span>
    <span>D1 down: issue still created <b>d1-degraded</b></span>
    <span>GitHub down: payload kept for retry <b>issue_failed</b></span>
  </div>
</div></div>

<section><div class="wrap">
  <div class="kicker">03 · Privacy first</div>
  <h2>Feedback without surveillance.</h2>
  <p class="sub">No session replay, no keystrokes, no stable user IDs, no stored IPs. The widget counts an anonymous, content-free funnel, and everything runs in your own account.</p>
  <div class="grid3">
    <div class="card">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 4v5c0 4.5-3 8-7 9-4-1-7-4.5-7-9V7z"/><path d="M9.5 12l2 2 3.5-3.5"/></svg>
      <h3>Your data stays yours</h3><p>Gateway, database and attachments live in your Cloudflare account. Console errors are PII-redacted before they leave the browser.</p>
    </div>
    <div class="card">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 12h6M12 9v6"/></svg>
      <h3>Your LLM, or none</h3><p>Any OpenAI-compatible endpoint: OpenRouter, your own LiteLLM or a local model. A daily budget cap per project, and with the LLM off the widget still collects the report.</p>
    </div>
    <div class="card">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h10"/></svg>
      <h3>Your feedback types</h3><p>Bug, feature request and change request out of the box. Every project defines its own types with required fields, and the AI picks the right one.</p>
    </div>
  </div>
</div></section>

<section id="roadmap" style="padding-top:0"><div class="wrap">
  <div class="kicker">04 · Roadmap</div>
  <h2>Built in the open, gated by evidence.</h2>
  <p class="sub">P1 and P2 are committed. Later phases start only when their outcome gate is true; the completion funnel is the core metric from day one.</p>
  <div class="roadmap">
    <div class="phase"><span class="tag">P1</span><div><h3>MVP: unstructured feedback to structured issue <span class="state build">IN BUILD</span></h3><p>One-worker deploy, vanilla Shadow-DOM widget, vision extraction with one structured-output call, the follow-up question, create-anyway matrix, seed-JSON config. Exit: a real product runs on it in production for a week, p90 extraction under 8 s.</p></div></div>
    <div class="phase next"><span class="tag">P2</span><div><h3>Admin UI, annotation and onboarding <span class="state committed">COMMITTED</span></h3><p>Full admin (field editor, funnel dashboard, theming with live preview), GitHub App flow, signed webhook sink. Exit: a stranger installs it in 15 minutes or less.</p></div></div>
    <div class="phase later"><span class="tag">P3</span><div><h3>Widget deluxe and full GitHub <span class="state">GATED</span></h3><p>Full a11y, i18n en/de, GitHub Projects v2 board fields. Gate: two weeks of funnel data prove the follow-up loop works.</p></div></div>
    <div class="phase later"><span class="tag">P4</span><div><h3>Provider ecosystem <span class="state">GATED</span></h3><p>GitLab first, then Jira Cloud and Trello, so the same feedback lands wherever each project chooses. Gate: an external operator asks for a second provider.</p></div></div>
    <div class="phase later"><span class="tag">P5</span><div><h3>Local and private LLMs <span class="state">GATED</span></h3><p>Custom endpoints in the admin up to a fully local recipe: self-hosted GitLab and a local model, nothing leaves your network.</p></div></div>
  </div>
</div></section>

<section id="compare" style="padding-top:0"><div class="wrap">
  <div class="kicker">05 · Why not …?</div>
  <h2>The moat is the combination.</h2>
  <p class="sub">"An LLM formats issues" is easy to copy. A follow-up question <em>before</em> the issue exists, while the user is still on the page, plus automatic session context, self-hosting and agent-ready output is not.</p>
  ${compareTable()}
  <p class="fineprint">Honest note: if you just want screenshots in GitHub issues with zero infrastructure, <a href="https://bugdrop.dev/" target="_blank" rel="noopener">BugDrop</a> is excellent. FeedbackKit is for teams that want complete feedback, their own types, multi-project routing and self-hosting.</p>
</div></section>

<section id="faq" style="padding-top:0"><div class="wrap">
  <div class="kicker">06 · Questions</div>
  <h2>Frequently asked questions</h2>
  <div class="faq">
    <details><summary>Where does the feedback go?</summary><p>Straight into your GitHub repo as a structured, labelled issue with title, body sections, screenshots and device context. From P2 a signed webhook sink lets you route the same payload anywhere (n8n, Zapier, Actions).</p></details>
    <details><summary>Do I need my own AI key?</summary><p>For the AI part, yes: any OpenAI-compatible endpoint, and the key stays in your Cloudflare account. There is a daily budget cap per project, and with the LLM switched off the widget still collects every report.</p></details>
    <details><summary>What data does the widget collect?</summary><p>The feedback text, screenshots the user adds, and technical context: browser, OS, viewport, language, page URL without query string, recent console errors (PII-filtered in the browser). Funnel events carry no content. See the <a href="/datenschutz">Datenschutzerklärung</a>.</p></details>
    <details><summary>What happens when the AI fails or the budget is spent?</summary><p>The issue is created unenriched and labelled <code>ai-failed</code>. Even if the database is unreachable, the issue is still created. No failure may lose feedback.</p></details>
    <details><summary>Does it slow my page down or break my styles?</summary><p>No. The ~22 kB gzipped widget renders inside a Shadow DOM, isolated from your CSS, and loads after your page is interactive, on any stack including React and Next.</p></details>
    <details><summary>How hard is it to run?</summary><p>One <code>pnpm deploy</code> to your Cloudflare account (Workers, D1, R2, free tiers). Your fork stays commit-identical with upstream, so "Sync fork" is a conflict-free upgrade, and <code>/diag</code> tells you what is wrong before you have to guess.</p></details>
  </div>
</div></section>

<div class="wrap" id="start"><div class="block">
  <div class="kicker">07 · Get started</div>
  <h2>Clone to first issue in about 15 minutes.</h2>
  <p class="sub">Fork the repo, run setup, deploy to your Cloudflare account. Updating is one click on "Sync fork".</p>
  <div class="grid3">
    <div class="term"><div class="bar">1 · Set up</div><pre><span class="a">$</span> git clone …/feedbackkit
<span class="a">$</span> pnpm setup</pre><p>Idempotent. The LLM key can wait; it prints your URLs.</p></div>
    <div class="term"><div class="bar">2 · Deploy</div><pre><span class="a">$</span> pnpm deploy
<span class="d">✓ migrations · ✓ worker live</span></pre><p>Workers, D1 and R2 on free tiers. <code>/diag</code> checks everything.</p></div>
    <div class="term"><div class="bar">3 · Paste the snippet</div><pre><span class="a">&lt;script</span> src=<span class="d">"…/widget.js"</span>
  data-project=<span class="d">"fk_pub_…"</span><span class="a">&gt;&lt;/script&gt;</span></pre><p>Dry-run it first on <code>/t/&lt;key&gt;</code>.</p></div>
  </div>
</div></div>

<section id="try"><div class="wrap"><div class="block closing">
  <h2>Go on, leave us feedback.</h2>
  <p class="sub">The Feedback button in the bottom-right corner is the real widget, wired to a live gateway. Report a bug, ask for a feature or tell us what you think of this page. A real issue opens on GitHub.</p>
  <div class="cta">
    <a class="btn solid" href="https://github.com/TruffleCraft/feedbackkit" target="_blank" rel="noopener">View on GitHub ${ARROW}</a>
    <a class="btn" href="/#how">Read how it works</a>
  </div>
</div></div></section>`;

  return shell({
    title: "FeedbackKit: turn messy feedback into structured issues",
    description: "A self-hosted feedback widget that turns what your users actually type into clean, structured, agent-ready GitHub issues — with AI, screenshots, and full context.",
    body,
    widget: true,
  });
}

function impressumPage(): string {
  const body = `<div class="wrap legal">
  <h1>Impressum</h1>
  <p class="stand">Angaben gemäß § 5 DDG (Digitale-Dienste-Gesetz)</p>

  <h2>Diensteanbieter</h2>
  <p>Michel Schieder<br>
  TruffleCraft (Einzelunternehmen / Kleingewerbe)<br>
  Köpenicker Straße 40<br>
  10179 Berlin<br>
  Deutschland</p>

  <h2>Kontakt</h2>
  <p>E-Mail: <a href="mailto:hello@trufflecraft.com">hello@trufflecraft.com</a></p>

  <h2>Umsatzsteuer</h2>
  <p>Als Kleinunternehmer im Sinne von § 19 UStG wird keine Umsatzsteuer ausgewiesen; eine Umsatzsteuer-Identifikationsnummer liegt nicht vor.</p>

  <h2>Verantwortlich für den Inhalt</h2>
  <p>Michel Schieder (Anschrift wie oben)</p>

  <h2>Hinweis</h2>
  <p>Diese Website ist eine Produkt-Demo von FeedbackKit. Über das eingebundene Feedback-Widget übermittelte Angaben werden als Issue im öffentlichen GitHub-Repository <a href="https://github.com/TruffleCraft/feedbackkit" target="_blank" rel="noopener">TruffleCraft/feedbackkit</a> veröffentlicht. Bitte übermittle keine personenbezogenen oder vertraulichen Daten. Details in der <a href="/datenschutz">Datenschutzerklärung</a>.</p>

  <a class="back" href="/">← Zurück zur Startseite</a>
</div>`;
  return shell({ title: "Impressum — FeedbackKit", description: "Impressum und Anbieterkennzeichnung der FeedbackKit-Demo.", body });
}

function datenschutzPage(): string {
  const body = `<div class="wrap legal">
  <h1>Datenschutzerklärung</h1>
  <p class="stand">Stand: Juli 2026</p>

  <h2>1. Verantwortlicher</h2>
  <p>Michel Schieder, TruffleCraft (Einzelunternehmen), Köpenicker Straße 40, 10179 Berlin, Deutschland.<br>
  E-Mail: <a href="mailto:hello@trufflecraft.com">hello@trufflecraft.com</a></p>

  <h2>2. Was diese Seite ist</h2>
  <p>Diese Website ist eine öffentlich erreichbare Produkt-Demo von FeedbackKit. Sie bindet das FeedbackKit-Feedback-Widget ein, das über eine separate Gateway-Infrastruktur (Cloudflare Worker) läuft.</p>

  <h2>3. Aufruf der Website (Server-Logs)</h2>
  <p>Beim Aufruf verarbeitet der Hosting-Dienstleister Cloudflare technisch notwendige Verbindungsdaten (u. a. IP-Adresse, Zeitpunkt, angeforderte Ressource, User-Agent), um die Seite auszuliefern und Missbrauch/Angriffe abzuwehren. Rechtsgrundlage: Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse an sicherem Betrieb). Es werden keine Cookies gesetzt und kein Tracking/Analytics eingesetzt.</p>

  <h2>4. Nutzung des Feedback-Widgets</h2>
  <p>Nur wenn du das Feedback-Widget aktiv öffnest und absendest, werden verarbeitet:</p>
  <ul>
    <li>dein eingegebener <b>Feedback-Text</b> (und die Antwort auf eine etwaige Rückfrage);</li>
    <li>ein optionaler <b>Screenshot</b> der Seite (nur wenn du die Option aktiviert lässt bzw. eine Datei anhängst);</li>
    <li>technische <b>Kontextdaten</b>: Browser, Betriebssystem, Fenster-/Bildschirmgröße, Sprache, die aufgerufene URL sowie die letzten Browser-Konsolenmeldungen;</li>
    <li>deine <b>IP-Adresse</b> ausschließlich zur Begrenzung von Missbrauch (Rate-Limiting); sie wird nicht dauerhaft mit dem Feedback gespeichert.</li>
  </ul>
  <p>Offensichtliche Geheimnisse (z. B. E-Mail-Adressen, Tokens) werden aus den Konsolenmeldungen automatisch entfernt, bevor sie übertragen werden (Datenminimierung). Bitte gib dennoch keine personenbezogenen oder vertraulichen Daten in den Freitext ein.</p>
  <p>Zweck: Bearbeitung und Nachvollziehbarkeit deines Feedbacks sowie Erstellung eines GitHub-Issues. Rechtsgrundlage: Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse an Produktverbesserung und Missbrauchsabwehr); für freiwillig im Freitext angegebene Daten Art. 6 Abs. 1 lit. a DSGVO (Einwilligung durch aktives Absenden).</p>

  <h2>5. Empfänger / Auftragsverarbeiter</h2>
  <ul>
    <li><b>Cloudflare</b> — Hosting sowie Speicherung des Feedbacks und der Uploads (Workers, D1-Datenbank, R2-Objektspeicher).</li>
    <li><b>OpenRouter</b> — KI-Verarbeitung des Feedback-Textes (und ggf. des Screenshots) zur Strukturierung. Die anbieterseitige Speicherung/Weiterverwendung ist per Einstellung deaktiviert (<code>data_collection: deny</code>).</li>
    <li><b>GitHub</b> — der erzeugte Issue wird in einem GitHub-Repository erstellt und ist dort (bei einem öffentlichen Repository) öffentlich einsehbar.</li>
  </ul>

  <h2>6. Übermittlung in Drittländer</h2>
  <p>Die genannten Dienstleister können Daten in den USA verarbeiten. Die Übermittlung erfolgt auf Grundlage von Standardvertragsklauseln der EU-Kommission (Art. 46 DSGVO) bzw. — soweit zertifiziert — des EU-US Data Privacy Framework.</p>

  <h2>7. Speicherdauer</h2>
  <p>Screenshots und Datei-Uploads dieser Demo werden nach 30 Tagen automatisch gelöscht. Der erzeugte GitHub-Issue bleibt bestehen, bis er gelöscht wird. Auf Wunsch entfernen wir zugehörige Anhänge und Daten früher.</p>

  <h2>8. Deine Rechte</h2>
  <p>Du hast das Recht auf Auskunft (Art. 15), Berichtigung (Art. 16), Löschung (Art. 17), Einschränkung (Art. 18), Datenübertragbarkeit (Art. 20) und Widerspruch (Art. 21 DSGVO) sowie das Recht, eine erteilte Einwilligung zu widerrufen. Wende dich dazu an die oben genannte E-Mail-Adresse.</p>
  <p>Zudem besteht ein Beschwerderecht bei einer Aufsichtsbehörde, z. B. der Berliner Beauftragten für Datenschutz und Informationsfreiheit (BlnBDI).</p>

  <a class="back" href="/">← Zurück zur Startseite</a>
</div>`;
  return shell({ title: "Datenschutzerklärung — FeedbackKit", description: "Datenschutzerklärung der FeedbackKit-Demo: welche Daten das Feedback-Widget verarbeitet und warum.", body });
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": CSP,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Cache-Control": "public, max-age=300",
    },
  });
}

function fontResponse(): Response {
  const bin = atob(URBANIST_WOFF2_B64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Response(bytes, {
    headers: {
      "Content-Type": "font/woff2",
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function themeJsResponse(): Response {
  return new Response(THEME_JS, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export default {
  fetch(req: Request): Response {
    const { pathname } = new URL(req.url);
    if (pathname === "/fonts/urbanist.woff2") return fontResponse();
    if (pathname === "/theme.js") return themeJsResponse();
    if (pathname === "/impressum") return htmlResponse(impressumPage());
    if (pathname === "/datenschutz" || pathname === "/privacy") return htmlResponse(datenschutzPage());
    return htmlResponse(homePage());
  },
};
