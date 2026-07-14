#!/usr/bin/env node
// pnpm seed <config.json> [--remote] [--dry]
// Upsert a project into D1 from a JSON config (the P1 way to create a project;
// the admin UI replaces this in P2 — same schema, so no rework). Re-seeding the
// same projectId updates its config and bumps config_version (widgets refetch).
// The worker's Zod validation is the hard gate on load; this does light checks.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const remote = args.includes("--remote");
const dry = args.includes("--dry");
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("usage: pnpm seed <config.json> [--remote] [--dry]");
  process.exit(1);
}

let cfg;
try {
  cfg = JSON.parse(readFileSync(file, "utf8"));
} catch (e) {
  console.error(`seed: cannot read/parse ${file}: ${e.message}`);
  process.exit(1);
}

const problems = [];
if (!cfg.projectId) problems.push("projectId is required");
if (!Array.isArray(cfg.templates) || cfg.templates.length === 0) problems.push("templates must be a non-empty array");
if (!cfg.tracker?.defaultRepo) problems.push("tracker.defaultRepo is required");
if (!cfg.tracker?.patSecret) problems.push("tracker.patSecret is required (the name of the GITHUB_PAT_<name> secret)");
if (problems.length) {
  console.error("seed: invalid config:\n  - " + problems.join("\n  - "));
  process.exit(1);
}

const publicKey = cfg.publicKey || `fk_pub_${randomBytes(6).toString("hex")}`;
delete cfg.publicKey; // stored in its own column, not in the config blob
const id = String(cfg.projectId);
const now = Date.now();
const esc = (s) => s.replace(/'/g, "''");
const sql = `INSERT INTO projects (id, public_key, config, config_version, updated_at)
VALUES ('${esc(id)}', '${esc(publicKey)}', '${esc(JSON.stringify(cfg))}', 1, ${now})
ON CONFLICT(id) DO UPDATE SET config = excluded.config, config_version = projects.config_version + 1, updated_at = excluded.updated_at;`;

if (dry) {
  console.log(sql);
  process.exit(0);
}

const sqlFile = join(tmpdir(), `fk-seed-${now}.sql`);
writeFileSync(sqlFile, sql);
try {
  execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "feedbackkit", remote ? "--remote" : "--local", "--file", sqlFile], { stdio: "inherit" });
} catch {
  console.error("seed: `wrangler d1 execute` failed — is wrangler.toml materialized (pnpm materialize) and the DB created?");
  process.exit(1);
}

console.log(`\n✓ seeded project "${id}" (${remote ? "remote" : "local"})`);
console.log(`  public key : ${publicKey}`);
console.log(`  snippet    : <script src="https://<your-worker>/widget.js" data-project="${publicKey}"></script>`);
console.log(`  test page  : https://<your-worker>/t/${publicKey}`);
