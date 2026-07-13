// Tiny static server for E2E: serves the demo host page and the built widget
// bundle. API calls are intercepted per-test via Playwright page.route(), so no
// gateway logic lives here.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 8788);

const ROUTES = {
  "/widget.js": { file: join(root, "dist", "widget.js"), type: "application/javascript; charset=utf-8" },
  "/": { file: join(root, "e2e", "demo.html"), type: "text/html; charset=utf-8" },
  "/demo.html": { file: join(root, "e2e", "demo.html"), type: "text/html; charset=utf-8" },
};

createServer((req, res) => {
  const path = (req.url || "/").split("?")[0];
  const r = ROUTES[path];
  if (!r) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  try {
    res.writeHead(200, { "Content-Type": r.type });
    res.end(readFileSync(r.file));
  } catch (e) {
    res.writeHead(500);
    res.end(`error: ${e.message} (did you run build:widget?)`);
  }
}).listen(PORT, () => console.log(`e2e static server on http://localhost:${PORT}`));
