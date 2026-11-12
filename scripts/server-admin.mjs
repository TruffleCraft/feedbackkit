// `feedbackkit-admin` on the standalone server: node server.mjs admin <command>.
// The commands that need the host (S14): the one-time link for the first owner,
// the recovery link and the project import. Whoever can read and write the data
// directory can run them, so they prove control of the installation without a
// static secret.
//
//   feedbackkit-admin setup-link [--minutes N]                  link for the first owner
//   feedbackkit-admin recovery-link [--user NAME] [--minutes N]
//   feedbackkit-admin users                                     who can sign in (no secrets)
//   feedbackkit-admin import <config.json|-> [--dry-run]        create or update a project
//
// `accounts` is the old name of `users` and `--account` the old name of `--user`; both keep working until November 2027.
//
// The link goes to stdout and nothing else does, so a script can capture it.
// Everything else goes to stderr. The link is never written to a log or a file.
// `import` prints projectId=, publicKey= and configVersion= lines on stdout; the
// public key is what a site embeds, not a secret.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { openStorage } from "./server-storage.mjs";
import { CONFIG_IMPORT_MAX_BYTES, embedSnippet, hostAccounts, hostImportConfig, hostRecoveryLink, hostSetupLink } from "../dist-server/auth.mjs";

const USAGE = `Usage: feedbackkit-admin <command>

  setup-link [--minutes N]                    print a one-time link for the first owner
  recovery-link [--user NAME] [--minutes N] [--keep-tokens]
                                              print a one-time link that replaces the passkeys of a user
                                              and revokes the API tokens it created (--keep-tokens keeps them)
  users                                       list the users (accounts still works, until November 2027)
  import <config.json> [--dry-run]            create or update a project from a config file (- reads stdin),
                                              as POST /api/admin/config/import does; --dry-run checks it and writes nothing

Run it with sudo (for example: sudo feedbackkit-admin setup-link). It reads /etc/feedbackkit.env as root and then
continues as the user that owns the data directory, so the files it touches stay readable for the service.
A link works once and expires: 30 minutes by default.`;

/** Reads KEY=value lines in the format systemd's EnvironmentFile uses. Comments and blank lines are skipped, matching quotes are removed. */
export function parseEnvFile(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    let value = m[2].trim();
    if (value.length >= 2 && ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}

function options(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--minutes") out.minutes = Number(args[++i]);
    else if (a === "--user" || a === "--account") out.account = args[++i];
    else if (a === "--keep-tokens") out.keepTokens = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else if (a.startsWith("-") && a !== "-") throw new Error(`Unknown option ${a}.`);
    else out._.push(a);
  }
  return out;
}

/** Reads and parses the config for `import`: a file, or stdin for `-`. Returns { value } or { error }. */
function readConfig(path, readInput) {
  let text;
  try { text = path === "-" ? readInput() : readFileSync(path); } catch (e) { return { error: `Could not read ${path === "-" ? "stdin" : path}: ${e.code === "ENOENT" ? "no such file" : e.message}` }; }
  if (Buffer.byteLength(text) > CONFIG_IMPORT_MAX_BYTES) return { error: `The config is larger than ${CONFIG_IMPORT_MAX_BYTES / 1024} KiB.` };
  try { return { value: JSON.parse(String(text)) }; } catch (e) { return { error: `The config is not valid JSON: ${e.message}` }; }
}

export async function runAdmin(args, { root, processEnv = process.env, stdout = (s) => console.log(s), stderr = (s) => console.error(s), readInput = () => readFileSync(0) }) {
  let opts;
  try { opts = options(args); } catch (e) { stderr(e.message); stderr(USAGE); return 1; }
  const command = opts._[0] === "accounts" ? "users" : opts._[0]; // `accounts` is the old name of `users`
  if (opts.help || !command) { stderr(USAGE); return command || opts.help ? 0 : 1; }
  if (!["setup-link", "recovery-link", "users", "import"].includes(command)) { stderr(`Unknown command ${command}.`); stderr(USAGE); return 1; }
  if (opts.dryRun && command !== "import") { stderr("--dry-run belongs to import."); return 1; }

  // The file is read before this command drops root below: the service user may not be allowed to read it.
  let config;
  if (command === "import") {
    if (opts._.length !== 2) { stderr("import takes one config file, or - for stdin."); stderr(USAGE); return 1; }
    const read = readConfig(opts._[1], readInput);
    if (read.error) { stderr(read.error); return 1; }
    config = read.value;
  }

  // The service reads its environment from a file under systemd; this command reads the same file.
  const envFile = processEnv.FK_ENV_FILE || "/etc/feedbackkit.env";
  let fromFile = {};
  if (existsSync(envFile)) {
    try { fromFile = parseEnvFile(readFileSync(envFile, "utf8")); } catch { stderr(`Could not read ${envFile}. Run this command with sudo, or set FK_DATA_DIR and FK_PUBLIC_URL in its environment.`); return 1; }
  }
  const setting = (name) => processEnv[name] || fromFile[name];
  // The systemd unit sets FK_DATA_DIR itself, so the environment file may not name it: the unit's default is the next guess.
  const dataDir = setting("FK_DATA_DIR") || (existsSync("/var/lib/feedbackkit/feedbackkit.sqlite") ? "/var/lib/feedbackkit" : join(root, "data"));
  const database = join(dataDir, "feedbackkit.sqlite");
  if (!existsSync(database)) { stderr(`No database at ${database}. Check FK_DATA_DIR in ${envFile}, and start the service once so that it creates the database.`); return 1; }
  if (typeof process.getuid === "function") {
    const owner = statSync(dataDir);
    if (process.getuid() === 0 && owner.uid !== 0) {
      // Root read the environment file; from here on act as the service user, so that the database files this
      // command creates or rewrites (the write-ahead log) belong to the service and not to root.
      try { process.setgroups([owner.gid]); process.setgid(owner.gid); process.setuid(owner.uid); } catch (e) { stderr(`Could not switch to the owner of ${dataDir}: ${e.message}`); return 1; }
    } else if (process.getuid() !== owner.uid) {
      stderr(`${dataDir} belongs to another user. Running as ${process.getuid()} would leave files there that the service cannot write. Run it with sudo, for example: sudo feedbackkit-admin ${args.join(" ")}`);
      return 1;
    }
  }

  let origin;
  try {
    origin = new URL(setting("FK_PUBLIC_URL") || "http://localhost:8787");
    if (!["http:", "https:"].includes(origin.protocol) || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) throw new Error("bad");
  } catch { stderr("FK_PUBLIC_URL must be an http(s) origin, without credentials, path, query or fragment."); return 1; }
  if (!setting("FK_PUBLIC_URL") && command !== "import") stderr(`FK_PUBLIC_URL is not set in ${envFile}, so the link points at ${origin.origin}. Passkeys are bound to the address the browser uses; set it to the public address first.`);

  const store = openStorage(database, join(root, "migrations"));
  const env = { DB: store.DB };
  try {
    if (command === "users") {
      const rows = await hostAccounts(env);
      if (!rows.length) stderr("No users yet. Run setup-link to create the first owner.");
      for (const a of rows) stdout(`${a.name}\t${a.role}\t${a.state}\t${a.passkeys} passkey${a.passkeys === 1 ? "" : "s"}${a.linkExpiresAt ? `\topen link until ${new Date(a.linkExpiresAt).toISOString()}` : ""}`);
      return 0;
    }
    if (command === "import") return await importProject(env, config, { dryRun: opts.dryRun, origin: origin.origin, root, stdout, stderr });
    const minutes = opts.minutes;
    const result = command === "setup-link"
      ? await hostSetupLink(env, { origin: origin.origin, minutes })
      : await hostRecoveryLink(env, { origin: origin.origin, account: opts.account, minutes, keepTokens: opts.keepTokens });
    stderr(command === "setup-link"
      ? "Open this link in the browser you will sign in with. It creates the first owner, works once and expires at " + new Date(result.expiresAt).toISOString() + "."
      : `Open this link to set up a new passkey for ${result.account}. It replaces the passkeys, signs out every session and ${opts.keepTokens ? "keeps" : "revokes"} the API tokens of that user, works once and expires at ${new Date(result.expiresAt).toISOString()}.`);
    stdout(result.url);
    return 0;
  } catch (e) {
    stderr(e?.code ? `${e.message}` : `Failed: ${e?.message ?? e}`);
    return 1;
  } finally {
    store.close();
  }
}

async function importProject(env, config, { dryRun, origin, root, stdout, stderr }) {
  const result = await hostImportConfig(env, config, { dryRun });
  if (!result.ok) {
    const body = result.body;
    stderr(`Import refused: ${body.error}`);
    for (const issue of Array.isArray(body.issues) ? body.issues : []) stderr(`  ${issue}`);
    return 1;
  }
  const verb = result.created ? "create" : "update";
  const deliveries = result.deliveries.map((d) => `${d.type} -> ${d.delivery}`).join(", ");
  if (dryRun) {
    stderr(`Dry run, nothing was written. This would ${verb} project ${result.projectId} at config version ${result.configVersion}${result.publicKey ? "" : " with a new public key"}.`);
    stderr(`Delivery by type: ${deliveries}. The config needs delivery capability ${result.capability.required}; this database records ${result.capability.available}.`);
  } else {
    stderr(`${result.created ? "Created" : "Updated"} project ${result.projectId} at config version ${result.configVersion}. Delivery by type: ${deliveries}.`);
    if (!result.created) stderr("The running service picks up the change within a minute.");
    let widgetVersion;
    try { widgetVersion = readFileSync(join(root, "dist/widget.ver"), "utf8").trim(); } catch { /* the snippet then says unversioned */ }
    const embed = embedSnippet(origin, widgetVersion, result.publicKey);
    stderr(`Embed: ${embed.snippet}`);
    stderr(`Test page: ${embed.testPage}`);
  }
  stdout(`projectId=${result.projectId}`);
  if (result.publicKey) stdout(`publicKey=${result.publicKey}`);
  stdout(`configVersion=${result.configVersion}`);
  return 0;
}
