// FeedbackKit marketing / demo site — a standalone Cloudflare Worker, separate
// from the gateway. Two jobs: introduce FeedbackKit, and be a live testing
// surface. The feedback widget is embedded from the gateway (cross-origin, the
// real integration shape), wired to the `feedbackkit-demo` project whose origin
// allowlist is THIS worker's URL — so submitting here opens a real, demo-labelled
// issue in TruffleCraft/feedbackkit.
//
// Static HTML only: the widget auto-boots from its <script data-project> attr, so
// there is no inline JS and script-src can stay tight (gateway origin + self).
// The widget injects styles into a shadow root → style-src 'unsafe-inline'. All
// widget API traffic and the widget bundle come from the gateway origin, so both
// script-src and connect-src list it explicitly.

const GATEWAY = "https://feedbackkit.schieder-account.workers.dev";
const DEMO_PROJECT_KEY = "fk_pub_64a564982de5";

const CSP = [
  "default-src 'self'",
  `script-src 'self' ${GATEWAY}`,
  "style-src 'unsafe-inline'",
  "img-src 'self' data:",
  `connect-src 'self' ${GATEWAY}`,
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

function page(): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FeedbackKit — turn messy feedback into structured issues</title>
<meta name="description" content="A self-hosted feedback widget that turns what your users actually type into clean, structured GitHub issues — with AI, screenshots, and full context.">
<style>
  :root{
    --bg:#f7f9fb; --bg-elev:#ffffff; --ink:#16202b; --ink-soft:#475569; --muted:#64748b;
    --line:#e3e9ef; --teal:#0f766e; --navy:#1b2735; --accent:#0f766e;
    --serif:Georgia,"Times New Roman",serif; --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  @media (prefers-color-scheme:dark){
    :root{
      --bg:#0f1720; --bg-elev:#1b2735; --ink:rgba(255,255,255,.94); --ink-soft:rgba(255,255,255,.72);
      --muted:rgba(255,255,255,.5); --line:rgba(255,255,255,.12); --teal:#86d9d2; --accent:#86d9d2;
    }
  }
  *{box-sizing:border-box}
  html{scroll-behavior:smooth}
  body{margin:0;font-family:var(--sans);color:var(--ink);background:var(--bg);line-height:1.6;-webkit-font-smoothing:antialiased}
  .wrap{max-width:1000px;margin:0 auto;padding:0 24px}
  h1,h2,h3{font-family:var(--serif);font-weight:500;line-height:1.15;margin:0}

  header{position:sticky;top:0;z-index:5;backdrop-filter:blur(10px);background:color-mix(in srgb,var(--bg) 82%,transparent);border-bottom:1px solid var(--line)}
  .nav{display:flex;align-items:center;justify-content:space-between;height:62px}
  .brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:16px;letter-spacing:-.01em}
  .brand .dot{width:26px;height:26px;border-radius:8px;background:linear-gradient(135deg,#0f766e,#14b8a6);display:flex;align-items:center;justify-content:center;color:#fff;font-size:14px}
  .nav a.ghost{font-size:14px;color:var(--ink-soft);text-decoration:none;padding:8px 14px;border:1px solid var(--line);border-radius:999px}
  .nav a.ghost:hover{border-color:var(--accent);color:var(--accent)}

  .hero{position:relative;overflow:hidden;padding:84px 0 72px}
  .hero::before{content:"";position:absolute;inset:0;background:radial-gradient(60% 80% at 75% 0%,color-mix(in srgb,var(--teal) 16%,transparent),transparent 70%);pointer-events:none}
  .eyebrow{display:inline-block;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);margin-bottom:16px}
  .hero h1{font-size:clamp(34px,6vw,58px);letter-spacing:-.02em;max-width:14ch}
  .hero p.lede{font-size:clamp(17px,2.4vw,21px);color:var(--ink-soft);max-width:52ch;margin:20px 0 32px}
  .cta{display:flex;gap:14px;flex-wrap:wrap;align-items:center}
  .btn{display:inline-flex;align-items:center;gap:8px;font:inherit;font-weight:600;font-size:15px;padding:12px 22px;border-radius:999px;border:0;cursor:pointer;text-decoration:none}
  .btn.primary{background:var(--accent);color:#06231f}
  .btn.primary:hover{transform:translateY(-1px)}
  .btn.link{color:var(--ink-soft);border:1px solid var(--line);background:transparent}
  .btn.link:hover{border-color:var(--accent);color:var(--accent)}
  .hint{font-size:13px;color:var(--muted);margin-top:14px}
  .hint b{color:var(--accent)}

  section{padding:64px 0;border-top:1px solid var(--line)}
  .kicker{font-size:13px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);margin-bottom:12px}
  section h2{font-size:clamp(26px,4vw,38px);letter-spacing:-.01em;max-width:22ch}
  section .sub{color:var(--ink-soft);max-width:60ch;margin:14px 0 0;font-size:17px}

  .steps{display:grid;grid-template-columns:repeat(3,1fr);gap:22px;margin-top:40px}
  .step{background:var(--bg-elev);border:1px solid var(--line);border-radius:16px;padding:24px}
  .step .n{width:34px;height:34px;border-radius:10px;background:color-mix(in srgb,var(--teal) 18%,transparent);color:var(--accent);font-weight:700;display:flex;align-items:center;justify-content:center;font-family:var(--mono);margin-bottom:14px}
  .step h3{font-size:19px;margin-bottom:8px}
  .step p{margin:0;color:var(--ink-soft);font-size:15px}

  .feats{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin-top:40px}
  .feat{padding:22px;border:1px solid var(--line);border-radius:16px;background:var(--bg-elev)}
  .feat svg{width:26px;height:26px;color:var(--accent);margin-bottom:12px}
  .feat h3{font-size:17px;margin-bottom:6px}
  .feat p{margin:0;color:var(--ink-soft);font-size:14.5px}

  .band{background:var(--navy);color:#fff;border-radius:22px;padding:44px;margin:8px 0;position:relative;overflow:hidden}
  .band::after{content:"";position:absolute;right:-40px;top:-40px;width:220px;height:220px;border-radius:50%;background:radial-gradient(closest-side,color-mix(in srgb,#86d9d2 30%,transparent),transparent)}
  .band h2{color:#fff;font-size:clamp(24px,3.5vw,34px)}
  .band p{color:rgba(255,255,255,.75);max-width:56ch;margin:14px 0 0}
  .band .arrow{margin-top:22px;display:inline-flex;align-items:center;gap:10px;font-weight:600;color:#86d9d2;font-size:15px}

  .example{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:36px;align-items:start}
  @media (max-width:760px){.example{grid-template-columns:1fr}}
  .card{background:var(--bg-elev);border:1px solid var(--line);border-radius:16px;padding:20px}
  .card .tag{font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:12px}
  .bubble{background:color-mix(in srgb,var(--teal) 10%,transparent);border:1px solid color-mix(in srgb,var(--teal) 30%,transparent);border-radius:12px;padding:14px;font-size:15px;color:var(--ink)}
  .issue{font-family:var(--mono);font-size:13px;color:var(--ink-soft);white-space:pre-wrap;line-height:1.7}
  .issue b{color:var(--ink)}
  .issue .lbl{display:inline-block;background:color-mix(in srgb,var(--teal) 18%,transparent);color:var(--accent);border-radius:6px;padding:1px 8px;font-size:11px;font-weight:700;margin-right:6px}

  footer{border-top:1px solid var(--line);padding:40px 0 64px;color:var(--muted);font-size:14px}
  footer .stack{display:flex;gap:18px;flex-wrap:wrap;margin-top:12px}
  footer code{font-family:var(--mono);font-size:12.5px;background:color-mix(in srgb,var(--ink) 8%,transparent);padding:2px 7px;border-radius:6px;color:var(--ink-soft)}

  @media (max-width:760px){.steps,.feats{grid-template-columns:1fr}}
</style>
</head>
<body>
<header><div class="wrap nav">
  <div class="brand"><span class="dot">◆</span> FeedbackKit</div>
  <a class="ghost" href="https://github.com/TruffleCraft/feedbackkit" target="_blank" rel="noopener">GitHub ↗</a>
</div></header>

<div class="hero"><div class="wrap">
  <span class="eyebrow">Self-hosted feedback → GitHub issues</span>
  <h1>Turn what users actually type into clean, structured issues.</h1>
  <p class="lede">Your users won't fill out a bug-report form. FeedbackKit lets them write one sentence — then an AI structures it, asks one smart follow-up, grabs a screenshot and the page context, and opens a proper GitHub issue.</p>
  <div class="cta">
    <a class="btn primary" href="#try">Try it — leave feedback ↘</a>
    <a class="btn link" href="#how">See how it works</a>
  </div>
  <p class="hint">This page is running FeedbackKit live. Click the <b>Feedback</b> button in the bottom-right corner and submit something — it opens a real issue in <code>TruffleCraft/feedbackkit</code> (labelled <b>demo</b>).</p>
</div></div>

<section id="how"><div class="wrap">
  <div class="kicker">How it works</div>
  <h2>One sentence in. A structured issue out.</h2>
  <p class="sub">No wizards, no required fields, no interrogation. Two AI calls, hard-capped, and feedback is never lost even if the model or network fails.</p>
  <div class="steps">
    <div class="step"><div class="n">1</div><h3>The user writes freely</h3><p>A single text box: "the save button does nothing on mobile." That's it. The widget quietly captures the URL, browser, viewport, and recent console errors.</p></div>
    <div class="step"><div class="n">2</div><h3>AI structures + asks once</h3><p>An open-weights vision model extracts the fields your template needs. If something important is missing, it asks <em>one</em> natural follow-up — not a form.</p></div>
    <div class="step"><div class="n">3</div><h3>A clean issue appears</h3><p>A titled, labelled GitHub issue with steps, expected vs actual, a screenshot, and device context — the report you always wished users would write.</p></div>
  </div>
</div></section>

<section><div class="wrap">
  <div class="kicker">Why teams use it</div>
  <h2>Built to disappear into your product and your workflow.</h2>
  <div class="feats">
    <div class="feat">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 5h16v11H4zM2 19h20"/></svg>
      <h3>Shadow-DOM widget</h3><p>One script tag. Fully style-isolated, so it never fights your CSS and your CSS never breaks it. ~12 kB gzipped.</p>
    </div>
    <div class="feat">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3l2.5 5.5L20 11l-5.5 2.5L12 19l-2.5-5.5L4 11l5.5-2.5z"/></svg>
      <h3>AI that reads images</h3><p>A vision-capable model turns freeform text (and the screenshot) into your exact issue fields — in the user's own language.</p>
    </div>
    <div class="feat">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 21h8M12 18v3"/></svg>
      <h3>Screenshot + context</h3><p>An automatic page screenshot plus URL, browser, viewport, and the last console errors — attached to every issue.</p>
    </div>
    <div class="feat">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3a9 9 0 100 18 9 9 0 000-18zM9 12l2 2 4-4"/></svg>
      <h3>Never loses feedback</h3><p>If the AI is over budget or the model is down, the issue is still created with whatever the user gave. No dead ends.</p>
    </div>
    <div class="feat">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7l8-4 8 4-8 4zM4 12l8 4 8-4M4 17l8 4 8-4"/></svg>
      <h3>Self-hosted on Cloudflare</h3><p>Runs on your own Workers + D1 + R2. Your feedback data and your LLM key never leave your account.</p>
    </div>
    <div class="feat">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v18M5 8l7-5 7 5M5 16l7 5 7-5"/></svg>
      <h3>Themeable</h3><p>Every color, radius, and font is a CSS variable. Match your brand in light and dark — or keep the polished default.</p>
    </div>
  </div>
</div></section>

<section><div class="wrap">
  <div class="kicker">Before &amp; after</div>
  <h2>From a shrug to a ticket a developer can act on.</h2>
  <div class="example">
    <div class="card">
      <div class="tag">What the user typed</div>
      <div class="bubble">"the image in carousel story 01 looks really low quality, we should swap it for a better one"</div>
    </div>
    <div class="card">
      <div class="tag">The GitHub issue FeedbackKit opened</div>
      <div class="issue"><b>[IMPROVEMENT] Replace low-quality image in carousel "Story 01"</b>

<span class="lbl">type/improvement</span><span class="lbl">source/feedbackkit</span>

<b>## Improvement</b>
Swap the low-quality image in carousel "Story 01" for a higher-resolution asset.

<b>## Environment</b>
Chrome 149 · Windows · 1920×911 · en-US
<b>URL:</b> https://your-app.example/

<i>+ screenshot attached</i></div>
    </div>
  </div>
</div></section>

<section id="try"><div class="wrap">
  <div class="band">
    <h2>Go on — leave us feedback.</h2>
    <p>This is not a mockup. The <b>Feedback</b> button in the corner is the real widget, wired to a live gateway. Tell us what you think of this page, report a "bug", or ask for a feature — you'll get a follow-up question, and a real issue will open on GitHub.</p>
    <span class="arrow">Bottom-right corner ↘</span>
  </div>
</div></section>

<footer><div class="wrap">
  <div class="brand"><span class="dot">◆</span> FeedbackKit</div>
  <p style="margin:14px 0 0;max-width:60ch">Open feedback infrastructure you host yourself. One script tag on the front end, structured issues on the back.</p>
  <div class="stack">
    <code>Cloudflare Workers</code><code>D1</code><code>R2</code><code>Hono</code><code>Shadow DOM</code><code>OpenRouter · Gemma</code>
  </div>
</div></footer>

<script src="${GATEWAY}/widget.js" data-project="${DEMO_PROJECT_KEY}"></script>
</body></html>`;
}

export default {
  fetch(): Response {
    return new Response(page(), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": CSP,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "Cache-Control": "public, max-age=300",
      },
    });
  },
};
