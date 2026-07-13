#!/usr/bin/env node
// ADR-004: the repo commits only wrangler.template.toml. This script renders the
// real (gitignored) wrangler.toml from build variables so a fork stays commit-
// identical with upstream and "Sync fork" is conflict-free.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED = ["CLOUDFLARE_ACCOUNT_ID", "FK_D1_ID", "FK_R2_BUCKET"];

const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error("materialize: missing required build variables:\n");
  for (const k of missing) {
    console.error(`  ${k}  — set it as a Workers Builds build variable or export it locally`);
  }
  console.error("\nRun `pnpm setup` to create the D1/R2 resources and print these values.");
  process.exit(1);
}

const template = readFileSync(join(root, "wrangler.template.toml"), "utf8");
const rendered = template.replace(/\$\{(\w+)\}/g, (_, name) => {
  const v = process.env[name];
  if (v === undefined) {
    console.error(`materialize: unresolved variable \${${name}} in template`);
    process.exit(1);
  }
  return v;
});
writeFileSync(join(root, "wrangler.toml"), rendered);
console.log("materialize: wrote wrangler.toml");
