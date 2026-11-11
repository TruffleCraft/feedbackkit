import type { Env } from "../env.js";

export type Role = "owner" | "member";
export type AccountState = "invited" | "active" | "removed";

export interface Account {
  id: string;
  name: string;
  role: Role;
  state: AccountState;
  createdAt: number;
  lastSeenAt: number | null;
}

interface AccountRow {
  id: string;
  name: string;
  role: Role;
  state: AccountState;
  created_at: number;
  last_seen_at: number | null;
}

const toAccount = (r: AccountRow): Account => ({ id: r.id, name: r.name, role: r.role, state: r.state, createdAt: Number(r.created_at), lastSeenAt: r.last_seen_at === null ? null : Number(r.last_seen_at) });

/** An error that carries the HTTP status and the stable code from docs/ERRORS.md. */
export class AuthError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 429 | 503,
    public readonly code: string,
    message: string,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

// Once the first owner exists ADMIN_TOKEN grants nothing, so the check runs on
// every request that presents a bearer value other than an API token. It is one
// indexed read of a one-row table; nothing is cached, so a restored or reset
// database is never judged by an old answer. A missing table (migration 0005 not
// applied yet) means no owner. Any other failure counts as "an owner exists": the
// legacy ADMIN_TOKEN must never be accepted because the check could not run.
export async function ownerExists(env: Env): Promise<boolean> {
  try {
    return Boolean(await env.DB.prepare("SELECT singleton FROM owner_claim LIMIT 1").first<{ singleton: number }>());
  } catch (e) {
    return !/no such table/i.test(String((e as Error)?.message));
  }
}

/** Names are NFKC-normalized, trimmed, single-spaced, 1 to 64 characters, no control characters. */
export function cleanName(raw: unknown): string {
  if (typeof raw !== "string") throw new AuthError(400, "FK_NAME_INVALID", "Enter a name of 1 to 64 characters.");
  const name = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (name.length < 1 || name.length > 64 || /[\p{C}]/u.test(name)) throw new AuthError(400, "FK_NAME_INVALID", "Enter a name of 1 to 64 characters, without control characters.");
  return name;
}

export const nameKey = (name: string): string => name.toLowerCase();

export async function getAccount(env: Env, id: string): Promise<Account | null> {
  const row = await env.DB.prepare("SELECT id, name, role, state, created_at, last_seen_at FROM accounts WHERE id = ?1").bind(id).first<AccountRow>();
  return row ? toAccount(row) : null;
}

export async function findLiveAccountByName(env: Env, name: string): Promise<Account | null> {
  const row = await env.DB.prepare("SELECT id, name, role, state, created_at, last_seen_at FROM accounts WHERE name_key = ?1 AND state != 'removed'").bind(nameKey(name)).first<AccountRow>();
  return row ? toAccount(row) : null;
}

export interface AccountListItem extends Account {
  removedAt: number | null;
  passkeys: number;
  /** An open invitation or recovery link: when it expires. */
  linkExpiresAt: number | null;
}

export async function listAccounts(env: Env, now = Date.now(), includeRemoved = false): Promise<AccountListItem[]> {
  const rows = await env.DB.prepare(
    `SELECT a.id, a.name, a.role, a.state, a.created_at, a.last_seen_at, a.removed_at,
            (SELECT COUNT(*) FROM passkeys p WHERE p.account_id = a.id) AS passkeys,
            (SELECT MAX(l.expires_at) FROM setup_links l WHERE l.account_id = a.id AND l.used_at IS NULL AND l.expires_at > ?1) AS link_expires_at
     FROM accounts a WHERE (a.state != 'removed' OR ?2 = 1) ORDER BY (a.state = 'removed'), a.created_at, a.id`,
  )
    .bind(now, includeRemoved ? 1 : 0)
    .all<AccountRow & { removed_at: number | null; passkeys: number; link_expires_at: number | null }>();
  return (rows.results ?? []).map((r) => ({ ...toAccount(r), removedAt: r.removed_at === null ? null : Number(r.removed_at), passkeys: Number(r.passkeys), linkExpiresAt: r.link_expires_at === null ? null : Number(r.link_expires_at) }));
}

/** Creates an account that has no passkey yet. The invitation link comes from links.ts. */
export async function createInvitedAccount(env: Env, input: { name: string; role: Role; createdBy: string | null; now?: number }): Promise<Account> {
  const id = crypto.randomUUID();
  const now = input.now ?? Date.now();
  try {
    await env.DB.prepare("INSERT INTO accounts (id, name, name_key, role, state, created_at, created_by) VALUES (?1, ?2, ?3, ?4, 'invited', ?5, ?6)")
      .bind(id, input.name, nameKey(input.name), input.role, now, input.createdBy)
      .run();
  } catch (e) {
    if (/UNIQUE/i.test(String((e as Error)?.message))) throw new AuthError(409, "FK_ACCOUNT_EXISTS", "An account with this name exists. Choose another name.");
    throw e;
  }
  return { id, name: input.name, role: input.role, state: "invited", createdAt: now, lastSeenAt: null };
}

// The last-owner rule as one statement each. Statements are atomic on SQLite and
// on D1, so two owners who demote or remove each other at the same moment cannot
// both succeed: the second one sees that no other active owner is left.
const OTHER_ACTIVE_OWNER = "(SELECT COUNT(*) FROM accounts o WHERE o.role = 'owner' AND o.state = 'active' AND o.id != ?1) >= 1";

export async function changeRole(env: Env, id: string, role: Role): Promise<Account> {
  const res =
    role === "member"
      ? await env.DB.prepare(`UPDATE accounts SET role = 'member' WHERE id = ?1 AND role = 'owner' AND state != 'removed' AND (state != 'active' OR ${OTHER_ACTIVE_OWNER})`).bind(id).run()
      : await env.DB.prepare("UPDATE accounts SET role = 'owner' WHERE id = ?1 AND role = 'member' AND state != 'removed'").bind(id).run();
  const account = await getAccount(env, id);
  if (!account || account.state === "removed") throw new AuthError(404, "FK_ACCOUNT_NOT_FOUND", "No such account.");
  if (!res.meta?.changes) {
    if (account.role === role) return account;
    throw new AuthError(409, "FK_LAST_OWNER", "This is the last owner. Make someone else an owner first.");
  }
  return account;
}

export async function removeAccount(env: Env, id: string, now = Date.now()): Promise<void> {
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE accounts SET state = 'removed', removed_at = ?2
       WHERE id = ?1 AND state != 'removed' AND (role != 'owner' OR state != 'active' OR ${OTHER_ACTIVE_OWNER})`,
    ).bind(id, now),
    env.DB.prepare("DELETE FROM sessions WHERE account_id = ?1 AND EXISTS (SELECT 1 FROM accounts WHERE id = ?1 AND state = 'removed')").bind(id),
    env.DB.prepare("DELETE FROM passkeys WHERE account_id = ?1 AND EXISTS (SELECT 1 FROM accounts WHERE id = ?1 AND state = 'removed')").bind(id),
    env.DB.prepare("UPDATE api_tokens SET revoked_at = ?2 WHERE account_id = ?1 AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM accounts WHERE id = ?1 AND state = 'removed')").bind(id, now),
    env.DB.prepare("DELETE FROM setup_links WHERE account_id = ?1 AND used_at IS NULL AND EXISTS (SELECT 1 FROM accounts WHERE id = ?1 AND state = 'removed')").bind(id),
  ]);
  if (results[0]?.meta?.changes) return;
  const account = await getAccount(env, id);
  if (!account || account.state === "removed") throw new AuthError(404, "FK_ACCOUNT_NOT_FOUND", "No such account.");
  throw new AuthError(409, "FK_LAST_OWNER", "This is the last owner. Make someone else an owner first.");
}
