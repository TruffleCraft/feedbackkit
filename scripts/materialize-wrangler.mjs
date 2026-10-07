#!/usr/bin/env node
// ADR-004: the repo commits only wrangler.template.toml. This script renders the
// real (gitignored) wrangler.toml from build variables so a fork stays commit-
// identical with upstream and "Sync fork" is conflict-free.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

const verFile = join(root, "dist", "widget.ver");
const widgetVersion = existsSync(verFile)
  ? readFileSync(verFile, "utf8").trim()
  : "unversioned";

// Optional: serve the gateway on a custom domain (zone in the same account),
// e.g. FK_CUSTOM_DOMAIN=feedback.example.com. A stable hostname keeps snippets
// and host CSPs valid even if the workers.dev subdomain is renamed.
const customDomain = process.env.FK_CUSTOM_DOMAIN?.trim();
if (customDomain && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(customDomain)) {
  console.error(`materialize: FK_CUSTOM_DOMAIN must be a bare hostname, got "${customDomain}"`);
  process.exit(1);
}
const routes = customDomain ? `routes = [{ pattern = "${customDomain}", custom_domain = true }]` : "";

const template = readFileSync(join(root, "wrangler.template.toml"), "utf8");
const rendered = template.replace(/\$\{(\w+)\}/g, (_, name) => {
  if (name === "WIDGET_VERSION") return widgetVersion;
  if (name === "FK_ROUTES") return routes;
  const v = process.env[name];
  if (v === undefined) {
    console.error(`materialize: unresolved variable \${${name}} in template`);
    process.exit(1);
  }
  return v;
});
writeFileSync(join(root, "wrangler.toml"), rendered);
console.log(`materialize: wrote wrangler.toml (widget v=${widgetVersion})`);
