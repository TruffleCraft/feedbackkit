// Worker-served test page at /t/<key>. Dry-run by default: the operator can see
// the issue their project WOULD produce without touching their own site, without
// creating a real issue, and without an LLM call. Served under a strict CSP
// (default-src 'self' + per-request nonce). The project key is embedded as
// escaped JSON and every dynamic value is written via textContent (never
// innerHTML) — the key is attacker-controllable (public, in the snippet).

function safeJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c");
}

export const TEST_PAGE_CSP = (nonce: string) => `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' data:; base-uri 'none'`;

export function renderTestPage(key: string, nonce: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FeedbackKit test — ${""}</title>
<style nonce="${nonce}">
  body{font:15px/1.5 system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;color:#1f2937}
  @media(prefers-color-scheme:dark){body{background:#111827;color:#e5e7eb}}
  h1{font-size:1.3rem} label{display:block;font-weight:600;margin:1rem 0 .25rem}
  select,textarea{width:100%;font:inherit;padding:.5rem;border:1px solid #9ca3af;border-radius:6px;background:transparent;color:inherit}
  textarea{min-height:100px} button{margin-top:1rem;font:inherit;font-weight:600;padding:.6rem 1.2rem;border:0;border-radius:6px;background:#4f46e5;color:#fff;cursor:pointer}
  .status{padding:.5rem .75rem;border-radius:6px;margin:.5rem 0;font-size:.9rem}
  .ok{background:#dcfce7;color:#166534} .err{background:#fee2e2;color:#991b1b}
  @media(prefers-color-scheme:dark){.ok{background:#14532d;color:#dcfce7}.err{background:#7f1d1d;color:#fee2e2}}
  pre{background:#0000000d;padding:1rem;border-radius:6px;overflow:auto;white-space:pre-wrap}
  @media(prefers-color-scheme:dark){pre{background:#ffffff14}}
  .muted{color:#6b7280;font-size:.85rem}
</style>
<script type="application/json" id="fk-data">${safeJson({ project: key })}</script>
</head><body>
<h1>FeedbackKit test page</h1>
<p class="muted">Project <code id="fk-project"></code> · dry-run (no issue is created, no AI call, no data stored)</p>
<div class="status" id="fk-status">Loading config…</div>
<div id="fk-form" hidden>
  <label for="fk-type">Feedback type</label>
  <select id="fk-type"></select>
  <label for="fk-msg">Message</label>
  <textarea id="fk-msg" placeholder="Type feedback the way a user would…"></textarea>
  <button id="fk-preview" type="button">Preview the issue (dry-run)</button>
</div>
<div id="fk-out" hidden>
  <label>Issue title</label><pre id="fk-title"></pre>
  <label>Issue body</label><pre id="fk-body"></pre>
</div>
<script nonce="${nonce}">
(function(){
  var data = JSON.parse(document.getElementById("fk-data").textContent);
  var project = data.project;
  var $ = function(id){ return document.getElementById(id); };
  $("fk-project").textContent = project;
  var status = $("fk-status");
  function setStatus(msg, ok){ status.textContent = msg; status.className = "status " + (ok ? "ok" : "err"); }

  fetch("/api/config?project=" + encodeURIComponent(project)).then(function(r){
    if(r.status === 404) throw new Error("Project not found — check the key in your snippet.");
    if(!r.ok) throw new Error("Config error (HTTP " + r.status + ") — see /diag?project=" + encodeURIComponent(project));
    return r.json();
  }).then(function(cfg){
    if(!cfg.enabled){ setStatus("This project is disabled.", false); return; }
    var sel = $("fk-type");
    (cfg.types || []).forEach(function(t){
      var o = document.createElement("option");
      o.value = t.type;
      o.textContent = (typeof t.label === "string" ? t.label : (t.label[cfg.locale] || t.type));
      sel.appendChild(o);
    });
    setStatus("✓ Config loaded — " + (cfg.types||[]).length + " feedback type(s).", true);
    $("fk-form").hidden = false;
  }).catch(function(e){ setStatus(e.message, false); });

  $("fk-preview").addEventListener("click", function(){
    var payload = { type: $("fk-type").value, message: $("fk-msg").value };
    fetch("/api/test-preview?project=" + encodeURIComponent(project), {
      method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(payload)
    }).then(function(r){ return r.json().then(function(j){ return { ok:r.ok, j:j }; }); })
      .then(function(res){
        if(!res.ok){ setStatus(res.j.error || "Preview failed.", false); return; }
        $("fk-title").textContent = res.j.title;
        $("fk-body").textContent = res.j.body;
        $("fk-out").hidden = false;
        setStatus("✓ Dry-run preview — this issue would be created (nothing was sent).", true);
      }).catch(function(e){ setStatus(e.message, false); });
  });
})();
</script>
</body></html>`;
}
