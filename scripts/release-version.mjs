#!/usr/bin/env node
// Release versions from git tags (ADR-013, modelled on NORA's release channels):
//   dev     vX.Y.Z-dev.N  — every merge to main, served on the gateway's "dev" preview alias
//   stable  vX.Y.Z        — a tested dev build, promoted by hand, served on production
// No bump commits or release PRs: the next version is derived from the tags alone.
// A dev build after a stable release takes the next patch by itself; a new minor or
// major line is started once (bump input) and later dev builds stay on it.
//
//   node scripts/release-version.mjs next-dev [none|minor|major]   → v0.1.0-dev.4
//   node scripts/release-version.mjs promote v0.1.0-dev.4          → v0.1.0
//   node scripts/release-version.mjs latest-stable                 → v0.1.0 (or nothing)
//   node scripts/release-version.mjs prune-dev <keep>              → dev tags beyond the newest <keep>
//   node scripts/release-version.mjs dev-of v0.1.0                 → dev tags of that version
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TAG = /^v(\d+)\.(\d+)\.(\d+)(?:-dev\.(\d+))?$/;
const FIRST = { major: 0, minor: 1, patch: 0 }; // the first line is 0.1.0 (pre-0.1 until now)

export function parse(tag) {
  const m = TAG.exec(tag);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], dev: m[4] === undefined ? null : +m[4] };
}

const cmpBase = (a, b) => a.major - b.major || a.minor - b.minor || a.patch - b.patch;
// A dev build sorts below the stable release of the same version.
const cmp = (a, b) => cmpBase(a, b) || (a.dev ?? Infinity) - (b.dev ?? Infinity);
const fmt = (v) => `v${v.major}.${v.minor}.${v.patch}${v.dev === null || v.dev === undefined ? "" : `-dev.${v.dev}`}`;

function bumped(stable, bump) {
  if (!stable) return bump === "major" ? { major: 1, minor: 0, patch: 0 } : { ...FIRST };
  if (bump === "major") return { major: stable.major + 1, minor: 0, patch: 0 };
  if (bump === "minor") return { major: stable.major, minor: stable.minor + 1, patch: 0 };
  return { major: stable.major, minor: stable.minor, patch: stable.patch + 1 };
}

export function latestStable(tags) {
  const stable = tags.map(parse).filter((t) => t && t.dev === null).sort(cmp);
  return stable.at(-1) ?? null;
}

export function nextDev(tags, bump = "none") {
  if (!["none", "minor", "major"].includes(bump)) throw new Error(`bump must be none, minor or major, got "${bump}"`);
  const all = tags.map(parse).filter(Boolean);
  const stable = latestStable(tags);
  let base = bumped(stable, bump);
  // A line already started by earlier dev builds (e.g. a minor bump) wins over the next patch.
  const open = all.filter((t) => t.dev !== null && (!stable || cmpBase(t, stable) > 0)).sort(cmp);
  const started = open.at(-1);
  if (started && cmpBase(started, base) > 0) base = { major: started.major, minor: started.minor, patch: started.patch };
  const n = all.filter((t) => t.dev !== null && cmpBase(t, base) === 0).reduce((max, t) => Math.max(max, t.dev), 0) + 1;
  return fmt({ ...base, dev: n });
}

export function promote(devTag, tags) {
  const d = parse(devTag);
  if (!d || d.dev === null) throw new Error(`not a dev build tag: "${devTag}"`);
  if (!tags.includes(devTag)) throw new Error(`unknown tag: ${devTag}`);
  const stable = fmt({ ...d, dev: null });
  if (tags.includes(stable)) throw new Error(`${stable} is already released`);
  const latest = latestStable(tags);
  if (latest && cmpBase(d, latest) <= 0) throw new Error(`${stable} is not newer than the current stable ${fmt(latest)}`);
  return stable;
}

export function pruneDev(tags, keep) {
  const devs = tags.map((t) => ({ t, v: parse(t) })).filter((x) => x.v && x.v.dev !== null).sort((a, b) => cmp(a.v, b.v));
  return devs.slice(0, Math.max(0, devs.length - keep)).map((x) => x.t);
}

export function devOf(stableTag, tags) {
  const s = parse(stableTag);
  if (!s || s.dev !== null) throw new Error(`not a stable tag: "${stableTag}"`);
  return tags.filter((t) => {
    const v = parse(t);
    return v && v.dev !== null && cmpBase(v, s) === 0;
  });
}

function gitTags() {
  return execFileSync("git", ["tag", "--list", "v*"], { encoding: "utf8" }).split("\n").map((s) => s.trim()).filter(Boolean);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, arg] = process.argv.slice(2);
  const tags = gitTags();
  try {
    if (cmd === "next-dev") console.log(nextDev(tags, arg || "none"));
    else if (cmd === "promote") console.log(promote(arg ?? "", tags));
    else if (cmd === "latest-stable") {
      const l = latestStable(tags);
      if (l) console.log(fmt(l));
    } else if (cmd === "prune-dev") pruneDev(tags, Number(arg ?? 3)).forEach((t) => console.log(t));
    else if (cmd === "dev-of") devOf(arg ?? "", tags).forEach((t) => console.log(t));
    else throw new Error("usage: release-version.mjs next-dev|promote|latest-stable|prune-dev|dev-of");
  } catch (e) {
    console.error(`release-version: ${e.message}`);
    process.exit(1);
  }
}
