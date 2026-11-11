// Tiny static server for E2E: serves the demo host page, the built widget
// bundle and the admin shells. API calls are intercepted per-test via
// Playwright page.route(), so no gateway logic lives here.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 8788);

// Admin shells: the real renderer and headers from src/worker/admin/pages.ts
// (transpiled on start), so the specs run admin.js under the production CSP.
// /api/admin/* is mocked per test with page.route.
const { build } = await import("esbuild");
async function load(...file) {
  const bundled = await build({
    entryPoints: [join(root, "src", "worker", ...file)],
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    logLevel: "silent",
  });
  return import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
}
const pages = await load("admin", "pages.ts");
// OAuth consent: the real page headers and the real same-origin check of the
// POST handler, so a real browser shows which Origin its form post carries.
const consent = await load("oauth", "consent-headers.ts");
const { isSameOriginRequest } = await load("admin", "auth.ts");

function consentForm(res, action, headers) {
  res.writeHead(200, headers);
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Connect</title></head><body>
<form method="post" action="${action}"><input type="hidden" name="handle" value="h-123">
<button type="submit" name="decision" value="allow">Allow</button></form></body></html>`);
}

const ROUTES = {
  "/admin.js": { file: join(root, "dist", "admin.js"), type: "application/javascript; charset=utf-8" },
  "/auth.js": { file: join(root, "dist", "auth.js"), type: "application/javascript; charset=utf-8" },
  "/widget.js": { file: join(root, "dist", "widget.js"), type: "application/javascript; charset=utf-8" },
  "/urbanist.woff2": { file: join(root, "dist", "urbanist.woff2"), type: "font/woff2" },
  "/": { file: join(root, "e2e", "demo.html"), type: "text/html; charset=utf-8" },
  "/demo.html": { file: join(root, "e2e", "demo.html"), type: "text/html; charset=utf-8" },
};

createServer((req, res) => {
  const path = (req.url || "/").split("?")[0];
  if (path === "/api/config") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      v: 1,
      enabled: true,
      locale: "en",
      configVersion: 1,
      types: [
        { type: "bug", label: "Bug", guidance: "What happened, what did you expect, and how can we reproduce it?", fields: [] },
        { type: "feature", label: "Feature request", fields: [] },
        { type: "improvement", label: "Improvement", fields: [] },
      ],
    }));
    return;
  }
  if (path === "/api/events") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (path === "/api/upload") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ v: 1, key: "fk_test/shot.webp" }));
    return;
  }
  if (path === "/api/feedback") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ v: 1, status: "created", id: "local-preview" }));
    return;
  }
  if (path === "/oauth/authorize" && req.method === "GET") {
    // As the worker serves it, with a client redirect origin in form-action.
    consentForm(res, "/oauth/authorize", consent.consentHeaders(randomUUID().replace(/-/g, ""), "https://client.example"));
    return;
  }
  if (path === "/oauth/authorize" && req.method === "POST") {
    // Same decision as the worker's POST handler makes before anything else.
    const probe = new Request(`http://${req.headers.host}${req.url}`, {
      method: "POST",
      headers: Object.fromEntries(["origin", "sec-fetch-site"].filter((h) => req.headers[h]).map((h) => [h, req.headers[h]])),
    });
    const allowed = isSameOriginRequest(probe);
    req.resume();
    res.writeHead(allowed ? 200 : 403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`${allowed ? "Allowed" : "Request blocked"}\nOrigin: ${req.headers.origin ?? "(none)"}\nSec-Fetch-Site: ${req.headers["sec-fetch-site"] ?? "(none)"}`);
    return;
  }
  // A form on another origin that posts to the consent endpoint (cross-site CSRF).
  if (path === "/e2e/foreign-consent-form") {
    consentForm(res, `http://localhost:${PORT}/oauth/authorize`, { "Content-Type": "text/html; charset=utf-8" });
    return;
  }
  const view = pages.adminViewFor(path);
  if (view) {
    const nonce = randomUUID().replace(/-/g, "");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...pages.adminHeaders(nonce) });
    res.end(pages.renderAdminPage(view, nonce));
    return;
  }
  const r = ROUTES[path];
  if (!r) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  try {
    res.writeHead(200, { "Content-Type": r.type, ...(path === "/urbanist.woff2" ? { "Access-Control-Allow-Origin": "*" } : {}) });
    res.end(readFileSync(r.file));
  } catch (e) {
    res.writeHead(500);
    res.end(`error: ${e.message} (did you run build:widget?)`);
  }
}).listen(PORT, () => console.log(`e2e static server on http://localhost:${PORT}`));
