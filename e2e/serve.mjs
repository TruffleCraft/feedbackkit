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
const bundled = await build({
  entryPoints: [join(root, "src", "worker", "admin", "pages.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: false,
  logLevel: "silent",
});
const pages = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);

const ROUTES = {
  "/admin.js": { file: join(root, "dist", "admin.js"), type: "application/javascript; charset=utf-8" },
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
