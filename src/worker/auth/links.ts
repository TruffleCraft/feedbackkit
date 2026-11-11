import type { Env } from "../env.js";
import { AuthError } from "./accounts.js";
import { randomB64url, sha256Hex } from "./crypto.js";

// One-time links: the first owner (bootstrap), recovery, and invitations. The
// link is `<origin>/admin/setup#<token>`. The token sits in the URL fragment, so
// it never reaches a server log, a proxy log or a Referer header; the setup
// page reads it and posts it in a JSON body. The database stores only the
// SHA-256 of the token. A link works once (the batch in enroll.ts stamps it) and
// expires: 30 minutes for bootstrap and recovery, which someone opens right after
// running the host command, and 7 days for an invitation that an owner hands to a
// person.

export type LinkPurpose = "bootstrap" | "recovery" | "invite";
export const LINK_TTL_MS: Record<LinkPurpose, number> = { bootstrap: 30 * 60_000, recovery: 30 * 60_000, invite: 7 * 86_400_000 };
const PREFIX = "fk_link_";

export interface IssuedLink {
  token: string;
  expiresAt: number;
  purpose: LinkPurpose;
}

export const setupUrl = (origin: string, token: string): string => `${origin}/admin/setup#${token}`;

/**
 * Stores a new link and invalidates the unused ones it replaces (one open
 * bootstrap link at a time, one open link per account). Bootstrap refuses once an
 * owner exists; recovery needs an active account, an invitation an invited one.
 */
export async function issueLink(env: Env, input: { purpose: LinkPurpose; accountId: string | null; createdBy: string; ttlMs?: number; now?: number; keepTokens?: boolean }): Promise<IssuedLink> {
  const now = input.now ?? Date.now();
  const expiresAt = now + (input.ttlMs ?? LINK_TTL_MS[input.purpose]);
  const token = PREFIX + randomB64url(32);
  const id = await sha256Hex(token);
  if (input.purpose === "bootstrap") {
    const results = await env.DB.batch([
      env.DB.prepare("DELETE FROM setup_links WHERE purpose = 'bootstrap' AND used_at IS NULL AND NOT EXISTS (SELECT 1 FROM owner_claim)"),
      env.DB.prepare("INSERT INTO setup_links (id, purpose, account_id, created_at, expires_at, created_by) SELECT ?1, 'bootstrap', NULL, ?2, ?3, ?4 WHERE NOT EXISTS (SELECT 1 FROM owner_claim)").bind(id, now, expiresAt, input.createdBy),
    ]);
    if (!results[1]?.meta?.changes) throw new AuthError(409, "FK_OWNER_EXISTS", "An owner already exists. Use the recovery link instead.");
    return { token, expiresAt, purpose: "bootstrap" };
  }
  if (!input.accountId) throw new Error("accountId is required for recovery and invitation links");
  const state = input.purpose === "invite" ? "invited" : "active";
  const results = await env.DB.batch([
    env.DB.prepare("DELETE FROM setup_links WHERE account_id = ?1 AND used_at IS NULL AND EXISTS (SELECT 1 FROM accounts WHERE id = ?1 AND state = ?2)").bind(input.accountId, state),
    env.DB.prepare("INSERT INTO setup_links (id, purpose, account_id, created_at, expires_at, created_by, keep_tokens) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?8 WHERE EXISTS (SELECT 1 FROM accounts WHERE id = ?3 AND state = ?7)").bind(id, input.purpose, input.accountId, now, expiresAt, input.createdBy, state, input.keepTokens && input.purpose === "recovery" ? 1 : 0),
  ]);
  if (!results[1]?.meta?.changes) throw new AuthError(409, "FK_ACCOUNT_STATE", input.purpose === "invite" ? "This account has already been set up." : "This account has not been set up yet. Send it an invitation instead.");
  return { token, expiresAt, purpose: input.purpose };
}

export interface LinkRow {
  id: string;
  purpose: LinkPurpose;
  accountId: string | null;
  expiresAt: number;
}

/** The open link behind a token, or null for anything else (unknown, used, expired). */
export async function openLink(env: Env, token: string, now = Date.now()): Promise<LinkRow | null> {
  if (typeof token !== "string" || !token.startsWith(PREFIX) || token.length > 128) return null;
  const row = await env.DB.prepare("SELECT id, purpose, account_id, expires_at FROM setup_links WHERE id = ?1 AND used_at IS NULL AND expires_at > ?2")
    .bind(await sha256Hex(token), now)
    .first<{ id: string; purpose: LinkPurpose; account_id: string | null; expires_at: number }>();
  return row ? { id: row.id, purpose: row.purpose, accountId: row.account_id, expiresAt: Number(row.expires_at) } : null;
}
