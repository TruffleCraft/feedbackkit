// First-run landing page (P2): GET / is the first URL an operator sees after a
// deploy (the Deploy-to-Cloudflare flow ends on it), so instead of a bare
// version string it renders a setup checklist from cheap signals — env presence
// booleans and one COUNT. Nothing user-controlled reaches the markup, so no
// escaping is needed. Served under a strict CSP (inline styles only, no scripts).
import type { SchemaState } from "./db.js";

export const LANDING_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

export interface LandingState {
  version: string;
  schema: SchemaState;
  secrets: { adminToken: boolean; githubPat: boolean; llmKey: boolean };
  projects: number | null;
}

interface Item {
  ok: boolean;
  label: string;
  fix?: string; // copy-pasteable command shown when not ok
  optional?: boolean;
}

export function renderLanding(s: LandingState): string {
  const projects = s.projects ?? 0;
  const items: Item[] = [
    {
      ok: s.schema.ok,
      label: s.schema.ok ? "Database schema is up to date" : `Database schema: ${s.schema.ok === false ? s.schema.reason : ""}`,
    },
    {
      ok: s.secrets.adminToken,
      label: "ADMIN_TOKEN secret",
      fix: "npx wrangler secret put ADMIN_TOKEN   # generate one: openssl rand -hex 32",
    },
    {
      ok: s.secrets.githubPat,
      label: "GitHub PAT secret (issues are created with it)",
      fix: "npx wrangler secret put GITHUB_PAT_default",
    },
    {
      ok: projects > 0,
      label: projects > 0 ? `${projects} project${projects === 1 ? "" : "s"} configured` : "No project configured yet",
      fix: 'curl -X POST "https://<this-worker>/api/admin/config/import" -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" --data @config.json',
    },
    {
      ok: s.secrets.llmKey,
      label: s.secrets.llmKey ? "LLM_API_KEY set — AI follow-up enabled" : "LLM_API_KEY not set — runs in required-field mode (optional)",
      optional: true,
    },
  ];

  const ready = items.filter((i) => !i.optional).every((i) => i.ok);
  const rows = items
    .map((i) => {
      const mark = i.ok ? `<span class="ok">✓</span>` : i.optional ? `<span class="opt">○</span>` : `<span class="miss">✗</span>`;
      const fix = !i.ok && i.fix ? `<pre>${i.fix}</pre>` : "";
      return `<li>${mark} ${i.label}${fix}</li>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FeedbackKit</title>
<style>
  body { font: 16px/1.55 system-ui, sans-serif; max-width: 44rem; margin: 3rem auto; padding: 0 1.25rem; color: #1a1a1a; background: #fafafa; }
  h1 { font-size: 1.4rem; } h1 small { font-weight: normal; color: #777; font-size: .8em; }
  ul { list-style: none; padding: 0; } li { margin: .6rem 0; }
  .ok { color: #1a7f37; } .miss { color: #cf222e; } .opt { color: #999; }
  pre { background: #f0f0f0; border-radius: 6px; padding: .5rem .75rem; overflow-x: auto; font-size: .82em; margin: .35rem 0 0 1.4rem; }
  .banner { border-radius: 8px; padding: .75rem 1rem; margin: 1.25rem 0; }
  .banner.ready { background: #e6f4ea; } .banner.setup { background: #fff4e5; }
  a { color: #0757ba; } footer { margin-top: 2.5rem; color: #999; font-size: .85em; }
</style>
</head>
<body>
<h1>FeedbackKit <small>v${s.version}</small></h1>
${
  ready
    ? `<div class="banner ready"><strong>Ready.</strong> Embed the widget with the snippet returned by the config import, and verify on your test page at <code>/t/&lt;public-key&gt;</code>.</div>`
    : `<div class="banner setup"><strong>Almost there.</strong> This install needs a few setup steps — work through the list below, top to bottom.</div>`
}
<ul>
${rows}
</ul>
<p>Machine-readable status: <a href="/diag">/diag</a> · Setup guide: <code>docs/QUICKSTART.md</code> in your repository.</p>
<footer>FeedbackKit — self-hosted feedback gateway.</footer>
</body>
</html>
`;
}
