#!/usr/bin/env node
// Builds the Shadow-DOM widget bundle into ./dist. Until the widget source lands
// (P1.10) this emits a placeholder so `wrangler deploy` has an assets dir.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });

const entry = join(root, "src", "widget", "index.ts");
if (existsSync(entry)) {
  const { build } = await import("esbuild");
  // IIFE so a plain <script src="…/widget.js" data-project="…"> works without
  // type="module". Single self-contained bundle (screenshot lib inlined).
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    minify: true,
    target: "es2022",
    outfile: join(dist, "widget.js"),
    metafile: true,
    legalComments: "none",
  });
  const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
  const buf = readFileSync(join(dist, "widget.js"));
  const hash = createHash("sha256").update(buf).digest("hex").slice(0, 12);
  writeFileSync(join(dist, "widget.ver"), hash);
  writeFileSync(join(root, "site", "src", "widget-ver.ts"), `export const WIDGET_VER = "${hash}";\n`);
  console.log(`build:widget: bundled src/widget → dist/widget.js (${(bytes / 1024).toFixed(1)} kB min, v=${hash})`);
} else {
  writeFileSync(join(dist, "widget.js"), "// FeedbackKit widget placeholder (P1.10 not built yet)\n");
  writeFileSync(join(dist, "widget.ver"), "placeholder");
  writeFileSync(join(root, "site", "src", "widget-ver.ts"), `export const WIDGET_VER = "dev";\n`);
  console.log("build:widget: no widget source yet — wrote placeholder dist/widget.js");
}
