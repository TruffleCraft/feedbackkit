#!/usr/bin/env node
// Bundle-budget gate (P1.12): the widget ships on every operator page, so keep
// it small. Fails CI if the gzipped bundle exceeds the budget.
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Whole all-in-one bundle incl. html-to-image. Deliberate bump 15 → 17 kB for
// #54: the screenshot annotator (crop + rect/arrow/text/pen + undo) costs
// ~3.4 kB gz — the headline P2 UX is worth it. Do not creep past this silently.
const BUDGET_GZ = 17 * 1024;

let buf;
try {
  buf = readFileSync(join(root, "dist", "widget.js"));
} catch {
  console.error("check-bundle: dist/widget.js missing — run `pnpm build:widget` first");
  process.exit(1);
}
const gz = gzipSync(buf).length;
const kb = (n) => (n / 1024).toFixed(1);
console.log(`widget bundle: ${kb(buf.length)} kB min · ${kb(gz)} kB gz (budget ${kb(BUDGET_GZ)} kB gz)`);
if (gz > BUDGET_GZ) {
  console.error(`check-bundle: OVER BUDGET by ${kb(gz - BUDGET_GZ)} kB gz`);
  process.exit(1);
}
