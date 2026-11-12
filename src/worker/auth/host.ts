import type { Env } from "../env.js";
import { AuthError, findLiveAccountByName, listAccounts, ownerExists } from "./accounts.js";
import { issueLink, openLink, setupUrl } from "./links.js";
import { SESSION_IDLE_MS } from "./sessions.js";

// openLink is exported for tests that check links written by another path (scripts/admin-link.mjs).
export { openLink };
// `feedbackkit-admin import` runs the function of POST /api/admin/config/import, not a copy of it.
export { importProjectConfig as hostImportConfig, CONFIG_IMPORT_MAX_BYTES } from "../admin/config-import.js";
export { embedSnippet } from "../admin/snippet.js";

// What the host commands run (scripts/server-admin.mjs on the standalone server,
// scripts/admin-link.mjs for Cloudflare share the same rules through the SQL in
// links.ts). Whoever can run these has the database in reach, which is exactly
// the proof of control that S14 asks for.

const MAX_MINUTES = 240;

function ttl(minutes: number | undefined): number | undefined {
  if (minutes === undefined) return undefined;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES) throw new AuthError(400, "FK_BODY_INVALID", `--minutes must be a whole number from 1 to ${MAX_MINUTES}.`);
  return minutes * 60_000;
}

/** A link for the first owner. Refuses once an owner exists, and replaces an older unused bootstrap link. */
export async function hostSetupLink(env: Env, input: { origin: string; minutes?: number }): Promise<{ url: string; expiresAt: number }> {
  const link = await issueLink(env, { purpose: "bootstrap", accountId: null, createdBy: "host", ttlMs: ttl(input.minutes) });
  return { url: setupUrl(input.origin, link.token), expiresAt: link.expiresAt };
}

/**
 * A recovery link for an active account. With no name it picks the owner when
 * there is exactly one; with several it asks for a name.
 */
export async function hostRecoveryLink(env: Env, input: { origin: string; account?: string; minutes?: number; keepTokens?: boolean }): Promise<{ url: string; expiresAt: number; account: string }> {
  if (!(await ownerExists(env))) throw new AuthError(409, "FK_NO_OWNER", "There is no owner yet. Run setup-link to create the first one.");
  const accounts = (await listAccounts(env)).filter((a) => a.state === "active");
  let target = input.account ? await findLiveAccountByName(env, input.account) : null;
  if (input.account && (!target || target.state !== "active")) throw new AuthError(404, "FK_ACCOUNT_NOT_FOUND", `No active user named "${input.account}". Users: ${accounts.map((a) => a.name).join(", ") || "none"}.`);
  if (!target) {
    const owners = accounts.filter((a) => a.role === "owner");
    if (owners.length !== 1) throw new AuthError(400, "FK_BODY_INVALID", `Name the user with --user. Owners: ${owners.map((a) => a.name).join(", ") || "none"}.`);
    target = owners[0]!;
  }
  const link = await issueLink(env, { purpose: "recovery", accountId: target.id, createdBy: "host", ttlMs: ttl(input.minutes), keepTokens: input.keepTokens });
  return { url: setupUrl(input.origin, link.token), expiresAt: link.expiresAt, account: target.name };
}

export async function hostAccounts(env: Env) {
  return listAccounts(env);
}

/**
 * Removes what has expired: sessions past their lifetime or idle limit, links
 * and challenge records past their expiry, tokens that ended more than 30 days
 * ago (so the list still shows a token that just expired). Runs with the daily
 * sweep on Cloudflare and hourly on the standalone server.
 */
export async function pruneExpiredAuth(env: Env, now = Date.now()): Promise<void> {
  const grace = now - 30 * 86_400_000;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?1 OR last_seen_at <= ?2").bind(now, now - SESSION_IDLE_MS),
    env.DB.prepare("DELETE FROM setup_links WHERE expires_at <= ?1").bind(now),
    env.DB.prepare("DELETE FROM used_challenges WHERE expires_at <= ?1").bind(now),
    env.DB.prepare("DELETE FROM api_tokens WHERE (revoked_at IS NOT NULL AND revoked_at <= ?1) OR expires_at <= ?1").bind(grace),
  ]);
}
