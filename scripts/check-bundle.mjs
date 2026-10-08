#!/usr/bin/env node
// Bundle-budget gate (P1.12): the widget ships on every operator page, so keep
// it small. Fails CI if the gzipped bundle exceeds the budget.
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Whole all-in-one bundle incl. html-to-image. The 22 kB ceiling includes the
// screenshot editor, bounded text layout, multi-attachment UI, the capture
// policy, host context, open() API, the Turnstile loader, the conversation
// UI (thread, "what gets sent" disclosure, done card), the full-screen
// phone sheet (visual-viewport sizing, iOS scroll pin), screenshot thumbnails
// and the host theming tokens. CI's gzip lands a few bytes above local builds.
const BUDGET_GZ = 23 * 1024;

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

// The admin module (P2, ADR-014) only loads on /admin, but stays a small
// vanilla module: a framework would blow this budget first.
const ADMIN_BUDGET_GZ = 15 * 1024;
let admin;
try {
  admin = readFileSync(join(root, "dist", "admin.js"));
} catch {
  console.error("check-bundle: dist/admin.js missing — run `pnpm build:widget` first");
  process.exit(1);
}
const adminGz = gzipSync(admin).length;
console.log(`admin bundle: ${kb(admin.length)} kB min · ${kb(adminGz)} kB gz (budget ${kb(ADMIN_BUDGET_GZ)} kB gz)`);
if (adminGz > ADMIN_BUDGET_GZ) {
  console.error(`check-bundle: admin OVER BUDGET by ${kb(adminGz - ADMIN_BUDGET_GZ)} kB gz`);
  process.exit(1);
}
