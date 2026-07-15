// FeedbackKit marketing / demo site — a standalone Cloudflare Worker, separate
// from the gateway. Introduces FeedbackKit, embeds the live widget (cross-origin
// from the gateway, wired to the feedbackkit-demo project), and carries the legal
// pages (Impressum + Datenschutz) required for a publicly reachable German site.
//
// Design: a clean developer-tool landing aesthetic — DM Sans (self-hosted for
// GDPR/CSP, served at /fonts/dm-sans.woff2), light monochrome palette, teal
// accent (FeedbackKit brand), code-first hero, native <details> FAQ (no JS).
//
// No inline JS anywhere → script-src stays tight (gateway origin for the widget
// bundle + self). style-src 'unsafe-inline' covers the page CSS and the widget's
// shadow styles. font-src 'self' for the self-hosted woff2.

import { DM_SANS_WOFF2_B64 } from "./font.js";

const GATEWAY = "https://feedbackkit.schieder-account.workers.dev";
const DEMO_PROJECT_KEY = "fk_pub_64a564982de5";

const CSP = [
  "default-src 'self'",
  `script-src 'self' ${GATEWAY}`,
  "style-src 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src 'self' ${GATEWAY}`,
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

const CSS = `
@font-face{font-family:"DM Sans";src:url("/fonts/dm-sans.woff2") format("woff2");font-weight:100 1000;font-style:normal;font-display:swap}
:root{
  --bg:#ffffff; --soft:#f6f7f7; --ink:#0a0a0b; --ink-2:#52525b; --muted:#8a8a90;
  --line:#e7e8ea; --line-2:#d9dbde; --accent:#0f766e; --accent-2:#0b5c55; --accent-ink:#ffffff;
  --sans:"DM Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  --wrap:1080px;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}
body{margin:0;font-family:var(--sans);color:var(--ink);background:var(--bg);line-height:1.6;font-size:16px;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
h1,h2,h3{margin:0;font-weight:700;letter-spacing:-.02em;line-height:1.1}
p{margin:0}
code,pre{font-family:var(--mono)}
.wrap{max-width:var(--wrap);margin:0 auto;padding:0 24px}

/* header */
header{position:sticky;top:0;z-index:10;background:rgba(255,255,255,.86);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.nav{display:flex;align-items:center;gap:24px;height:64px}
.brand{display:flex;align-items:center;gap:9px;font-weight:700;font-size:16.5px;letter-spacing:-.02em}
.brand .mark{width:26px;height:26px;border-radius:7px;background:var(--ink);color:#fff;display:grid;place-items:center;font-size:13px}
.nav .links{display:flex;gap:22px;margin-left:8px}
.nav .links a{color:var(--ink-2);font-size:14.5px;font-weight:500}
.nav .links a:hover{color:var(--ink)}
.nav .right{margin-left:auto;display:flex;align-items:center;gap:12px}
.btn{display:inline-flex;align-items:center;gap:8px;font-family:inherit;font-weight:600;font-size:14.5px;padding:9px 16px;border-radius:8px;border:1px solid var(--line-2);background:var(--bg);color:var(--ink);cursor:pointer;white-space:nowrap}
.btn:hover{border-color:var(--ink-2)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.btn.primary:hover{background:var(--accent-2);border-color:var(--accent-2)}
.btn.lg{padding:12px 22px;font-size:15.5px}
@media(max-width:720px){.nav .links{display:none}}

/* hero */
.hero{padding:88px 0 40px;text-align:center}
.eyebrow{display:inline-flex;align-items:center;gap:8px;font-size:12.5px;font-weight:600;letter-spacing:.02em;color:var(--accent);background:var(--soft);border:1px solid var(--line);padding:6px 13px;border-radius:999px;margin-bottom:26px}
.hero h1{font-size:clamp(36px,6vw,60px);max-width:15ch;margin:0 auto}
.hero .lede{font-size:clamp(17px,2.3vw,20px);color:var(--ink-2);max-width:56ch;margin:22px auto 0}
.hero .cta{display:flex;gap:12px;justify-content:center;margin-top:32px;flex-wrap:wrap}

/* code box */
.codebox{max-width:760px;margin:40px auto 0;text-align:left;border:1px solid var(--line);border-radius:12px;background:var(--soft);overflow:hidden}
.codebox .bar{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--line);font-family:var(--mono);font-size:12.5px;color:var(--muted)}
.codebox .bar .dot{width:11px;height:11px;border-radius:50%;background:var(--line-2)}
.codebox pre{margin:0;padding:18px;overflow-x:auto;font-size:13.5px;line-height:1.75;color:var(--ink)}
.codebox .tok-tag{color:var(--accent-2)}
.codebox .tok-attr{color:#8a5a00}
.codebox .tok-str{color:#0a5a2f}
.hero .subhint{font-size:13.5px;color:var(--muted);margin-top:18px}
.hero .subhint b{color:var(--accent)}

/* stats */
.stats{border-top:1px solid var(--line);border-bottom:1px solid var(--line);margin-top:64px}
.stats .grid{display:grid;grid-template-columns:repeat(4,1fr)}
.stat{padding:34px 20px;text-align:center;border-left:1px solid var(--line)}
.stat:first-child{border-left:0}
.stat .v{font-size:26px;font-weight:700;letter-spacing:-.02em}
.stat .l{font-size:11.5px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);margin-top:6px}
@media(max-width:720px){.stats .grid{grid-template-columns:repeat(2,1fr)}.stat:nth-child(-n+2){border-bottom:1px solid var(--line)}.stat:nth-child(odd){border-left:0}}

/* sections */
section{padding:80px 0}
.kicker{font-size:12.5px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--accent);margin-bottom:14px}
section h2{font-size:clamp(28px,4vw,40px);max-width:24ch}
section .sub{color:var(--ink-2);max-width:62ch;margin:16px 0 0;font-size:17.5px}

.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin-top:44px}
.card{border:1px solid var(--line);border-radius:14px;padding:24px;background:var(--bg)}
.card svg{width:24px;height:24px;color:var(--accent);margin-bottom:14px}
.card h3{font-size:17.5px;letter-spacing:-.01em}
.card p{color:var(--ink-2);font-size:14.5px;margin-top:8px}
.card ul{margin:14px 0 0;padding:0;list-style:none;display:grid;gap:7px}
.card li{font-size:13.5px;color:var(--ink-2);display:flex;gap:8px;align-items:flex-start}
.card li::before{content:"✓";color:var(--accent);font-weight:700}
@media(max-width:820px){.cards{grid-template-columns:1fr}}

.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin-top:44px}
.step{border:1px solid var(--line);border-radius:14px;padding:24px;background:var(--soft)}
.step .n{font-family:var(--mono);font-size:13px;font-weight:700;color:var(--accent);width:32px;height:32px;border:1px solid var(--line-2);border-radius:8px;display:grid;place-items:center;background:var(--bg);margin-bottom:16px}
.step h3{font-size:17.5px}
.step p{color:var(--ink-2);font-size:14.5px;margin-top:8px}
@media(max-width:820px){.steps{grid-template-columns:1fr}}

/* before/after */
.ba{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:44px;align-items:start}
.ba .box{border:1px solid var(--line);border-radius:14px;padding:22px;background:var(--bg)}
.ba .tag{font-size:11.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:12px}
.ba .bubble{background:var(--soft);border:1px solid var(--line);border-radius:12px;padding:15px;font-size:15px}
.ba .issue{font-family:var(--mono);font-size:12.5px;color:var(--ink-2);white-space:pre-wrap;line-height:1.75}
.ba .issue b{color:var(--ink)}
.ba .lbl{display:inline-block;background:var(--soft);border:1px solid var(--line);color:var(--accent);border-radius:6px;padding:1px 8px;font-size:10.5px;font-weight:700;margin-right:5px}
@media(max-width:720px){.ba{grid-template-columns:1fr}}

/* faq */
.faq{margin-top:40px;border-top:1px solid var(--line)}
.faq details{border-bottom:1px solid var(--line)}
.faq summary{list-style:none;cursor:pointer;padding:20px 4px;font-weight:600;font-size:16.5px;display:flex;justify-content:space-between;align-items:center;gap:16px}
.faq summary::-webkit-details-marker{display:none}
.faq summary::after{content:"+";color:var(--muted);font-weight:400;font-size:22px}
.faq details[open] summary::after{content:"–"}
.faq details p{padding:0 4px 20px;color:var(--ink-2);font-size:15.5px;max-width:70ch}

/* closing cta */
.close-cta{border:1px solid var(--line);border-radius:18px;background:var(--soft);padding:56px 32px;text-align:center}
.close-cta h2{font-size:clamp(26px,3.5vw,34px)}
.close-cta p{color:var(--ink-2);max-width:52ch;margin:14px auto 0;font-size:17px}
.close-cta .cta{display:flex;gap:12px;justify-content:center;margin-top:28px;flex-wrap:wrap}

/* footer */
footer{background:#0c1117;color:rgba(255,255,255,.7);margin-top:80px}
footer .top{padding:56px 0 40px;display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:32px}
footer .brand{color:#fff}
footer .brand .mark{background:#fff;color:#0c1117}
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

function head(title: string, description: string): string {
  return `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><meta name="description" content="${description}">
<style>${CSS}</style>`;
}

const HEADER = `<header><div class="wrap nav">
  <a class="brand" href="/"><span class="mark">◆</span> FeedbackKit</a>
  <nav class="links"><a href="/#how">How it works</a><a href="/#features">Features</a><a href="/#faq">FAQ</a></nav>
  <div class="right">
    <a href="https://github.com/TruffleCraft/feedbackkit" target="_blank" rel="noopener" style="color:var(--ink-2);font-size:14.5px;font-weight:500">GitHub ↗</a>
    <a class="btn primary" href="/#try">Try the demo</a>
  </div>
</div></header>`;

const FOOTER = `<footer><div class="wrap">
  <div class="top">
    <div>
      <div class="brand" style="display:flex;align-items:center;gap:9px;font-weight:700;font-size:16.5px"><span class="mark" style="width:26px;height:26px;border-radius:7px;display:grid;place-items:center;font-size:13px">◆</span> FeedbackKit</div>
      <p class="tag">Open feedback infrastructure you host yourself. One script tag on the front end, structured issues on the back.</p>
    </div>
    <div class="col"><h4>Product</h4>
      <a href="/#how">How it works</a><a href="/#features">Features</a><a href="/#faq">FAQ</a></div>
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
${opts.widget ? `<script src="${GATEWAY}/widget.js" data-project="${DEMO_PROJECT_KEY}"></script>` : ""}
</body></html>`;
}

function homePage(): string {
  const body = `
<div class="hero"><div class="wrap">
  <span class="eyebrow">◆ Self-hosted · open source · AI-native</span>
  <h1>The feedback widget that writes your issues for you.</h1>
  <p class="lede">Your users won't fill out a bug-report form. FeedbackKit lets them write one sentence — then an AI structures it, asks one smart follow-up, grabs a screenshot and the page context, and opens a proper GitHub issue.</p>
  <div class="cta">
    <a class="btn primary lg" href="#try">Try the live demo ↘</a>
    <a class="btn lg" href="#how">How it works</a>
  </div>
  <div class="codebox">
    <div class="bar"><span class="dot"></span> add to any page — one tag</div>
    <pre><span class="tok-tag">&lt;script</span> <span class="tok-attr">src</span>=<span class="tok-str">"https://your-gateway.workers.dev/widget.js"</span>
        <span class="tok-attr">data-project</span>=<span class="tok-str">"fk_pub_…"</span><span class="tok-tag">&gt;&lt;/script&gt;</span></pre>
  </div>
  <p class="subhint">This page runs it live — click the <b>Feedback</b> button, bottom-right ↘</p>
</div></div>

<div class="stats"><div class="wrap"><div class="grid">
  <div class="stat"><div class="v">1 tag</div><div class="l">to install</div></div>
  <div class="stat"><div class="v">~12 kB</div><div class="l">gzipped widget</div></div>
  <div class="stat"><div class="v">≤ 2</div><div class="l">LLM calls / feedback</div></div>
  <div class="stat"><div class="v">100%</div><div class="l">self-hosted</div></div>
</div></div></div>

<section id="how"><div class="wrap">
  <div class="kicker">How it works</div>
  <h2>One sentence in. A structured issue out.</h2>
  <p class="sub">No wizards, no required fields, no interrogation. Two AI calls maximum, and feedback is never lost even if the model or network fails.</p>
  <div class="steps">
    <div class="step"><div class="n">1</div><h3>The user writes freely</h3><p>A single text box: "the save button does nothing on mobile." The widget quietly captures the URL, browser, viewport, and recent console errors.</p></div>
    <div class="step"><div class="n">2</div><h3>AI structures + asks once</h3><p>An open-weights vision model extracts the fields your template needs. If something important is missing, it asks <em>one</em> natural follow-up — not a form.</p></div>
    <div class="step"><div class="n">3</div><h3>A clean issue appears</h3><p>A titled, labelled GitHub issue with steps, expected vs actual, a screenshot, and device context — the report you always wished users would write.</p></div>
  </div>
</div></section>

<section id="features" style="background:var(--soft);border-top:1px solid var(--line);border-bottom:1px solid var(--line)"><div class="wrap">
  <div class="kicker">Why teams use it</div>
  <h2>Built to disappear into your product and your workflow.</h2>
  <div class="cards">
    <div class="card">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 21h8"/></svg>
      <h3>Shadow-DOM widget</h3><p>One script tag, fully style-isolated. It never fights your CSS and your CSS never breaks it.</p>
      <ul><li>~12 kB gzipped, no framework</li><li>Light + dark, fully themeable</li><li>Keyboard + screen-reader friendly</li></ul>
    </div>
    <div class="card">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3l2.4 5.4L20 11l-5.6 2.6L12 19l-2.4-5.4L4 11l5.6-2.6z"/></svg>
      <h3>AI that reads images</h3><p>A vision model turns freeform text and the screenshot into your exact issue fields — in the user's own language.</p>
      <ul><li>One targeted follow-up, not a form</li><li>Bring your own OpenRouter/LLM key</li><li>Daily budget cap per project</li></ul>
    </div>
    <div class="card">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3a9 9 0 100 18 9 9 0 000-18z"/><path d="M9 12l2 2 4-4"/></svg>
      <h3>Never loses feedback</h3><p>If the AI is over budget or the model is down, the issue is still created with whatever the user gave. No dead ends.</p>
      <ul><li>Screenshot + console + device context</li><li>Automatic PII redaction in logs</li><li>Idempotent — no duplicate issues</li></ul>
    </div>
  </div>
</div></section>

<section><div class="wrap">
  <div class="kicker">Before &amp; after</div>
  <h2>From a shrug to a ticket a developer can act on.</h2>
  <div class="ba">
    <div class="box"><div class="tag">What the user typed</div>
      <div class="bubble">"the image in carousel story 01 looks really low quality, we should swap it for a better one"</div></div>
    <div class="box"><div class="tag">The GitHub issue FeedbackKit opened</div>
      <div class="issue"><b>[IMPROVEMENT] Replace low-quality image in carousel "Story 01"</b>

<span class="lbl">type/improvement</span><span class="lbl">source/feedbackkit</span>

<b>## Improvement</b>
Swap the low-quality image in carousel "Story 01" for a higher-resolution asset.

<b>## Environment</b>
Chrome 149 · Windows · 1920×911 · en-US

<i>+ screenshot attached</i></div></div>
  </div>
</div></section>

<section id="faq" style="background:var(--soft);border-top:1px solid var(--line);border-bottom:1px solid var(--line)"><div class="wrap">
  <div class="kicker">Questions</div>
  <h2>Frequently asked questions</h2>
  <div class="faq">
    <details><summary>Where does the feedback go?</summary><p>Straight into your GitHub repo as a structured, labelled issue — title, body sections, screenshot, and device context. Nothing to check in a separate dashboard.</p></details>
    <details><summary>Do I need my own AI key?</summary><p>Yes — you bring your own OpenRouter (or compatible) key, and it stays in your Cloudflare account. Each project has a daily budget cap, and feedback is still saved as an issue if the budget is spent.</p></details>
    <details><summary>What data does the widget collect?</summary><p>The user's feedback text, an optional page screenshot, and technical context: browser, OS, viewport, language, the page URL, and recent console errors (with secrets auto-redacted). See the <a href="/datenschutz">Datenschutzerklärung</a>.</p></details>
    <details><summary>Does it slow my page down or break my styles?</summary><p>No. It's a ~12 kB script that renders inside a Shadow DOM, so it's fully isolated from your CSS and loads after your page is interactive.</p></details>
    <details><summary>Is it really self-hosted?</summary><p>Yes. The gateway runs on your own Cloudflare Workers + D1 + R2. Your feedback data and your LLM key never leave your account.</p></details>
    <details><summary>What is this demo wired to?</summary><p>This page embeds the real widget against a demo project. Submitting opens a real, <code>demo</code>-labelled issue in the public <a href="https://github.com/TruffleCraft/feedbackkit" target="_blank" rel="noopener">TruffleCraft/feedbackkit</a> repository.</p></details>
  </div>
</div></section>

<section id="try"><div class="wrap">
  <div class="close-cta">
    <h2>Go on — leave us feedback.</h2>
    <p>The <b>Feedback</b> button in the bottom-right corner is the real widget, wired to a live gateway. Report a "bug", ask for a feature, or tell us what you think of this page — a real issue opens on GitHub.</p>
    <div class="cta">
      <a class="btn primary lg" href="https://github.com/TruffleCraft/feedbackkit" target="_blank" rel="noopener">View on GitHub</a>
      <a class="btn lg" href="/#how">Read how it works</a>
    </div>
  </div>
</div></section>`;
  return shell({ title: "FeedbackKit — turn messy feedback into structured issues", description: "A self-hosted feedback widget that turns what your users actually type into clean, structured GitHub issues — with AI, screenshots, and full context.", body, widget: true });
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
  <p>E-Mail: <a href="mailto:michel@schieder.org">michel@schieder.org</a></p>

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
  E-Mail: <a href="mailto:michel@schieder.org">michel@schieder.org</a></p>

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

export default {
  fetch(req: Request): Response {
    const { pathname } = new URL(req.url);
    if (pathname === "/fonts/dm-sans.woff2") return fontResponse();
    if (pathname === "/impressum") return htmlResponse(impressumPage());
    if (pathname === "/datenschutz" || pathname === "/privacy") return htmlResponse(datenschutzPage());
    return htmlResponse(homePage());
  },
};
