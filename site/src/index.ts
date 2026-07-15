// FeedbackKit marketing / demo site — a standalone Cloudflare Worker, separate
// from the gateway. Introduces FeedbackKit, embeds the live widget (cross-origin
// from the gateway, wired to the feedbackkit-demo project), and carries the legal
// pages (Impressum + Datenschutz) required for a publicly reachable German site.
//
// Design (v2): developer-tool aesthetic, DM Sans (self-hosted for GDPR/CSP,
// served at /fonts/dm-sans.woff2), violet accent, dark theme by default with a
// persisted theme choice (data-theme attribute + /theme.js — no inline scripts, so
// script-src stays tight). Graphite panels (architecture, quickstart, closing
// CTA, footer) stay dark in both themes; the rest of the palette is themed.
//
// No inline JS or third-party origins → script-src is 'self' (theme toggle,
// same-origin) plus the gateway origin (widget bundle). style-src
// 'unsafe-inline' covers the page CSS and the widget's shadow styles. font-src
// 'self' for the self-hosted woff2 — no Google Fonts or other CDN.

import { DM_SANS_WOFF2_B64 } from "./font.js";
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
@font-face{font-family:"DM Sans";src:url("/fonts/dm-sans.woff2") format("woff2");font-weight:100 1000;font-style:normal;font-display:swap}
:root{
  --bg:#ffffff; --soft:#f6f7f7; --ink:#0a0a0b; --ink-2:#52525b; --muted:#8a8a90;
  --line:#e7e8ea; --line-2:#d9dbde; --accent:#7c3aed; --accent-ink:#ffffff; --glow:rgba(124,58,237,.14);
  --panel:#0c1117; --panel-line:rgba(255,255,255,.1); --nav-bg:rgba(255,255,255,.88);
  --sans:"DM Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  --wrap:1160px;
}
[data-theme="dark"]{
  --bg:#0c1117; --soft:#11161d; --ink:#e8eaed; --ink-2:#a3a9b2; --muted:#6b7280;
  --line:#1f2630; --line-2:#2b3442; --accent:#8b5cf6; --glow:rgba(139,92,246,.12);
  --panel:#080b0f; --panel-line:rgba(255,255,255,.08); --nav-bg:rgba(12,17,23,.88);
}
*{box-sizing:border-box}
html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}
body{margin:0;font-family:var(--sans);color:var(--ink);background:var(--bg);line-height:1.6;font-size:16px;-webkit-font-smoothing:antialiased;transition:background .2s ease,color .2s ease}
a{color:inherit;text-decoration:none}
a:hover{color:var(--accent)}
h1,h2,h3{margin:0;font-weight:700;letter-spacing:-.02em;line-height:1.1}
p{margin:0}
code,pre{font-family:var(--mono)}
.wrap{max-width:var(--wrap);margin:0 auto;padding:0 24px}
.accent{color:var(--accent)}
::selection{background:color-mix(in srgb,var(--accent) 22%,transparent)}

/* header */
header{position:sticky;top:0;z-index:10;background:var(--nav-bg);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.nav{display:flex;align-items:center;gap:24px;height:64px}
.brand{display:flex;align-items:center;gap:9px;font-weight:700;font-size:16.5px;letter-spacing:-.02em}
.nav .links{display:flex;gap:22px;margin-left:8px;flex-wrap:wrap}
.nav .links a{color:var(--ink-2);font-size:14.5px;font-weight:500}
.nav .links a:hover{color:var(--ink)}
.nav .right{margin-left:auto;display:flex;align-items:center;gap:12px}
@media(max-width:480px){.nav .right{gap:8px}.gh-link{display:none}}
.icon-btn{font-family:inherit;width:34px;height:34px;border-radius:8px;border:1px solid var(--line-2);background:transparent;color:var(--ink-2);cursor:pointer;display:grid;place-items:center;font-size:15px;line-height:1}
.icon-btn:hover{border-color:var(--accent);color:var(--accent)}
.btn{display:inline-flex;align-items:center;gap:8px;font-family:inherit;font-weight:600;font-size:14.5px;padding:9px 16px;border-radius:8px;border:1px solid var(--line-2);background:var(--bg);color:var(--ink);cursor:pointer;white-space:nowrap}
.btn:hover{border-color:var(--accent);color:var(--accent)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.btn.primary:hover{filter:brightness(.9);color:var(--accent-ink)}
.btn.lg{padding:12px 24px;font-size:15.5px}
@media(max-width:860px){.nav .links{display:none}}

/* hero */
.hero{position:relative;overflow:hidden}
.hero::before{content:"";position:absolute;inset:0;background:radial-gradient(720px 420px at 78% 0%,var(--glow),transparent 65%);pointer-events:none}
.hero::after{content:"";position:absolute;inset:0;background-image:radial-gradient(var(--line-2) 1px,transparent 1px);background-size:26px 26px;opacity:.35;mask-image:radial-gradient(680px 480px at 75% 20%,black,transparent 75%);-webkit-mask-image:radial-gradient(680px 480px at 75% 20%,black,transparent 75%);pointer-events:none}
.hero .grid{position:relative;z-index:1;display:grid;grid-template-columns:minmax(0,1fr);gap:56px 64px;align-items:center;padding:80px 0 88px}
@media(min-width:860px){.hero .grid{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}
.badges{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:22px}
.chip{display:inline-flex;align-items:center;gap:8px;font-family:var(--mono);font-size:11.5px;font-weight:600;letter-spacing:.05em;color:var(--accent);background:var(--soft);border:1px solid var(--line);padding:6px 13px;border-radius:999px}
.chip.dim{color:var(--muted)}
.hero h1{font-size:clamp(38px,4.6vw,58px);max-width:14ch}
.hero .lede{font-size:18px;color:var(--ink-2);max-width:48ch;margin-top:22px}
.cta{display:flex;gap:12px;flex-wrap:wrap;margin-top:28px}
.snippet{display:flex;align-items:center;gap:10px;font-family:var(--mono);font-size:13px;color:var(--ink-2);background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:10px 14px;margin-top:24px;max-width:100%;overflow-x:auto;white-space:nowrap}
.snippet .p{color:var(--muted);user-select:none}
.hint{font-size:13px;color:var(--muted);margin-top:14px}

/* Static examples used below the fold. The hero deliberately does not fake the
   live widget; having both visible created a misleading double-widget stack. */
.widget-mock{width:min(440px,100%);margin:0 auto;background:var(--bg);border:1px solid var(--line);border-radius:16px;box-shadow:0 24px 56px -24px rgba(12,17,23,.4);padding:20px;display:flex;flex-direction:column;gap:14px}
.widget-mock .head{display:flex;align-items:center;gap:8px;font-weight:700;font-size:14px}
.widget-mock .head .close{margin-left:auto;color:var(--muted);font-size:16px}
.widget-mock .tabs{display:flex;gap:6px}
.wtab{font-size:12.5px;font-weight:600;padding:5px 12px;border-radius:999px;border:1px solid var(--line-2);color:var(--ink-2)}
.wtab.active{background:color-mix(in srgb,var(--accent) 12%,transparent);border-color:var(--accent);color:var(--accent)}
.widget-mock .foot{display:flex;justify-content:flex-end}
.send{font-weight:600;font-size:13px;padding:8px 18px;border-radius:8px;background:var(--accent);color:var(--accent-ink)}
.mockcard{border:1px solid var(--line-2);border-radius:10px;background:var(--bg);padding:12px;display:flex;flex-direction:column;gap:8px}
.mockcard .txt{font-size:13px;color:var(--ink)}
.mockbox{border:1px solid var(--line-2);border-radius:10px;padding:12px 14px;font-size:14px;background:var(--soft);min-height:56px}
.mocktags{display:flex;flex-wrap:wrap;gap:6px}
.tagchip{font-family:var(--mono);font-size:10.5px;color:var(--ink-2);border:1px solid var(--line-2);border-radius:6px;padding:2px 8px}
.hero-signal{width:min(440px,100%);margin:0 auto;padding:22px;border:1px solid var(--panel-line);border-radius:18px;background:var(--panel);color:#fff;box-shadow:0 30px 70px -32px rgba(12,17,23,.72)}
.signal-head{display:flex;align-items:center;gap:10px;font-weight:700}.signal-head span{margin-left:auto;color:#8b5cf6;font:11px var(--mono)}
.signal-line{height:1px;margin:18px 0;background:linear-gradient(90deg,#8b5cf6,rgba(139,92,246,.08))}
.signal-flow{display:grid;gap:9px}.signal-step{display:grid;grid-template-columns:28px 1fr auto;align-items:center;gap:10px;padding:11px;border:1px solid rgba(255,255,255,.1);border-radius:10px;background:rgba(255,255,255,.035)}
.signal-step .n{display:grid;place-items:center;width:28px;height:28px;border-radius:8px;background:rgba(139,92,246,.15);color:#a78bfa;font:600 11px var(--mono)}
.signal-step b{font-size:13px}.signal-step em{color:#7dd3fc;font:normal 10px var(--mono)}
.signal-foot{margin-top:16px;color:rgba(255,255,255,.5);font:11px/1.5 var(--mono)}

/* stats */
.stats{border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.stats .grid{display:grid;grid-template-columns:repeat(5,1fr);margin:-1px 0 0 -1px}
.stat{border-left:1px solid var(--line);border-top:1px solid var(--line);padding:30px 18px;text-align:center}
.stat .v{font-size:26px;font-weight:700;letter-spacing:-.02em}
.stat .l{font-family:var(--mono);font-size:11px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);margin-top:6px}
@media(max-width:900px){.stats .grid{grid-template-columns:repeat(3,1fr)}}
@media(max-width:560px){.stats .grid{grid-template-columns:repeat(2,1fr)}}

/* sections */
section{padding:88px 0}
.kicker{font-family:var(--mono);font-size:12px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);margin-bottom:14px}
section h2{font-size:clamp(28px,3.4vw,40px);max-width:26ch}
section .sub{color:var(--ink-2);max-width:62ch;margin-top:16px;font-size:17px}

.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin-top:44px}
.card{border:1px solid var(--line);border-radius:14px;padding:26px;background:var(--bg)}
.card svg{width:24px;height:24px;color:var(--accent);margin-bottom:14px}
.card h3{font-size:17.5px;letter-spacing:-.01em}
.card p{color:var(--ink-2);font-size:14.5px;margin-top:8px}
@media(max-width:860px){.cards{grid-template-columns:1fr}}

/* graphite panels — fixed dark, identical in both themes (product output) */
.panel{border:1px solid var(--panel-line);border-radius:10px;background:var(--panel);overflow:hidden}
.panel .bar{padding:10px 14px;border-bottom:1px solid var(--panel-line);font-family:var(--mono);font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.4)}
.panel pre{margin:0;padding:14px;font-family:var(--mono);font-size:12.5px;line-height:1.8;color:rgba(255,255,255,.85);overflow-x:auto;white-space:pre-wrap}
.panel .note{margin:0;padding:0 14px 14px;font-size:12.5px;color:rgba(255,255,255,.45)}
.panel .body{padding:14px;display:flex;flex-direction:column;gap:8px;font-size:12px;color:rgba(255,255,255,.75)}
.panel b{color:#fff}
.panel .dim{color:rgba(255,255,255,.45)}
.panel .box2{border:1px solid var(--panel-line);border-radius:7px;padding:7px 9px;color:rgba(255,255,255,.85);background:rgba(255,255,255,.04)}
.panel .row-end{display:flex;justify-content:flex-end}
.panel .send2{font-weight:600;padding:6px 14px;border-radius:7px;background:var(--accent);color:#fff;font-size:11.5px}
.panel .micro{font-family:var(--mono);font-size:9px;border:1px solid var(--panel-line);border-radius:5px;padding:1px 6px;margin-left:6px}
.panel .label{font-size:9.5px;letter-spacing:.06em;text-transform:uppercase}

/* how it works */
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin-top:44px}
.step{border:1px solid var(--line);border-radius:14px;padding:26px;background:var(--soft);display:flex;flex-direction:column;gap:12px}
.step .n{font-family:var(--mono);font-size:13px;font-weight:700;color:var(--accent);width:32px;height:32px;border:1px solid var(--line-2);border-radius:8px;display:grid;place-items:center;background:var(--bg)}
.step h3{font-size:17.5px}
.step p{color:var(--ink-2);font-size:14.5px}
.step .demo{margin-top:auto}
@media(max-width:900px){.steps{grid-template-columns:1fr}}

/* architecture — always dark panel section */
.arch{background:var(--panel);border-top:1px solid var(--line)}
.arch h2,.arch .kicker{color:#fff}
.arch .kicker{color:var(--accent)}
.arch .sub{color:rgba(255,255,255,.6)}
.arch .flow{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:44px;align-items:stretch}
.node{border:1px solid var(--panel-line);border-radius:14px;padding:20px;background:rgba(255,255,255,.03);display:flex;flex-direction:column;gap:10px}
.node.mid{border-color:color-mix(in srgb,var(--accent) 45%,transparent);background:color-mix(in srgb,var(--accent) 7%,transparent)}
.node-label{font-family:var(--mono);font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.4)}
.node.mid .node-label{color:var(--accent)}
.node h3{color:#fff;font-size:16px}
.node p{color:rgba(255,255,255,.55);font-size:13.5px}
.node .tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:auto}
.node .tags span{font-family:var(--mono);font-size:10.5px;font-weight:700;color:rgba(255,255,255,.65);border:1px solid var(--panel-line);border-radius:6px;padding:2px 8px}
.node .out{margin-top:auto;font-family:var(--mono);font-size:11.5px;color:var(--accent)}
.invariants{display:flex;gap:10px;flex-wrap:wrap;margin-top:24px;align-items:center}
.invariants .lbl{font-family:var(--mono);font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.4)}
.invariants .pill{font-family:var(--mono);font-size:11.5px;color:rgba(255,255,255,.65);border:1px solid var(--panel-line);border-radius:999px;padding:4px 12px}
@media(max-width:900px){.arch .flow{grid-template-columns:1fr}}

/* roadmap */
.roadmap{display:grid;grid-template-columns:56px 1fr;gap:0 20px;margin-top:44px}
.dot-col{display:flex;flex-direction:column;align-items:center}
.dot{width:34px;height:34px;border-radius:999px;display:grid;place-items:center;font-family:var(--mono);font-size:12px;font-weight:700;flex-shrink:0}
.dot.done{background:var(--accent);color:#fff}
.dot.next{border:1.5px solid var(--accent);color:var(--accent);background:var(--bg)}
.dot.later{border:1px solid var(--line-2);color:var(--muted);background:var(--bg)}
.stem{flex:1;width:1px;background:var(--line-2);margin:6px 0}
.roadmap .item{padding-bottom:32px;display:flex;flex-direction:column;gap:6px}
.roadmap .item h3{font-size:18px}
.roadmap .item.later h3{color:var(--ink-2)}
.roadmap .item p{color:var(--ink-2);font-size:14.5px;max-width:68ch}
.roadmap .item.later p{color:var(--muted)}
.head-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.badge{font-family:var(--mono);font-size:10.5px;font-weight:700;letter-spacing:.06em;border-radius:6px;padding:2px 8px}
.badge.build{color:var(--accent);background:color-mix(in srgb,var(--accent) 10%,transparent);border:1px solid var(--accent)}
.badge.committed{color:var(--accent);border:1px solid var(--line-2)}
.badge.gated{color:var(--muted);border:1px solid var(--line-2)}

/* compare table */
.compare-table{overflow-x:auto;margin-top:40px;border:1px solid var(--line);border-radius:14px;background:var(--bg)}
.compare-table table{border-collapse:collapse;width:100%;min-width:720px;font-size:13.5px}
.compare-table th,.compare-table td{padding:13px 14px;border-bottom:1px solid var(--line);text-align:center}
.compare-table td:first-child,.compare-table th:first-child{text-align:left;color:var(--ink-2)}
.compare-table th{font-weight:600;color:var(--ink-2)}
.compare-table th.us{color:var(--accent);font-weight:700}
.compare-table td.yes{color:var(--accent);font-weight:700}
.compare-table td.no{color:var(--muted)}
.compare-table tr:last-child td{border-bottom:0}
.fineprint{margin-top:20px;font-size:13.5px;color:var(--muted);max-width:66ch}

/* faq */
.faq{margin-top:40px;border-top:1px solid var(--line);max-width:820px}
.faq details{border-bottom:1px solid var(--line)}
.faq summary{list-style:none;cursor:pointer;padding:20px 4px;font-weight:600;font-size:16.5px;display:flex;justify-content:space-between;align-items:center;gap:16px}
.faq summary::-webkit-details-marker{display:none}
.faq summary::after{content:"+";color:var(--muted);font-weight:400;font-size:22px}
.faq details[open] summary::after{content:"–"}
.faq details p{padding:0 4px 20px;color:var(--ink-2);font-size:15.5px;max-width:70ch}

/* quickstart */
.quickstart{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin-top:40px}
@media(max-width:900px){.quickstart{grid-template-columns:1fr}}

/* closing cta — graphite, fixed dark in both themes */
.close-cta{position:relative;overflow:hidden;background:var(--panel);border:1px solid var(--panel-line);border-radius:18px;padding:64px 32px;text-align:center}
.close-cta::before{content:"";position:absolute;inset:0;background:radial-gradient(560px 300px at 50% -20%,var(--glow),transparent 70%);pointer-events:none}
.close-cta h2{position:relative;font-size:clamp(26px,3.5vw,34px);color:#fff}
.close-cta p{position:relative;color:rgba(255,255,255,.65);max-width:52ch;margin:14px auto 0;font-size:17px}
.close-cta .cta{justify-content:center;position:relative}
.close-cta .btn{border-color:rgba(255,255,255,.25);color:#fff}
.close-cta .btn:hover{border-color:rgba(255,255,255,.6);color:#fff}
.close-cta .btn.primary{border-color:var(--accent)}

/* footer */
footer{background:#0c1117;color:rgba(255,255,255,.7);margin-top:80px;border-top:1px solid rgba(255,255,255,.08)}
footer .top{padding:56px 0 40px;display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:32px}
footer .brand{color:#fff}
footer p.tag{margin-top:14px;font-size:14px;max-width:34ch;color:rgba(255,255,255,.55)}
footer .col h4{font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.4);margin:0 0 14px}
footer .col a{display:block;font-size:14.5px;color:rgba(255,255,255,.72);padding:5px 0}
footer .col a:hover{color:#fff}
footer .bottom{border-top:1px solid rgba(255,255,255,.1);padding:20px 0;font-size:13px;color:rgba(255,255,255,.45);display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}
@media(max-width:820px){footer .top{grid-template-columns:1fr 1fr}}

/* legal pages */
.legal{padding:64px 0 40px;max-width:760px}
.legal h1{font-size:clamp(28px,5vw,40px)}
.legal .stand{color:var(--muted);font-size:14px;margin-top:10px}
.legal h2{font-size:20px;margin:38px 0 10px}
.legal h3{font-size:16px;margin:22px 0 6px}
.legal p,.legal li{color:var(--ink-2);font-size:15.5px}
.legal ul{padding-left:20px;margin:8px 0}
.legal li{margin:5px 0}
.legal a{color:var(--accent);text-decoration:underline}
.legal .back{display:inline-block;margin-top:8px;color:var(--ink-2);font-size:14.5px}
`;

// Vanilla-JS theme toggle, served same-origin so CSP needs no 'unsafe-inline'
// on script-src. Loaded synchronously in <head> (not deferred) so the stored
// theme applies before first paint — no flash of the wrong theme.
const THEME_JS = `(function(){
var KEY='fk-theme';
function apply(t){document.documentElement.setAttribute('data-theme',t)}
apply(localStorage.getItem(KEY)||'dark');
window.__fkToggleTheme=function(){
  var next=(localStorage.getItem(KEY)||'dark')==='dark'?'light':'dark';
  localStorage.setItem(KEY,next);
  apply(next);
  var btn=document.getElementById('fk-theme-btn');
  if(btn)btn.textContent=next==='dark'?'☀':'☾';
};
document.addEventListener('DOMContentLoaded',function(){
  var btn=document.getElementById('fk-theme-btn');
  if(!btn)return;
  btn.textContent=(localStorage.getItem(KEY)||'dark')==='dark'?'☀':'☾';
  btn.addEventListener('click',window.__fkToggleTheme);
});
})();`;

function logoMark(size = 26): string {
  return `<svg viewBox="0 0 32 32" width="${size}" height="${size}" style="display:block;flex-shrink:0" aria-hidden="true"><rect x="2" y="3" width="28" height="22" rx="7" fill="var(--accent)"></rect><path d="M9 23v8l9-8z" fill="var(--accent)"></path><path d="M16 7l1.9 5.1L23 14l-5.1 1.9L16 21l-1.9-5.1L9 14l5.1-1.9z" fill="#fff"></path></svg>`;
}

function head(title: string, description: string): string {
  return `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><meta name="description" content="${description}">
<style>${CSS}</style>
<script src="/theme.js"></script>`;
}

const HEADER = `<header><div class="wrap nav">
  <a class="brand" href="/">${logoMark()} FeedbackKit</a>
  <nav class="links"><a href="/#how">How it works</a><a href="/#architecture">Architecture</a><a href="/#roadmap">Roadmap</a><a href="/#compare">Compare</a><a href="/#faq">FAQ</a></nav>
  <div class="right">
    <button type="button" class="icon-btn" id="fk-theme-btn" aria-label="Toggle dark mode" title="Toggle dark mode">☾</button>
    <a class="gh-link" href="https://github.com/TruffleCraft/feedbackkit" target="_blank" rel="noopener" style="color:var(--ink-2);font-size:14.5px;font-weight:500">GitHub ↗</a>
    <a class="btn primary" href="/#try">Try the demo</a>
  </div>
</div></header>`;

const FOOTER = `<footer><div class="wrap">
  <div class="top">
    <div>
      <div class="brand" style="color:#fff">${logoMark()} FeedbackKit</div>
      <p class="tag">Open feedback infrastructure you host yourself. One script tag on the front end, structured issues on the back.</p>
    </div>
    <div class="col"><h4>Product</h4>
      <a href="/#how">How it works</a><a href="/#architecture">Architecture</a><a href="/#roadmap">Roadmap</a></div>
    <div class="col"><h4>Project</h4>
      <a href="https://github.com/TruffleCraft/feedbackkit" target="_blank" rel="noopener">GitHub</a><a href="/#try">Live demo</a></div>
    <div class="col"><h4>Legal</h4>
      <a href="/impressum">Impressum</a><a href="/datenschutz">Datenschutz</a></div>
  </div>
  <div class="bottom"><span>© 2026 TruffleCraft — Michel Schieder</span><span>Made with FeedbackKit · Cloudflare Workers</span></div>
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
  return `<div class="compare-table"><table>${headRow}${bodyRows}</table></div>`;
}

function homePage(): string {
  const body = `
<section class="hero" id="top"><div class="wrap"><div class="grid">
  <div>
    <div class="badges">
      <span class="chip">✦ Self-hosted · open source · AI-native</span>
      <span class="chip dim">Pre-0.1 · under active development</span>
    </div>
    <h1>Complete feedback, at the source.</h1>
    <p class="lede">Users rarely know what developers need. FeedbackKit closes the loop while they're still on the page: one sentence in, an AI structures it, asks one follow-up if something's missing — and a complete, agent-ready GitHub issue lands in your repo.</p>
    <div class="cta">
      <a class="btn primary lg" href="#try">Try the live demo ↘</a>
      <a class="btn lg" href="#how">How it works</a>
    </div>
    <div class="snippet"><span class="p">$</span> <span class="accent">&lt;script</span> src=<span class="p">"…/widget.js"</span> data-project=<span class="p">"fk_pub_…"</span><span class="accent">&gt;&lt;/script&gt;</span></div>
    <p class="hint">Exactly 2 attributes — all config comes from the gateway. The snippet never goes stale.</p>
  </div>

  <div class="hero-signal">
    <div class="signal-head">${logoMark(22)} FeedbackKit <span>LIVE PIPELINE</span></div>
    <div class="signal-line"></div>
    <div class="signal-flow">
      <div class="signal-step"><span class="n">01</span><b>Capture the user's context</b><em>viewport · console · URL</em></div>
      <div class="signal-step"><span class="n">02</span><b>Ask only what is missing</b><em>structured LLM</em></div>
      <div class="signal-step"><span class="n">03</span><b>Create an agent-ready issue</b><em>GitHub · private infra</em></div>
    </div>
    <div class="signal-foot">Your gateway and storage stay in your Cloudflare account. Configured LLM and tracker providers receive the workflow data they need.</div>
  </div>
</div></div></section>

<div class="stats"><div class="wrap"><div class="grid">
  <div class="stat"><div class="v">2</div><div class="l">attributes — the whole snippet</div></div>
  <div class="stat"><div class="v">&lt; 19 kB</div><div class="l">widget bundle budget, gzipped</div></div>
  <div class="stat"><div class="v">≤ 2</div><div class="l">LLM calls per feedback</div></div>
  <div class="stat"><div class="v">0</div><div class="l">cookies &amp; trackers</div></div>
  <div class="stat"><div class="v">MIT</div><div class="l">license, self-hosted</div></div>
</div></div></div>

<section id="how"><div class="wrap">
  <div class="kicker">01 — How it works</div>
  <h2>One sentence in. A structured issue out.</h2>
  <p class="sub">No wizards, no required fields up front, no interrogation. One structured-output LLM call — and if that call fails, times out, or is over budget, the issue is created anyway. Feedback is never lost.</p>
  <div class="steps">
    <div class="step">
      <div class="n">1</div>
      <h3>The user writes freely</h3>
      <p>A single text box, an optional type picker — "everything is GONE again?!?" is a perfectly fine report.</p>
      <div class="demo mockcard">
        <div class="txt">everything is GONE again?!? i wrote a whole page…</div>
        <div class="mocktags"><span class="tagchip">🖼 screenshot</span><span class="tagchip">console · PII redacted</span><span class="tagchip">Chrome · 1440×900</span><span class="tagchip">/editor/draft-7</span></div>
      </div>
    </div>
    <div class="step">
      <div class="n">2</div>
      <h3>AI structures + asks once</h3>
      <p>One vision call takes everything — text, screenshot, redacted console, device context — and extracts your template's fields.</p>
      <div class="demo panel"><div class="body">
        <b>Almost done — 1 detail missing<span class="micro accent">AI PRE-FILLED</span></b>
        <div class="dim label">Steps · <span class="accent">from screenshot + console</span></div>
        <div class="box2">Write in /editor/draft-7 · leave · return — gone (<code class="accent">autosave 409</code>)</div>
        <div class="row-end"><span class="send2">Complete &amp; send</span></div>
      </div></div>
    </div>
    <div class="step">
      <div class="n">3</div>
      <h3>An agent-ready issue lands</h3>
      <p>A titled, labelled GitHub issue — structured enough that a coding agent can act on it directly.</p>
      <div class="demo panel"><pre><b>[BUG] Editor loses unsaved draft on navigation</b>

<span class="accent">type/bug</span>  <span class="accent">source/feedbackkit</span>

<b>## Steps</b>
1. Write in /editor/draft-7
2. Navigate away, return — content gone

<b>## Environment</b>
Chrome 149 · macOS · 1440×900 · en-US

<span class="dim" style="font-style:italic">+ screenshot attached · console: autosave 409</span></pre></div>
    </div>
  </div>
</div></section>

<section id="architecture" class="arch"><div class="wrap">
  <div class="kicker">02 — Architecture</div>
  <h2>One Worker. One deploy. Your account.</h2>
  <p class="sub">A single Cloudflare Worker serves the widget, the config, the API and the admin — backed by D1 and R2 on free tiers. <code class="accent">pnpm deploy</code> and you're live. There is no central FeedbackKit service.</p>
  <div class="flow">
    <div class="node">
      <span class="node-label">Your website — any stack</span>
      <h3>Widget</h3>
      <p>Vanilla TS in a Shadow DOM. Free text, screenshot, session context. Never fights your CSS.</p>
      <div class="out">POST /api/feedback →</div>
    </div>
    <div class="node mid">
      <span class="node-label">Self-hosted · Cloudflare</span>
      <h3>Gateway Worker</h3>
      <p>Origin allowlist · rate limit · honeypot → one structured-output LLM call, server-side Zod validation as the hard gate.</p>
      <div class="tags"><span>D1</span><span>R2</span><span>budget cap</span><span>LLM: bring your own</span></div>
    </div>
    <div class="node">
      <span class="node-label">Your repo</span>
      <h3>GitHub issue</h3>
      <p>Titled, labelled, attachments inlined. Webhook sink for anything else; GitLab, Jira &amp; Trello on the roadmap.</p>
      <div class="out">✓ issue_created</div>
    </div>
  </div>
  <div class="invariants">
    <span class="lbl">Create-anyway invariant:</span>
    <span class="pill">LLM down → issue unenriched <span class="accent">ai-failed</span></span>
    <span class="pill">D1 down → issue still created <span class="accent">d1-degraded</span></span>
    <span class="pill">GitHub down → payload persisted + retry <span class="accent">issue_failed</span></span>
  </div>
</div></section>

<section style="background:var(--soft);border-top:1px solid var(--line);border-bottom:1px solid var(--line)"><div class="wrap">
  <div class="kicker">03 — Privacy first</div>
  <h2>Feedback without surveillance.</h2>
  <p class="sub">No session replay, no keystrokes, no stable user IDs, no persisted IPs. The widget measures an anonymous, content-free funnel — and everything runs in your own account.</p>
  <div class="cards">
    <div class="card">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3l7 4v5c0 4.5-3 8-7 9-4-1-7-4.5-7-9V7z"/><path d="M9.5 12l2 2 3.5-3.5"/></svg>
      <h3>Your data stays yours</h3><p>Gateway, database and attachments live in your Cloudflare account. The LLM gets <code>data_collection: deny</code>; console errors are PII-redacted before they leave the browser.</p>
    </div>
    <div class="card">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 12h6M12 9v6"/></svg>
      <h3>Your LLM, or none</h3><p>Any OpenAI-compatible endpoint — OpenRouter by default, LiteLLM/Ollama/local models planned. Daily budget cap per project, and a kill switch that falls back to plain required-field forms.</p>
    </div>
    <div class="card">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M4 12h16M4 17h10"/></svg>
      <h3>Your feedback types</h3><p>Bug, Idea, Improvement — preconfigured, but every project defines its own types with required fields and extraction hints, written "like you'd describe it to a colleague".</p>
    </div>
  </div>
</div></section>

<section id="roadmap"><div class="wrap">
  <div class="kicker">04 — Roadmap</div>
  <h2>Built in the open, gated by evidence.</h2>
  <p class="sub">P1–P2 are committed. Later phases start only when their outcome gate is true — the completion funnel is the core KPI from day one.</p>
  <div class="roadmap">
    <div class="dot-col"><span class="dot done">P1</span><span class="stem"></span></div>
    <div class="item">
      <div class="head-row"><h3>MVP — unstructured feedback → structured issue</h3><span class="badge build">IN BUILD</span></div>
      <p>One-worker deploy, vanilla Shadow-DOM widget, vision extraction with one structured-output call, follow-up fields, create-anyway matrix, seed-JSON config. Exit: a real product runs on it in production for a week, p90 extraction &lt; 8 s.</p>
    </div>

    <div class="dot-col"><span class="dot next">P2</span><span class="stem"></span></div>
    <div class="item">
      <div class="head-row"><h3>Admin UI, annotation &amp; onboarding</h3><span class="badge committed">COMMITTED</span></div>
      <p>Full admin (field editor, funnel dashboard, theming with live preview), screenshot annotation overlay, GitHub App flow, signed webhook sink. Exit: a stranger installs it in ≤ 15 minutes.</p>
    </div>

    <div class="dot-col"><span class="dot later">P3</span><span class="stem"></span></div>
    <div class="item later">
      <div class="head-row"><h3>Widget deluxe + full GitHub</h3><span class="badge gated">GATED</span></div>
      <p>File attachments, draft persistence, full a11y, i18n en/de, GitHub Projects v2 board fields. Gate: two weeks of funnel data prove the follow-up loop works.</p>
    </div>

    <div class="dot-col"><span class="dot later">P4</span><span class="stem"></span></div>
    <div class="item later">
      <div class="head-row"><h3>Provider ecosystem</h3><span class="badge gated">GATED</span></div>
      <p>GitLab first, then Jira Cloud and Trello — the same feedback lands wherever each project chooses. Gate: an external operator asks for a second provider.</p>
    </div>

    <div class="dot-col"><span class="dot later">P5</span></div>
    <div class="item later">
      <div class="head-row"><h3>Local &amp; private LLMs</h3><span class="badge gated">GATED</span></div>
      <p>Custom endpoints in the admin — LiteLLM, Ollama, vLLM — up to a fully local recipe: self-hosted GitLab + local model, nothing leaves your network.</p>
    </div>
  </div>
</div></section>

<section id="compare" style="background:var(--soft);border-top:1px solid var(--line);border-bottom:1px solid var(--line)"><div class="wrap">
  <div class="kicker">05 — Why not …?</div>
  <h2>The moat is the combination.</h2>
  <p class="sub">"LLM formats issues" is commoditizable. Synchronous follow-up <em>before</em> the issue exists — while the user is still on the page — plus automatic session context, privacy-first self-hosting and agent-ready output is not.</p>
  ${compareTable()}
  <p class="fineprint">Honest note: if you just want screenshots → GitHub issues with zero infrastructure, <a href="https://bugdrop.dev/" target="_blank" rel="noopener">BugDrop</a> is excellent. FeedbackKit is for teams that want <b style="color:var(--ink-2)">complete</b> feedback, their own types, multi-project routing and privacy-first self-hosting.</p>
</div></section>

<section id="faq"><div class="wrap">
  <div class="kicker">06 — Questions</div>
  <h2>Frequently asked questions</h2>
  <div class="faq">
    <details><summary>Where does the feedback go?</summary><p>Straight into your GitHub repo as a structured, labelled issue — title, body sections, screenshot, device context. From P2 a signed webhook sink lets you route the same payload anywhere (n8n, Zapier, Actions).</p></details>
    <details><summary>Do I need my own AI key?</summary><p>Yes — any OpenAI-compatible endpoint, OpenRouter by default, and it stays in your Cloudflare account. Daily budget cap per project; there's even an "LLM off" kill switch that degrades to plain required-field forms.</p></details>
    <details><summary>What data does the widget collect?</summary><p>The feedback text, an optional screenshot, and technical context: browser, OS, viewport, language, page URL, recent console errors — PII-filtered client-side. Funnel events are enum-only: no content, no keystrokes, no persisted IPs. See the <a href="/datenschutz">Datenschutzerklärung</a>.</p></details>
    <details><summary>What happens when the AI fails or the budget is spent?</summary><p>Create-anyway is an architecture invariant: the issue is created unenriched and labelled <code>ai-failed</code>. Even if the database is unreachable the issue is still created. No failure may lose feedback.</p></details>
    <details><summary>Does it slow my page down or break my styles?</summary><p>No. The ~19 kB gzipped widget renders everything inside a Shadow DOM — fully isolated from your CSS, loading after your page is interactive, on any stack including React/Next.</p></details>
    <details><summary>How hard is it to run?</summary><p>One <code>pnpm deploy</code> to your Cloudflare account (Workers + D1 + R2, free tiers). Zero-touch updates: your fork stays commit-identical with upstream, so "Sync fork" is a conflict-free upgrade. <code>/diag</code> tells you what's wrong before you have to guess.</p></details>
  </div>
</div></section>

<section id="start"><div class="wrap">
  <div class="kicker">07 — Get started</div>
  <h2>Clone to first issue in ~15 minutes.</h2>
  <p class="sub">Fork the repo, run setup, deploy to your Cloudflare account. Your fork stays commit-identical with upstream — updating is one click on "Sync fork".</p>
  <div class="quickstart">
    <div class="panel">
      <div class="bar">1 · Set up</div>
      <pre><span class="accent">$</span> git clone …/feedbackkit
<span class="accent">$</span> pnpm setup</pre>
      <p class="note">Idempotent — LLM key skippable, prints your URLs.</p>
    </div>
    <div class="panel">
      <div class="bar">2 · Deploy</div>
      <pre><span class="accent">$</span> pnpm deploy
<span class="dim">✓ migrations · ✓ worker live</span></pre>
      <p class="note">Workers + D1 + R2, free tiers. <code>/diag</code> checks everything.</p>
    </div>
    <div class="panel">
      <div class="bar">3 · Paste the snippet</div>
      <pre><span class="accent">&lt;script</span> src=<span class="dim">"…/widget.js"</span>
  data-project=<span class="dim">"fk_pub_…"</span><span class="accent">&gt;&lt;/script&gt;</span></pre>
      <p class="note">Test dry-run first on <code>/t/&lt;key&gt;</code>.</p>
    </div>
  </div>
</div></section>

<section id="try"><div class="wrap">
  <div class="close-cta">
    <h2>Go on — leave us feedback.</h2>
    <p>The <b style="color:#fff">Feedback</b> button in the bottom-right corner is the real widget, wired to a live gateway. Report a "bug", ask for a feature, or tell us what you think of this page — a real issue opens on GitHub.</p>
    <div class="cta">
      <a class="btn primary lg" href="https://github.com/TruffleCraft/feedbackkit" target="_blank" rel="noopener">View on GitHub</a>
      <a class="btn lg" href="/#how">Read how it works</a>
    </div>
  </div>
</div></section>`;
  return shell({
    title: "FeedbackKit — turn messy feedback into structured issues",
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
  const bin = atob(DM_SANS_WOFF2_B64);
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
    if (pathname === "/fonts/dm-sans.woff2") return fontResponse();
    if (pathname === "/theme.js") return themeJsResponse();
    if (pathname === "/impressum") return htmlResponse(impressumPage());
    if (pathname === "/datenschutz" || pathname === "/privacy") return htmlResponse(datenschutzPage());
    return htmlResponse(homePage());
  },
};
