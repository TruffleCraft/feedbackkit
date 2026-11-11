#!/usr/bin/env node
// pnpm build:bundle: the standalone server as one release tarball (S8, Step D).
//
//   FK_RELEASE=0.1.19-dev.1 pnpm build:widget && pnpm build:server && node scripts/build-bundle.mjs
//
// Writes dist-bundle/feedbackkit-v<release>.tar.gz and dist-bundle/SHA256SUMS. The
// tarball holds a single-file server without node_modules, the widget and admin
// assets, the migrations, the systemd unit, the update and migrate commands, the public release
// keys and bundle.json (release, channel, schema version, delivery capability). The
// bytes depend on the sources and the release only, so a rebuild is identical.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { packTarGz } from "./tar-pack.mjs";
import { codeDeliveryCapability, codeSchemaVersion } from "./code-capability.mjs";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-dev\.(\d+))?$/;

/** stable (1.2.3), dev (1.2.3-dev.4) or local (anything built outside the release workflows). */
export function channelOf(release) {
  const m = SEMVER.exec(release);
  if (!m) return "local";
  return m[4] === undefined ? "stable" : "dev";
}

export async function buildBundle({ root, outDir, release, commit = null, epoch = 0, keysDir = join(root, "release-keys") }) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(release)) throw new Error(`release must look like 1.2.3 or 1.2.3-dev.4, got "${release}"`);
  for (const need of ["dist/widget.js", "dist/admin.js", "dist/widget.ver", "dist-server/app.mjs"]) {
    if (!existsSync(join(root, need))) throw new Error(`${need} is missing: run pnpm build:widget and pnpm build:server first`);
  }
  const file = (path, mode = 0o644) => ({ path: `feedbackkit-v${release}/${path}`, mode, data: readFileSync(join(root, path)) });
  const entries = [{ path: `feedbackkit-v${release}`, mode: 0o755, dir: true }];

  // One file for the server: the application, its storage adapter and @hono/node-server.
  // node: modules stay external. Nothing reads src/ at run time.
  const bundled = await build({
    entryPoints: [join(root, "scripts/server.mjs")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node24",
    legalComments: "none",
    logLevel: "silent",
    // dist-server/app.mjs already has the alias applied; this covers any module the server pulls in itself.
    alias: { "cloudflare:workers": join(root, "src/worker/standalone/cloudflare-workers.ts") },
  });
  entries.push({ path: `feedbackkit-v${release}/server.mjs`, mode: 0o644, data: bundled.outputFiles[0].contents });
  // The command that moves a gateway from Cloudflare into this server (J19), built the same way.
  const migrate = await build({
    entryPoints: [join(root, "scripts/feedbackkit-migrate.mjs")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node24",
    legalComments: "none",
    logLevel: "silent",
  });
  entries.push({ path: `feedbackkit-v${release}/feedbackkit-migrate.mjs`, mode: 0o755, data: migrate.outputFiles[0].contents });

  for (const name of ["widget.js", "admin.js", "auth.js", "urbanist.woff2", "widget.ver"]) {
    if (existsSync(join(root, "dist", name))) entries.push(file(`dist/${name}`));
  }
  for (const name of readdirSync(join(root, "migrations")).filter((n) => n.endsWith(".sql")).sort()) entries.push(file(`migrations/${name}`));
  entries.push({ path: `feedbackkit-v${release}/deploy/feedbackkit.service`, mode: 0o644, data: readFileSync(join(root, "deploy/feedbackkit-bundle.service")) });
  if (existsSync(join(root, "scripts/feedbackkit-update"))) entries.push({ ...file("scripts/feedbackkit-update", 0o755), path: `feedbackkit-v${release}/feedbackkit-update` });
  if (existsSync(join(root, "scripts/feedbackkit-admin"))) entries.push({ ...file("scripts/feedbackkit-admin", 0o755), path: `feedbackkit-v${release}/feedbackkit-admin` });
  if (existsSync(keysDir)) {
    for (const name of readdirSync(keysDir).filter((n) => n.endsWith(".pub")).sort()) {
      entries.push({ path: `feedbackkit-v${release}/release-keys/${name}`, mode: 0o644, data: readFileSync(join(keysDir, name)) });
    }
  }
  if (existsSync(join(root, "LICENSE"))) entries.push(file("LICENSE"));

  const manifest = {
    release,
    channel: channelOf(release),
    commit,
    schemaVersion: codeSchemaVersion(),
    deliveryCapability: codeDeliveryCapability(),
    node: ">=24",
    files: entries.filter((e) => !e.dir).map((e) => e.path.split("/").slice(1).join("/")).sort(),
  };
  entries.push({ path: `feedbackkit-v${release}/bundle.json`, mode: 0o644, data: JSON.stringify(manifest, null, 2) + "\n" });

  mkdirSync(outDir, { recursive: true });
  const name = `feedbackkit-v${release}.tar.gz`;
  const tarball = packTarGz(entries, epoch);
  writeFileSync(join(outDir, name), tarball);
  const sum = createHash("sha256").update(tarball).digest("hex");
  writeFileSync(join(outDir, "SHA256SUMS"), `${sum}  ${name}\n`);
  return { name, sha256: sum, manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const release = (process.env.FK_RELEASE || "0.0.0-local").replace(/^v/, "");
  const git = (...args) => { try { return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(); } catch { return null; } };
  const commit = git("rev-parse", "HEAD");
  const epoch = Number(process.env.SOURCE_DATE_EPOCH || git("log", "-1", "--format=%ct") || 0);
  const outDir = join(root, "dist-bundle");
  rmSync(outDir, { recursive: true, force: true });
  const result = await buildBundle({ root, outDir, release, commit, epoch });
  console.log(`build:bundle: dist-bundle/${result.name} (${result.manifest.channel}, schema ${result.manifest.schemaVersion}, capability ${result.manifest.deliveryCapability}) sha256 ${result.sha256}`);
}
