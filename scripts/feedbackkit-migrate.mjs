#!/usr/bin/env node
// feedbackkit-migrate: move a gateway's data from Cloudflare (D1 and R2) into the standalone
// server (SQLite). Journey J19, docs/SELF_HOSTING.md ("Move from Cloudflare").
//
//   feedbackkit-migrate export --out <dir> [--config wrangler.toml] [--bucket <name>] [--database feedbackkit]
//                              [--local] [--wrangler "<command>"] [--jobs 4] [--no-objects]
//   feedbackkit-migrate import --from <dir> [--data-dir <dir>] [--dry-run] [--replace-existing] [--json]
//
// export reads the D1 database and the attachments with the operator's own wrangler login. It only
// reads. import writes into the standalone server's database: it loads the D1 dump into a scratch
// SQLite file, brings it to the schema of this release with the same migrations the server runs,
// copies the tables and the attachments, and checks counts and checksums before it commits.
// Nothing in the export is a secret: D1 holds variable names such as GITHUB_PAT_<name>, never values.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chownSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openStorage } from "./server-storage.mjs";
import { codeDeliveryCapability, codeSchemaVersion } from "./code-capability.mjs";

/** A refusal is the tool doing its job: the safe thing was to stop. */
export class Refusal extends Error {}

const FORMAT = 1;
// The tables that move. counters (rate limits and the daily AI budget) and d1_migrations stay behind.
const TABLES = [
  { name: "projects", pk: "id" },
  { name: "feedback", pk: "id", reset: ["claim_token", "claim_until"] }, // a delivery claim means nothing on a new host
  { name: "assets", pk: "key" },
  { name: "events", pk: "id" },
  { name: "dedup", pk: "feedback_id" },
];
const REQUIRED = new Set(["meta", "projects", "feedback", "assets"]);
const KEY = /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.(png|jpg|gif|webp)$/;
const MIME = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
// The same four image signatures as src/worker/storage/r2.ts: the bytes decide the type, never the name.
const SIGNATURES = {
  png: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  jpg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  gif: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38,
  webp: (b) => b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
};

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const q = (name) => `"${String(name).replace(/"/g, '""')}"`;
const sqlString = (text) => `'${String(text).replace(/'/g, "''")}'`;
const count = (db, schema, table) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${schema}.${q(table)}`).get().n);
const columns = (db, schema, table) => db.prepare(`PRAGMA ${schema}.table_info(${q(table)})`).all().map((c) => c.name);
const tablesOf = (db, schema) => new Set(db.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table'`).all().map((r) => r.name));
const metaValue = (db, key) => db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value;
const human = (bytes) => (bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} kB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/** What this build supports: the bundle's record in a tarball, the source in a checkout. */
function supportOf(root) {
  const file = join(root, "bundle.json");
  if (existsSync(file)) {
    const b = JSON.parse(readFileSync(file, "utf8"));
    return { schemaVersion: b.schemaVersion, deliveryCapability: b.deliveryCapability, release: b.release };
  }
  return { schemaVersion: codeSchemaVersion(), deliveryCapability: codeDeliveryCapability(), release: null };
}

function loadDump(path, text) {
  const db = new DatabaseSync(path);
  try { db.exec(text); } catch (error) {
    db.close();
    throw new Refusal(`the export does not load as SQLite SQL (${String(error.message).slice(0, 200)}). Export it again with feedbackkit-migrate export.`);
  }
  return db;
}

/** The names of the secrets the new host must have. D1 holds names only. */
export function secretNames(projects) {
  const names = new Set(["ADMIN_TOKEN"]);
  for (const row of projects) {
    let config;
    try { config = JSON.parse(row.config); } catch { continue; }
    if (config?.llm?.provider && config.llm.provider !== "off") names.add("LLM_API_KEY");
    for (const name of [config?.tracker?.patSecret, config?.tracker?.project?.patSecret, config?.turnstile?.secret]) if (typeof name === "string" && name) names.add(name);
  }
  return [...names].sort();
}

// ── export ────────────────────────────────────────────────────────────────────────

function run(command, args, cwd) {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("error", (error) => done({ code: 127, output: String(error.message) }));
    child.on("close", (code) => done({ code: code ?? 1, output }));
  });
}

const ABSENT = /does not exist|not found|NoSuchKey|10007/i;
/** The line of wrangler's output that says what went wrong, not its pointer to a log file. */
function usefulLine(output) {
  const lines = output.split("\n").map((l) => l.trim()).filter((l) => l && !/Logs were written/.test(l));
  return (lines.find((l) => /error|failed|not exist|not found|locked/i.test(l)) ?? lines.at(-1) ?? "").slice(0, 160);
}

/** `[[r2_buckets]]` and `[[d1_databases]]` names from a wrangler.toml, or null. */
export function namesFromWranglerToml(text) {
  const block = (header, binding) => text.split(/^\s*(?=\[\[)/m).find((b) => b.startsWith(`[[${header}]]`) && new RegExp(`binding\\s*=\\s*"${binding}"`).test(b));
  const bucket = block("r2_buckets", "UPLOADS")?.match(/bucket_name\s*=\s*"([^"]+)"/)?.[1] ?? null;
  const database = block("d1_databases", "DB")?.match(/database_name\s*=\s*"([^"]+)"/)?.[1] ?? null;
  return { bucket, database };
}

export async function exportFromCloudflare({ out, database, bucket, config, local = false, wrangler = process.env.FK_WRANGLER || "npx --yes wrangler", jobs = 4, objects = true, log = console.log }) {
  if (!out) throw new Refusal("--out is required");
  out = resolve(out);
  if (existsSync(out) && readdirSync(out).length) throw new Refusal(`${out} is not empty. Choose a new directory.`);
  const cwd = config ? dirname(resolve(config)) : process.cwd();
  const toml = config && existsSync(config) ? namesFromWranglerToml(readFileSync(config, "utf8")) : { bucket: null, database: null };
  database ||= toml.database || "feedbackkit";
  bucket ||= toml.bucket;
  if (objects && !bucket) throw new Refusal("the R2 bucket name is needed: pass --bucket <name>, or --config <wrangler.toml> with the UPLOADS binding, or --no-objects");
  const [command, ...base] = wrangler.split(/\s+/).filter(Boolean);
  const where = local ? "--local" : "--remote";
  const withConfig = config ? ["-c", resolve(config)] : [];
  mkdirSync(out, { recursive: true, mode: 0o700 });

  log(`Reading D1 database "${database}" (${local ? "local" : "remote"}). A remote export briefly blocks requests to that database, so run it when the gateway is quiet.`);
  const dumpPath = join(out, "d1.sql");
  const dumped = await run(command, [...base, "d1", "export", database, where, "--output", dumpPath, "-y", ...withConfig], cwd);
  if (dumped.code !== 0 || !existsSync(dumpPath)) throw new Error(`wrangler d1 export failed (exit ${dumped.code}):\n${dumped.output.trim().split("\n").slice(-12).join("\n")}`);
  const dumpText = readFileSync(dumpPath, "utf8");
  const scratch = loadDump(":memory:", dumpText);
  let manifest;
  try {
    const tables = tablesOf(scratch, "main");
    for (const need of REQUIRED) if (!tables.has(need)) throw new Refusal(`the database has no table "${need}": this is not a FeedbackKit database`);
    const schemaVersion = Number(metaValue(scratch, "schema_version"));
    const keys = scratch.prepare("SELECT key FROM assets WHERE deleted = 0 ORDER BY key").all().map((r) => r.key);
    for (const key of keys) if (!KEY.test(key)) throw new Refusal(`an attachment key has an unexpected shape and was not downloaded: ${key.slice(0, 80)}`);
    manifest = {
      format: FORMAT,
      exportedAt: new Date().toISOString(),
      source: { kind: local ? "local" : "remote", database, bucket: objects ? bucket : null },
      d1: { file: "d1.sql", bytes: Buffer.byteLength(dumpText), sha256: sha256(dumpText) },
      schemaVersion,
      deliveryCapability: Number(metaValue(scratch, "delivery_capability") ?? 0),
      rows: Object.fromEntries(TABLES.filter((t) => tables.has(t.name)).map((t) => [t.name, count(scratch, "main", t.name)])),
      objectsIncluded: objects,
      objects: [],
      missing: [],
    };
    log(`D1: schema ${schemaVersion}, ${Object.entries(manifest.rows).map(([t, n]) => `${n} ${t}`).join(", ")}.`);

    if (objects) {
      log(`Downloading ${keys.length} attachment${keys.length === 1 ? "" : "s"} from bucket "${bucket}"...`);
      const queue = [...keys];
      const worker = async () => {
        for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
          const file = join(out, "objects", key);
          mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
          let got;
          // A bucket that lacks the object answers at once. Anything else may pass, so try again.
          for (let attempt = 1; attempt <= 3; attempt++) {
            got = await run(command, [...base, "r2", "object", "get", `${bucket}/${key}`, "--file", file, where, ...withConfig], cwd);
            if ((got.code === 0 && existsSync(file)) || ABSENT.test(got.output)) break;
            await new Promise((r) => setTimeout(r, 300 * attempt));
          }
          if (got.code !== 0 || !existsSync(file)) { manifest.missing.push({ key, error: usefulLine(got.output) }); continue; }
          const data = readFileSync(file);
          manifest.objects.push({ key, bytes: data.length, sha256: sha256(data) });
        }
      };
      // Wrangler's local R2 is one SQLite state: two readers at once lock it. A remote bucket takes several.
      await Promise.all(Array.from({ length: local ? 1 : Math.max(1, Math.min(jobs, 16)) }, worker));
      manifest.objects.sort((a, b) => (a.key < b.key ? -1 : 1));
      manifest.missing.sort((a, b) => (a.key < b.key ? -1 : 1));
      if (keys.length && manifest.missing.length === keys.length) throw new Error(`no attachment could be downloaded. Is the bucket name "${bucket}" right and wrangler logged in? First error: ${manifest.missing[0].error}`);
      log(`Attachments: ${manifest.objects.length} downloaded (${human(manifest.objects.reduce((n, o) => n + o.bytes, 0))})${manifest.missing.length ? `, ${manifest.missing.length} listed in the database but not found in the bucket` : ""}.`);
    }
  } finally { scratch.close(); }
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  log(`Export written to ${out}. Copy that directory to the new host, then run: feedbackkit-migrate import --from <directory> --dry-run`);
  return manifest;
}

// ── import ────────────────────────────────────────────────────────────────────────

/** Row counts and a checksum per table, the same function on both sides of the copy. */
function tableDigest(db, schema, table, cols, pk) {
  const hash = createHash("sha256");
  const rows = db.prepare(`SELECT ${cols.map(q).join(", ")} FROM ${schema}.${q(table)} ORDER BY ${q(pk)}`);
  for (const row of rows.iterate()) {
    hash.update(JSON.stringify(cols.map((c) => { const v = row[c]; return typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString("base64") : v; })) + "\n");
  }
  return hash.digest("hex");
}

function verify(db, tables, objects) {
  const problems = [];
  for (const t of tables) {
    const keep = t.cols.filter((c) => !(t.reset ?? []).includes(c));
    if (count(db, "main", t.name) !== count(db, "src", t.name)) problems.push(`${t.name}: ${count(db, "main", t.name)} rows, expected ${count(db, "src", t.name)}`);
    else if (tableDigest(db, "main", t.name, keep, t.pk) !== tableDigest(db, "src", t.name, keep, t.pk)) problems.push(`${t.name}: the rows differ from the export`);
    for (const c of t.reset ?? []) if (db.prepare(`SELECT COUNT(*) AS n FROM main.${q(t.name)} WHERE ${q(c)} IS NOT NULL`).get().n) problems.push(`${t.name}.${c} is not empty`);
  }
  const stored = Number(db.prepare("SELECT COUNT(*) AS n FROM main._fk_objects").get().n);
  if (stored !== objects.length) problems.push(`attachments: ${stored} stored, expected ${objects.length}`);
  for (const o of objects) {
    const row = db.prepare("SELECT data FROM main._fk_objects WHERE key = ?").get(o.key);
    if (!row || sha256(row.data) !== o.sha256) problems.push(`attachment ${o.key}: missing or its checksum differs`);
  }
  return problems;
}

export async function importIntoServer({ from, dataDir, dryRun = false, replaceExisting = false, root, log = console.log }) {
  if (!from) throw new Refusal("--from is required");
  process.umask(0o077); // a new data directory and database are readable by their owner only, as the server makes them
  from = resolve(from);
  root ??= existsSync(join(dirname(fileURLToPath(import.meta.url)), "bundle.json")) ? dirname(fileURLToPath(import.meta.url)) : join(dirname(fileURLToPath(import.meta.url)), "..");
  const migrations = join(root, "migrations");
  const support = supportOf(root);
  const manifestFile = join(from, "manifest.json");
  if (!existsSync(manifestFile)) throw new Refusal(`${from} has no manifest.json. It must be a directory written by feedbackkit-migrate export.`);
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  if (manifest.format !== FORMAT) throw new Refusal(`the export has format ${manifest.format}, this tool reads format ${FORMAT}. Use the release that wrote it.`);

  const dumpText = readFileSync(join(from, manifest.d1.file), "utf8");
  if (sha256(dumpText) !== manifest.d1.sha256) throw new Refusal("d1.sql does not match the checksum in manifest.json. The export is damaged or was edited.");

  const objects = [];
  for (const o of manifest.objects ?? []) {
    if (!KEY.test(o.key)) throw new Refusal(`an attachment key has an unexpected shape: ${String(o.key).slice(0, 80)}`);
    const file = join(from, "objects", o.key);
    if (!existsSync(file)) throw new Refusal(`attachment ${o.key} is listed in the manifest but missing from the export`);
    const data = readFileSync(file);
    if (sha256(data) !== o.sha256) throw new Refusal(`attachment ${o.key} does not match its checksum`);
    const ext = o.key.split(".").pop();
    if (!SIGNATURES[ext](data)) throw new Refusal(`attachment ${o.key} is not a ${ext} image`);
    objects.push({ key: o.key, sha256: o.sha256, bytes: data.length, mime: MIME[ext], data });
  }

  const work = mkdtempSync(join(tmpdir(), "fk-import-"));
  const scratchPath = join(work, "source.sqlite");
  let scratch, storage;
  try {
    scratch = loadDump(scratchPath, dumpText);
    const present = tablesOf(scratch, "main");
    for (const need of REQUIRED) if (!present.has(need)) throw new Refusal(`the export has no table "${need}"`);
    const sourceVersion = Number(metaValue(scratch, "schema_version"));
    if (!Number.isInteger(sourceVersion) || sourceVersion < 1) throw new Refusal("the export has no usable schema version");
    if (sourceVersion > support.schemaVersion) throw new Refusal(`the export has schema ${sourceVersion} and this release supports ${support.schemaVersion}. Install a newer release of the standalone server first.`);
    const sourceCapability = Number(metaValue(scratch, "delivery_capability") ?? 0);
    if (sourceCapability > support.deliveryCapability) throw new Refusal(`the data needs delivery capability ${sourceCapability} and this release provides ${support.deliveryCapability}. Install a newer release first.`);

    // Bring the copy to this release's schema with the migrations the server itself runs.
    const upgraded = [];
    for (const name of readdirSync(migrations).filter((n) => /^\d+_.*\.sql$/.test(n)).sort()) {
      if (Number(name.split("_")[0]) > sourceVersion) { scratch.exec(readFileSync(join(migrations, name), "utf8")); upgraded.push(name); }
    }
    if (Number(metaValue(scratch, "schema_version")) !== support.schemaVersion) throw new Refusal(`after the migrations the schema is ${metaValue(scratch, "schema_version")}, expected ${support.schemaVersion}`);
    if (upgraded.length) log(`The export has schema ${sourceVersion}. Applying ${upgraded.length} migration${upgraded.length === 1 ? "" : "s"} to the copy first: ${upgraded.join(", ")}.`);

    const tables = TABLES.filter((t) => present.has(t.name)).map((t) => ({ ...t, cols: columns(scratch, "main", t.name) }));
    const rows = Object.fromEntries(tables.map((t) => [t.name, count(scratch, "main", t.name)]));
    const projects = scratch.prepare("SELECT config FROM projects ORDER BY id").all();
    const wanted = new Set(scratch.prepare("SELECT key FROM assets WHERE deleted = 0").all().map((r) => r.key));
    const known = new Set([...objects.map((o) => o.key), ...(manifest.missing ?? []).map((m) => m.key)]);
    const unaccounted = [...wanted].filter((k) => !known.has(k));
    if (manifest.objectsIncluded !== false && unaccounted.length) throw new Refusal(`${unaccounted.length} attachment${unaccounted.length === 1 ? " is" : "s are"} in the database but neither in the export nor listed as missing, for example ${unaccounted[0]}. Export again.`);

    const file = join(dataDir ?? join(process.env.FK_DATA_DIR || join(root, "data")), "feedbackkit.sqlite");
    let occupied = null;
    if (existsSync(file)) {
      const existing = new DatabaseSync(file, { readOnly: true });
      try {
        const there = tablesOf(existing, "main");
        occupied = ["projects", "feedback", "assets", "_fk_objects"].filter((t) => there.has(t) && count(existing, "main", t) > 0);
      } finally { existing.close(); }
      if (!occupied.length) occupied = null;
    }

    const summary = {
      dryRun,
      from,
      destination: file,
      sourceSchema: sourceVersion,
      schema: support.schemaVersion,
      migrationsApplied: upgraded,
      deliveryCapability: Math.max(sourceCapability, 0),
      rows,
      attachments: { count: objects.length, bytes: objects.reduce((n, o) => n + o.bytes, 0), missingInBucket: (manifest.missing ?? []).length, included: manifest.objectsIncluded !== false },
      destinationHadData: occupied,
      secrets: secretNames(projects),
      skipped: ["counters (rate limits and the daily AI budget)", "d1_migrations"],
    };
    const lines = () => {
      log(`Source: schema ${sourceVersion}${upgraded.length ? ` (brought to ${support.schemaVersion})` : ""}, delivery capability ${sourceCapability}.`);
      log(`Moves: ${Object.entries(rows).map(([t, n]) => `${n} ${t}`).join(", ")}; ${objects.length} attachment${objects.length === 1 ? "" : "s"} (${human(summary.attachments.bytes)}).`);
      if (summary.attachments.missingInBucket) log(`Warning: ${summary.attachments.missingInBucket} attachment${summary.attachments.missingInBucket === 1 ? " was" : "s were"} listed in the database but not found in the bucket. Their reports keep a row without an image, as they do on Cloudflare.`);
      if (!summary.attachments.included) log("Warning: the export was made without attachments. Reports keep their attachment rows, the images are not moved.");
      log(`Stays behind: ${summary.skipped.join(", ")}.`);
      log(`Set these on the new host, they are not in D1: ${summary.secrets.join(", ")}.`);
    };

    if (occupied && !replaceExisting) {
      lines();
      throw new Refusal(`${file} already holds data (${occupied.join(", ")}). Import into an empty data directory, or pass --replace-existing to replace it (a copy of the old database is kept next to it).`);
    }
    if (dryRun) {
      lines();
      log(occupied ? `Dry run: ${file} holds data and would be replaced, with a copy kept. Nothing was written.` : `Dry run: ${file} is empty. Nothing was written.`);
      return summary;
    }

    if (occupied) {
      const old = openStorage(file, migrations);
      old.sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      old.close();
      const backup = `${file}.before-import-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`;
      copyFileSync(file, backup);
      summary.backup = backup;
      log(`Kept a copy of the old database: ${backup}`);
    }
    storage = openStorage(file, migrations);
    const db = storage.sqlite;
    for (const t of tables) {
      const a = columns(db, "main", t.name).sort().join(","), b = [...t.cols].sort().join(",");
      if (a !== b) throw new Refusal(`table ${t.name} differs between the export (${b}) and this release (${a}). Use the release that matches the export.`);
    }
    db.exec(`ATTACH DATABASE ${sqlString(scratchPath)} AS src`);
    db.exec("BEGIN IMMEDIATE");
    try {
      if (occupied) for (const t of [...tables.map((x) => x.name), "_fk_objects"]) db.exec(`DELETE FROM main.${q(t)}`);
      for (const t of tables) {
        const select = t.cols.map((c) => ((t.reset ?? []).includes(c) ? `NULL AS ${q(c)}` : q(c))).join(", ");
        db.exec(`INSERT INTO main.${q(t.name)} (${t.cols.map(q).join(", ")}) SELECT ${select} FROM src.${q(t.name)} ORDER BY ${q(t.pk)}`);
      }
      db.prepare("INSERT INTO main.meta (key, value) VALUES ('delivery_capability', ?) ON CONFLICT(key) DO UPDATE SET value = CAST(MAX(CAST(meta.value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)").run(String(sourceCapability));
      const put = db.prepare("INSERT INTO main._fk_objects (key, data, metadata) VALUES (?, ?, ?)");
      for (const o of objects) put.run(o.key, o.data, JSON.stringify({ contentType: o.mime, cacheControl: "public, max-age=300" }));
      const problems = verify(db, tables, objects);
      if (problems.length) throw new Error(`the copy does not match the export, nothing was written:\n  ${problems.join("\n  ")}`);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw error;
    }
    db.exec("DETACH DATABASE src");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    storage.close();
    storage = undefined;

    // A second look through a new connection, after the commit.
    const after = new DatabaseSync(file, { readOnly: true });
    try {
      after.exec(`ATTACH DATABASE ${sqlString(scratchPath)} AS src`);
      const problems = verify(after, tables, objects);
      if (problems.length) throw new Error(`the database does not match the export after the commit:\n  ${problems.join("\n  ")}`);
    } finally { after.close(); }

    if (process.getuid?.() === 0) {
      const owner = statSync(dirname(file));
      for (const suffix of ["", "-wal", "-shm"]) if (existsSync(file + suffix)) chownSync(file + suffix, owner.uid, owner.gid);
    }
    lines();
    log(`Imported into ${file} and checked: row counts and checksums of every table, and the checksum of every attachment.`);
    log("Start the server, open /diag and the System page, then point the gateway's hostname at this host.");
    return summary;
  } finally {
    try { storage?.close(); } catch { /* closed */ }
    scratch?.close();
    rmSync(work, { recursive: true, force: true });
  }
}

// ── command line ──────────────────────────────────────────────────────────────────

const USAGE = `feedbackkit-migrate: move a gateway from Cloudflare (D1, R2) to the standalone server (SQLite)

  export --out <dir> [--config wrangler.toml] [--bucket <name>] [--database feedbackkit]
         [--local] [--wrangler "<command>"] [--jobs 4] [--no-objects]
  import --from <dir> [--data-dir <dir>] [--dry-run] [--replace-existing] [--json]

export reads with your own wrangler login and only reads. import refuses a data directory that
already holds data, a newer schema than this release knows, and a damaged export.`;

export function parseArgs(argv) {
  const flags = new Set(["local", "no-objects", "dry-run", "replace-existing", "json", "help"]);
  const options = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) { options._.push(arg); continue; }
    const name = arg.slice(2);
    if (flags.has(name)) options[name] = true;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) options[name] = argv[++i];
    else throw new Refusal(`--${name} needs a value`);
  }
  return options;
}

export async function main(argv, { log = console.log } = {}) {
  const o = parseArgs(argv);
  const [command] = o._;
  if (o.help || !command) { log(USAGE); return 0; }
  try {
    if (command === "export") {
      await exportFromCloudflare({ out: o.out, database: o.database, bucket: o.bucket, config: o.config, local: Boolean(o.local), wrangler: o.wrangler, jobs: o.jobs ? Number(o.jobs) : 4, objects: !o["no-objects"], log });
    } else if (command === "import") {
      const summary = await importIntoServer({ from: o.from, dataDir: o["data-dir"], dryRun: Boolean(o["dry-run"]), replaceExisting: Boolean(o["replace-existing"]), log: o.json ? () => {} : log });
      if (o.json) log(JSON.stringify(summary, null, 2));
    } else throw new Refusal(`unknown command ${command}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Refusal ? `Refused: ${error.message}` : `Failed: ${error.message}`);
    return error instanceof Refusal ? 2 : 1;
  }
}

// Run as a command. The real path is compared because Node reports the real path in import.meta.url, and
// the documented way to start this is through the link /opt/feedbackkit/current.
const entry = process.argv[1] && (() => { try { return realpathSync(process.argv[1]); } catch { return process.argv[1]; } })();
if (entry && import.meta.url === pathToFileURL(entry).href) process.exitCode = await main(process.argv.slice(2));
