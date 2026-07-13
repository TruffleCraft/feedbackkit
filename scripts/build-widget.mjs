#!/usr/bin/env node
// Builds the Shadow-DOM widget bundle into ./dist. Until the widget source lands
// (P1.10) this emits a placeholder so `wrangler deploy` has an assets dir.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });

const entry = join(root, "src", "widget", "index.ts");
if (existsSync(entry)) {
  const { build } = await import("esbuild");
  await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    minify: true,
    target: "es2022",
    outfile: join(dist, "widget.js"),
  });
  console.log("build:widget: bundled src/widget → dist/widget.js");
} else {
  writeFileSync(join(dist, "widget.js"), "// FeedbackKit widget placeholder (P1.10 not built yet)\n");
  console.log("build:widget: no widget source yet — wrote placeholder dist/widget.js");
}
