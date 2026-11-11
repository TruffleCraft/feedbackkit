import type { Env } from "../env.js";
import { AuthError } from "./accounts.js";
import { randomB64url, sha256Hex } from "./crypto.js";

// Scoped API tokens for scripts and agents. A token is `fk_tok_` plus 256 random
// bits. The database keeps its SHA-256 (a slow hash would add nothing at this
// entropy), the first characters for the list, and the scope. The token is
// shown once, when it is created.
//
// Scope: `access` is read (GET only) or write (every admin route a signed-in
// person may use, except accounts and tokens, which only a session of an owner
// reaches), and `projects` is a list of project IDs or null for all of them. A
// token with a project list reaches only routes that name one of those projects;
// everything else answers 403 (see admin/auth.ts).
//
// Lifetime: 1 to 365 days, 90 by default, no token without an end. Revoking sets
// revoked_at and takes effect on the next request: nothing is cached.

export type TokenAccess = "read" | "write";
export const TOKEN_PREFIX = "fk_tok_";
export const TOKEN_DEFAULT_DAYS = 90;
export const TOKEN_MAX_DAYS = 365;
const MAX_TOKENS_PER_ACCOUNT = 100;
const TOUCH_AFTER_MS = 60 * 60_000;

export interface ApiTokenRow {
  id: string;
  prefix: string;
  name: string;
  accountId: string;
  access: TokenAccess;
  projects: string[] | null;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

interface Raw {
  id: string;
  prefix: string;
  name: string;
  account_id: string;
  access: TokenAccess;
  projects: string | null;
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

const parseProjects = (raw: string | null): string[] | null => {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return []; // unreadable scope: the narrowest reading
  }
};

const toRow = (r: Raw): ApiTokenRow => ({
  id: r.id,
  prefix: r.prefix,
  name: r.name,
  accountId: r.account_id,
  access: r.access,
  projects: parseProjects(r.projects),
  createdAt: Number(r.created_at),
  expiresAt: Number(r.expires_at),
  lastUsedAt: r.last_used_at === null ? null : Number(r.last_used_at),
  revokedAt: r.revoked_at === null ? null : Number(r.revoked_at),
});

export function validateTokenInput(input: Record<string, unknown>): { name: string; access: TokenAccess; projects: string[] | null; days: number } {
  const name = typeof input.name === "string" ? input.name.normalize("NFKC").replace(/\s+/g, " ").trim() : "";
  if (name.length < 1 || name.length > 64 || /[\p{C}]/u.test(name)) throw new AuthError(400, "FK_TOKEN_INVALID", "Give the token a name of 1 to 64 characters.");
  if (input.access !== "read" && input.access !== "write") throw new AuthError(400, "FK_TOKEN_INVALID", "Access must be read or write.");
  let projects: string[] | null = null;
  if (input.projects !== null && input.projects !== undefined) {
    if (!Array.isArray(input.projects) || input.projects.length < 1 || input.projects.length > 100 || input.projects.some((p) => typeof p !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(p))) {
      throw new AuthError(400, "FK_TOKEN_INVALID", "Projects must be null (all projects) or a list of project IDs.");
    }
    projects = [...new Set(input.projects as string[])];
  }
  const days = input.expiresInDays === undefined ? TOKEN_DEFAULT_DAYS : input.expiresInDays;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > TOKEN_MAX_DAYS) throw new AuthError(400, "FK_TOKEN_INVALID", `Choose a lifetime of 1 to ${TOKEN_MAX_DAYS} days.`);
  return { name, access: input.access, projects, days };
}

/** Creates a token. The plain token is in the result and nowhere else, ever. */
export async function createApiToken(env: Env, input: { accountId: string; name: string; access: TokenAccess; projects: string[] | null; days: number; now?: number }): Promise<{ token: string; row: ApiTokenRow }> {
  const now = input.now ?? Date.now();
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM api_tokens WHERE account_id = ?1 AND revoked_at IS NULL AND expires_at > ?2").bind(input.accountId, now).first<{ n: number }>();
  if (Number(count?.n ?? 0) >= MAX_TOKENS_PER_ACCOUNT) throw new AuthError(409, "FK_TOKEN_LIMIT", `An account can hold ${MAX_TOKENS_PER_ACCOUNT} active tokens. Revoke one first.`);
  const token = TOKEN_PREFIX + randomB64url(32);
  const id = crypto.randomUUID();
  const prefix = token.slice(0, TOKEN_PREFIX.length + 6);
  const expiresAt = now + input.days * 86_400_000;
  await env.DB.prepare("INSERT INTO api_tokens (id, token_hash, prefix, name, account_id, access, projects, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)")
    .bind(id, await sha256Hex(token), prefix, input.name, input.accountId, input.access, input.projects ? JSON.stringify(input.projects) : null, now, expiresAt)
    .run();
  return { token, row: { id, prefix, name: input.name, accountId: input.accountId, access: input.access, projects: input.projects, createdAt: now, expiresAt, lastUsedAt: null, revokedAt: null } };
}

export async function listApiTokens(env: Env): Promise<Array<ApiTokenRow & { createdByName: string | null }>> {
  const rows = await env.DB.prepare(
    `SELECT t.id, t.prefix, t.name, t.account_id, t.access, t.projects, t.created_at, t.expires_at, t.last_used_at, t.revoked_at, a.name AS created_by
     FROM api_tokens t LEFT JOIN accounts a ON a.id = t.account_id ORDER BY t.created_at DESC, t.id`,
  ).all<Raw & { created_by: string | null }>();
  return (rows.results ?? []).map((r) => ({ ...toRow(r), createdByName: r.created_by }));
}

export async function revokeApiToken(env: Env, id: string, now = Date.now()): Promise<void> {
  const res = await env.DB.prepare("UPDATE api_tokens SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL").bind(id, now).run();
  if (res.meta?.changes) return;
  const exists = await env.DB.prepare("SELECT id FROM api_tokens WHERE id = ?1").bind(id).first();
  if (!exists) throw new AuthError(404, "FK_TOKEN_NOT_FOUND", "No such token.");
}

export type TokenLookup = { ok: true; token: ApiTokenRow } | { ok: false; reason: "unknown" | "revoked" | "expired" | "account" };

/** Looks a presented token up by its hash. Nothing is cached, so a revocation counts from the next request. */
export async function lookupApiToken(env: Env, presented: string, now = Date.now()): Promise<TokenLookup> {
  if (!presented.startsWith(TOKEN_PREFIX) || presented.length > 128) return { ok: false, reason: "unknown" };
  const row = await env.DB.prepare(
    `SELECT t.id, t.prefix, t.name, t.account_id, t.access, t.projects, t.created_at, t.expires_at, t.last_used_at, t.revoked_at, a.state AS account_state
     FROM api_tokens t LEFT JOIN accounts a ON a.id = t.account_id WHERE t.token_hash = ?1`,
  )
    .bind(await sha256Hex(presented))
    .first<Raw & { account_state: string | null }>();
  if (!row) return { ok: false, reason: "unknown" };
  if (row.revoked_at !== null) return { ok: false, reason: "revoked" };
  if (Number(row.expires_at) <= now) return { ok: false, reason: "expired" };
  if (row.account_state !== "active") return { ok: false, reason: "account" };
  if (row.last_used_at === null || now - Number(row.last_used_at) > TOUCH_AFTER_MS) {
    await env.DB.prepare("UPDATE api_tokens SET last_used_at = ?1 WHERE id = ?2").bind(now, row.id).run().catch(() => {});
  }
  return { ok: true, token: toRow(row) };
}
