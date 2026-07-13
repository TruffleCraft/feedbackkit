#!/usr/bin/env node
// pnpm test-issue <owner/repo>
// Creates a REAL issue via a fine-grained PAT to prove the credential reaches the
// target repo and can open issues — the two things that most often fail on first
// setup (wrong owner, missing Issues:write). PAT from $GITHUB_PAT, else the
// GITHUB_PAT_default line in .dev.vars. Repo from argv[2] or $FK_TEST_REPO.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function patFromDevVars() {
  try {
    const txt = readFileSync(join(root, ".dev.vars"), "utf8");
    const m = txt.match(/^\s*GITHUB_PAT_\w+\s*=\s*(.+?)\s*$/m);
    return m ? m[1].replace(/^["']|["']$/g, "") : undefined;
  } catch {
    return undefined;
  }
}

const repo = process.argv[2] || process.env.FK_TEST_REPO;
const pat = process.env.GITHUB_PAT || patFromDevVars();

if (!repo) {
  console.error("usage: pnpm test-issue <owner/repo>   (or set FK_TEST_REPO)");
  process.exit(1);
}
if (!pat) {
  console.error("no PAT found: set $GITHUB_PAT or add GITHUB_PAT_default=… to .dev.vars");
  process.exit(1);
}

const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${pat}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "FeedbackKit-test-issue",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    title: "[test] FeedbackKit setup check",
    body: "This issue was created by `pnpm test-issue` to verify PAT + repo access. Safe to close.",
    labels: ["test"],
  }),
});

const expiry = res.headers.get("github-authentication-token-expiration");
if (res.ok) {
  const j = await res.json();
  console.log(`✓ created ${j.html_url}${expiry ? `  (PAT expires ${expiry})` : ""}`);
  console.log("  close it when done.");
} else if (res.status === 401) {
  console.error("✗ 401 — the PAT is invalid or expired.");
  process.exit(1);
} else if (res.status === 404) {
  console.error(`✗ 404 — repo ${repo} not found, or the PAT's owner can't see it. Fine-grained PATs are scoped to ONE owner; the token must belong to ${repo.split("/")[0]}.`);
  process.exit(1);
} else {
  console.error(`✗ HTTP ${res.status} — ${(await res.text()).slice(0, 200)}`);
  process.exit(1);
}
