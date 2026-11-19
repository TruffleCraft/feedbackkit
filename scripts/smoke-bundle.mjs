#!/usr/bin/env node
// Release check for the server tarball: unpack it, start it with Node alone on an
// empty data directory and run smoke-check.mjs against it (version, channel,
// schema, widget). The release workflows run it before the tarball is signed.
// Usage: node scripts/smoke-bundle.mjs <tarball> <version> <channel>
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [tarball, version, channel] = process.argv.slice(2);
if (!tarball || !version || !channel) {
  console.error("usage: smoke-bundle.mjs <tarball> <version> <channel>");
  process.exit(2);
}

const port = await new Promise((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});
const dest = mkdtempSync(join(tmpdir(), "fk-smoke-"));
const data = mkdtempSync(join(tmpdir(), "fk-smoke-data-"));
const base = `http://127.0.0.1:${port}`;
let code = 1;
try {
  execFileSync("tar", ["-xzf", tarball, "-C", dest]);
  const dir = join(dest, `feedbackkit-v${version}`);
  // Only what a fresh host has: no repository, no node_modules, no env file, no update check.
  const env = { PATH: process.env.PATH, HOME: data, HOST: "127.0.0.1", PORT: String(port), FK_PUBLIC_URL: base, FK_DATA_DIR: data, FK_ENV_FILE: "/nonexistent", FK_UPDATE_CHECK: "off" };
  const server = spawn(process.execPath, [join(dir, "server.mjs")], { cwd: dir, env, stdio: ["ignore", "ignore", "inherit"] });
  const exited = new Promise((resolve) => server.once("exit", resolve));
  const check = spawn(process.execPath, [join(import.meta.dirname, "smoke-check.mjs"), base, version, channel], { stdio: "inherit" });
  let checked = false;
  // A server that dies on start fails the check at once instead of after its retries.
  code = await Promise.race([
    new Promise((resolve) => check.once("exit", (c) => ((checked = true), resolve(c ?? 1)))),
    exited.then((c) => {
      if (checked) return 1; // stopped below, after the check
      console.error(`smoke-bundle: the server exited on start (code ${c})`);
      check.kill();
      return 1;
    }),
  ]);
  server.kill("SIGTERM");
  await exited;
} finally {
  rmSync(dest, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
}
process.exit(code);
