#!/usr/bin/env node
// pnpm admin:link: the one-time link for the first owner, or a recovery link, on
// the Cloudflare runtime (S14). Run it on your own machine with your own
// Cloudflare credentials (`wrangler login`, or CLOUDFLARE_API_TOKEN in your
// shell). It writes one row into your D1 database through wrangler and prints
// the link. Nothing is sent anywhere else, and it never asks for a credential.
//
//   pnpm admin:link --url https://feedbackkit.example.org            first owner
//   pnpm admin:link --url https://… --recovery                       recovery link for the only owner
//   pnpm admin:link --url https://… --recovery --account "Robin"     recovery link for one account
//   pnpm admin:link --url https://… --print-sql                      print the SQL instead of running it
//
// Options: --minutes N (1 to 240, default 30), --database NAME (default
// feedbackkit), --local (the local D1 of `wrangler dev`).
//
// The link goes to stdout and nothing else does. The token is generated here and
// only its SHA-256 reaches the database, as on the standalone server. With
// --print-sql you paste the SQL into the D1 console of the Cloudflare dashboard
// yourself, which needs no tooling at all.
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const USAGE = `Usage: pnpm admin:link --url <public url> [--recovery [--account NAME]] [--minutes N] [--database NAME] [--local] [--print-sql]`;
const sql = (text) => `'${String(text).replaceAll("'", "''")}'`;

export function parseArgs(argv) {
  const out = { minutes: 30, database: "feedbackkit" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") out.url = argv[++i];
    else if (a === "--recovery") out.recovery = true;
    else if (a === "--account") out.account = argv[++i];
    else if (a === "--minutes") out.minutes = Number(argv[++i]);
    else if (a === "--database") out.database = argv[++i];
    else if (a === "--local") out.local = true;
    else if (a === "--print-sql") out.printSql = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else throw new Error(`Unknown option ${a}.\n${USAGE}`);
  }
  return out;
}

/** The statements that store a link, and the link itself. `now` and `token` are parameters so that tests can pin them. */
export function buildLink(opts, now = Date.now(), token = `fk_link_${randomBytes(32).toString("base64url")}`) {
  if (!Number.isInteger(opts.minutes) || opts.minutes < 1 || opts.minutes > 240) throw new Error("--minutes must be a whole number from 1 to 240.");
  let origin;
  try {
    origin = new URL(opts.url ?? process.env.FK_PUBLIC_URL ?? "");
    if (!["http:", "https:"].includes(origin.protocol) || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) throw new Error("bad");
  } catch { throw new Error(`--url must be the public address of the gateway, for example https://feedbackkit.example.org (an http(s) origin without path).\n${USAGE}`); }
  if (opts.account !== undefined && !opts.recovery) throw new Error("--account only goes with --recovery.");
  const id = createHash("sha256").update(token).digest("hex");
  const expires = now + opts.minutes * 60_000;
  const base = `${sql(id)}`;
  let statements;
  if (!opts.recovery) {
    statements = [
      "DELETE FROM setup_links WHERE purpose = 'bootstrap' AND used_at IS NULL AND NOT EXISTS (SELECT 1 FROM owner_claim)",
      `INSERT INTO setup_links (id, purpose, account_id, created_at, expires_at, created_by) SELECT ${base}, 'bootstrap', NULL, ${now}, ${expires}, 'cloudflare' WHERE NOT EXISTS (SELECT 1 FROM owner_claim)`,
    ];
  } else {
    const who = opts.account !== undefined
      ? `a.name_key = ${sql(String(opts.account).normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase())}`
      : "a.role = 'owner' AND (SELECT COUNT(*) FROM accounts o WHERE o.role = 'owner' AND o.state = 'active') = 1";
    statements = [
      `DELETE FROM setup_links WHERE purpose IN ('recovery', 'invite') AND used_at IS NULL AND account_id IN (SELECT a.id FROM accounts a WHERE a.state = 'active' AND ${who})`,
      `INSERT INTO setup_links (id, purpose, account_id, created_at, expires_at, created_by) SELECT ${base}, 'recovery', a.id, ${now}, ${expires}, 'cloudflare' FROM accounts a WHERE a.state = 'active' AND ${who}`,
    ];
  }
  return { statements, url: `${origin.origin}/admin/setup#${token}`, expires };
}

function wrangler(opts, command) {
  const runner = process.env.FK_WRANGLER ? [process.env.FK_WRANGLER] : ["pnpm", "exec", "wrangler"];
  const out = execFileSync(runner[0], [...runner.slice(1), "d1", "execute", opts.database, opts.local ? "--local" : "--remote", "--json", "--command", command], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  const parsed = JSON.parse(out.slice(out.indexOf("[")));
  return Array.isArray(parsed) ? parsed : [parsed];
}

export function main(argv, io = { out: (s) => console.log(s), err: (s) => console.error(s) }) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { io.err(e.message); return 1; }
  if (opts.help) { io.err(USAGE); return 0; }
  let link;
  try { link = buildLink(opts); } catch (e) { io.err(e.message); return 1; }
  if (opts.printSql) {
    io.err("Run these statements in the D1 console of your database (Cloudflare dashboard, Storage & databases, D1), then open the link:");
    io.out(link.statements.join(";\n") + ";");
    io.err(`Link (works once, expires at ${new Date(link.expires).toISOString()}):`);
    io.err(link.url);
    return 0;
  }
  try {
    if (opts.recovery) {
      const rows = wrangler(opts, "SELECT name, role FROM accounts WHERE state = 'active' ORDER BY created_at")[0]?.results ?? [];
      if (!rows.length) { io.err("There is no account yet. Run this without --recovery to create the first owner."); return 1; }
      const owners = rows.filter((r) => r.role === "owner");
      if (opts.account === undefined && owners.length !== 1) { io.err(`Name the account with --account. Owners: ${owners.map((r) => r.name).join(", ") || "none"}.`); return 1; }
      if (opts.account !== undefined && !rows.some((r) => r.name.toLowerCase() === String(opts.account).normalize("NFKC").trim().toLowerCase())) { io.err(`No active account named "${opts.account}". Accounts: ${rows.map((r) => r.name).join(", ")}.`); return 1; }
    }
    const results = wrangler(opts, link.statements.join(";\n"));
    const inserted = results[results.length - 1]?.meta?.changes ?? 0;
    if (!inserted) { io.err(opts.recovery ? "No link was stored. Check the account name." : "An owner already exists. Use --recovery to get a link for an existing account."); return 1; }
  } catch (e) {
    io.err(`wrangler could not run the statement: ${e.message}\nCheck that you are signed in (wrangler login) and that wrangler.toml exists (pnpm materialize), or use --print-sql.`);
    return 1;
  }
  io.err(opts.recovery
    ? `Open this link to set up a new passkey. It replaces the passkeys and signs out every session of the account, works once and expires at ${new Date(link.expires).toISOString()}.`
    : `Open this link in the browser you will sign in with. It creates the first owner, works once and expires at ${new Date(link.expires).toISOString()}.`);
  io.out(link.url);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
