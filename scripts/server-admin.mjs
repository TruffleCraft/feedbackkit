// `feedbackkit-admin` on the standalone server: node server.mjs admin <command>.
// The commands that need the host (S14): the one-time link for the first owner
// and the recovery link. Whoever can read and write the data directory can run
// them, so they prove control of the installation without a static secret.
//
//   feedbackkit-admin setup-link [--minutes N]                  link for the first owner
//   feedbackkit-admin recovery-link [--account NAME] [--minutes N]
//   feedbackkit-admin accounts                                  who exists (no secrets)
//
// The link goes to stdout and nothing else does, so a script can capture it.
// Everything else goes to stderr. The link is never written to a log or a file.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { openStorage } from "./server-storage.mjs";
import { hostAccounts, hostRecoveryLink, hostSetupLink } from "../dist-server/auth.mjs";

const USAGE = `Usage: feedbackkit-admin <command>

  setup-link [--minutes N]                    print a one-time link for the first owner
  recovery-link [--account NAME] [--minutes N]
                                              print a one-time link that replaces the passkeys of an account
  accounts                                    list the accounts

Run it as the user that owns the data directory (for example: sudo -u feedbackkit feedbackkit-admin setup-link).
The link works once and expires: 30 minutes by default.`;

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
    else if (a === "--account") out.account = args[++i];
    else if (a === "-h" || a === "--help") out.help = true;
    else if (a.startsWith("-")) throw new Error(`Unknown option ${a}.`);
    else out._.push(a);
  }
  return out;
}

export async function runAdmin(args, { root, processEnv = process.env, stdout = (s) => console.log(s), stderr = (s) => console.error(s) }) {
  let opts;
  try { opts = options(args); } catch (e) { stderr(e.message); stderr(USAGE); return 1; }
  const command = opts._[0];
  if (opts.help || !command) { stderr(USAGE); return command || opts.help ? 0 : 1; }
  if (!["setup-link", "recovery-link", "accounts"].includes(command)) { stderr(`Unknown command ${command}.`); stderr(USAGE); return 1; }

  // The service reads its environment from a file under systemd; this command reads the same file.
  const envFile = processEnv.FK_ENV_FILE || "/etc/feedbackkit.env";
  let fromFile = {};
  if (existsSync(envFile)) {
    try { fromFile = parseEnvFile(readFileSync(envFile, "utf8")); } catch { stderr(`Could not read ${envFile}. Run this command as root or as the service user, or set FK_DATA_DIR and FK_PUBLIC_URL yourself.`); return 1; }
  }
  const setting = (name) => processEnv[name] || fromFile[name];
  const dataDir = setting("FK_DATA_DIR") || join(root, "data");
  const database = join(dataDir, "feedbackkit.sqlite");
  if (!existsSync(database)) { stderr(`No database at ${database}. Check FK_DATA_DIR in ${envFile}, and start the service once so that it creates the database.`); return 1; }
  if (typeof process.getuid === "function" && statSync(dataDir).uid !== process.getuid()) {
    stderr(`${dataDir} belongs to another user. Running as ${process.getuid()} would leave files there that the service cannot write. Run it as the owner of that directory, for example: sudo -u feedbackkit feedbackkit-admin ${args.join(" ")}`);
    return 1;
  }

  let origin;
  try {
    origin = new URL(setting("FK_PUBLIC_URL") || "http://localhost:8787");
    if (!["http:", "https:"].includes(origin.protocol) || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) throw new Error("bad");
  } catch { stderr("FK_PUBLIC_URL must be an http(s) origin, without credentials, path, query or fragment."); return 1; }
  if (!setting("FK_PUBLIC_URL")) stderr(`FK_PUBLIC_URL is not set in ${envFile}, so the link points at ${origin.origin}. Passkeys are bound to the address the browser uses; set it to the public address first.`);

  const store = openStorage(database, join(root, "migrations"));
  const env = { DB: store.DB };
  try {
    if (command === "accounts") {
      const rows = await hostAccounts(env);
      if (!rows.length) stderr("No accounts yet. Run setup-link to create the first owner.");
      for (const a of rows) stdout(`${a.name}\t${a.role}\t${a.state}\t${a.passkeys} passkey${a.passkeys === 1 ? "" : "s"}${a.linkExpiresAt ? `\topen link until ${new Date(a.linkExpiresAt).toISOString()}` : ""}`);
      return 0;
    }
    const minutes = opts.minutes;
    const result = command === "setup-link"
      ? await hostSetupLink(env, { origin: origin.origin, minutes })
      : await hostRecoveryLink(env, { origin: origin.origin, account: opts.account, minutes });
    stderr(command === "setup-link"
      ? "Open this link in the browser you will sign in with. It creates the first owner, works once and expires at " + new Date(result.expiresAt).toISOString() + "."
      : `Open this link to set up a new passkey for ${result.account}. It replaces the passkeys and signs out every session of that account, works once and expires at ${new Date(result.expiresAt).toISOString()}.`);
    stdout(result.url);
    return 0;
  } catch (e) {
    stderr(e?.code ? `${e.message}` : `Failed: ${e?.message ?? e}`);
    return 1;
  } finally {
    store.close();
  }
}
