#!/usr/bin/env node
// node scripts/compare-bundles.mjs <dev tarball> <stable tarball>
// What was tested is what ships (S9, ADR-013): the stable bundle of a commit must equal
// the dev bundle of that commit except for what names the release. These files differ
// by design and are skipped: bundle.json, and the widget with its version stamp
// (dist/widget.js, dist/widget.ver). Everything else, the server above all, must be
// byte-identical. Exit 1 lists the files that differ.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SKIP = new Set(["bundle.json", "dist/widget.js", "dist/widget.ver"]);

function files(tarball) {
  const dir = mkdtempSync(join(tmpdir(), "fk-compare-"));
  try {
    execFileSync("tar", ["-xzf", tarball, "-C", dir]);
    const [top] = readdirSync(dir);
    const walk = (rel = "") =>
      readdirSync(join(dir, top, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(rel, e.name)) : [[join(rel, e.name), readFileSync(join(dir, top, rel, e.name))]]));
    return new Map(walk());
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** The paths that differ between two bundles, outside the files that name the release. */
export function differences(tarballA, tarballB) {
  const a = files(tarballA), b = files(tarballB);
  const names = [...new Set([...a.keys(), ...b.keys()])].filter((n) => !SKIP.has(n)).sort();
  return names.filter((n) => !a.has(n) || !b.has(n) || !a.get(n).equals(b.get(n)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dev, stable] = process.argv.slice(2);
  if (!dev || !stable) { console.error("usage: compare-bundles.mjs <dev tarball> <stable tarball>"); process.exit(2); }
  const different = differences(dev, stable);
  if (different.length) { console.error(`the stable bundle differs from the tested dev bundle in: ${different.join(", ")}`); process.exit(1); }
  console.log("compare-bundles: the stable bundle equals the dev bundle except bundle.json and the widget stamp");
}
