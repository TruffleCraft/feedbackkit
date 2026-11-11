import type { Env } from "../env.js";
import { AuthError, type Account, type Role } from "./accounts.js";
import { randomB64url, sha256Hex } from "./crypto.js";
import { insertSessionStatement, mintSession, type NewSession } from "./sessions.js";
import type { VerifiedRegistration } from "./webauthn.js";
import type { LinkRow } from "./links.js";

// The writes that finish a ceremony. Each one is a single env.DB.batch() (one
// transaction on D1 and on SQLite) whose statements are guarded so that they
// only act for the attempt that won. The design, and why it holds on D1 without
// an interactive transaction, is in docs/design/gate2-accounts.md.
//
//   claim stamp   A conditional UPDATE writes this attempt's random stamp into
//                 setup_links.used_by. Only one attempt can make that UPDATE
//                 change a row. Every later statement of the batch names the
//                 stamp in an EXISTS guard, so for a losing attempt they all do
//                 nothing.
//   arbiter       Only the bootstrap has one: owner_claim has a single-row
//                 primary key, so a second owner claim raises a constraint
//                 error. An error aborts the batch and rolls back its earlier
//                 statements (D1: "batched statements are SQL transactions").
//   replay        The first statement records the challenge's nonce. A second use
//                 of the same challenge fails on that primary key.

const passkeyColumns = "id, account_id, public_key, counter, transports, device_type, backed_up, name, created_at, last_used_at";

function insertPasskey(env: Env, reg: VerifiedRegistration, accountId: string, name: string, now: number, guardSql: string, guardParams: unknown[]) {
  return env.DB.prepare(
    `INSERT INTO passkeys (${passkeyColumns})
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL WHERE ${guardSql}`,
  ).bind(reg.credentialId, accountId, reg.publicKey, reg.counter, reg.transports ? JSON.stringify(reg.transports) : null, reg.deviceType, reg.backedUp ? 1 : 0, name, now, ...guardParams);
}

const claimNonce = (env: Env, reg: VerifiedRegistration) => env.DB.prepare("INSERT INTO used_challenges (nonce, expires_at) VALUES (?1, ?2)").bind(reg.challenge.nonce, reg.challenge.expiresAt);

function mapConstraint(e: unknown): never {
  const message = String((e as Error)?.message ?? e);
  if (/owner_claim/i.test(message)) throw new AuthError(409, "FK_OWNER_EXISTS", "This instance already has an owner.");
  if (/used_challenges/i.test(message)) throw new AuthError(400, "FK_PASSKEY_REJECTED", "This sign-in request was already used. Start again.");
  if (/passkeys/i.test(message)) throw new AuthError(409, "FK_PASSKEY_EXISTS", "This passkey is already registered.");
  if (/accounts/i.test(message)) throw new AuthError(409, "FK_ACCOUNT_EXISTS", "A user with this name exists.");
  throw e;
}

export interface Enrolled {
  account: Pick<Account, "id" | "name" | "role">;
  session: NewSession;
  /** Recovery only: how many API tokens of the account were revoked. */
  tokensRevoked: number;
}

export function defaultPasskeyName(now: number): string {
  return `Passkey ${new Date(now).toISOString().slice(0, 10)}`;
}

/** The first owner: claims the owner slot, creates the account with its first passkey and opens a session. */
export async function completeBootstrap(env: Env, input: { link: LinkRow; accountId: string; name: string; nameKey: string; registration: VerifiedRegistration; passkeyName: string; userAgent: string | null; now?: number }): Promise<Enrolled> {
  const now = input.now ?? Date.now();
  const stamp = randomB64url(16);
  const session = await mintSession(now);
  const ours = "EXISTS (SELECT 1 FROM setup_links WHERE id = ?1 AND used_by = ?2)";
  const credential = input.registration.credentialId;
  let results: D1Result[] = [];
  try {
    results = await env.DB.batch([
      claimNonce(env, input.registration),
      env.DB.prepare("UPDATE setup_links SET used_at = ?3, used_by = ?2 WHERE id = ?1 AND purpose = 'bootstrap' AND used_at IS NULL AND expires_at > ?3").bind(input.link.id, stamp, now),
      env.DB.prepare(`INSERT INTO owner_claim (singleton, account_id, claimed_at) SELECT 1, ?3, ?4 WHERE ${ours}`).bind(input.link.id, stamp, input.accountId, now),
      env.DB.prepare("INSERT INTO accounts (id, name, name_key, role, state, created_at, created_by, last_seen_at) SELECT ?1, ?2, ?3, 'owner', 'active', ?4, 'setup-link', ?4 WHERE EXISTS (SELECT 1 FROM owner_claim WHERE singleton = 1 AND account_id = ?1)").bind(input.accountId, input.name, input.nameKey, now),
      insertPasskey(env, input.registration, input.accountId, input.passkeyName, now, "EXISTS (SELECT 1 FROM accounts WHERE id = ?10 AND role = 'owner' AND state = 'active')", [input.accountId]),
      insertSessionStatement(env, session, input.accountId, now, input.userAgent, "EXISTS (SELECT 1 FROM passkeys WHERE id = ?7 AND account_id = ?3)", [credential]),
    ]);
  } catch (e) {
    mapConstraint(e);
  }
  if (!results[1]?.meta?.changes) throw new AuthError(410, "FK_SETUP_LINK_INVALID", "This link was already used or has expired. Ask for a new one.");
  if (!results[5]?.meta?.changes) throw new AuthError(409, "FK_OWNER_EXISTS", "This instance already has an owner.");
  return { account: { id: input.accountId, name: input.name, role: "owner" }, session, tokensRevoked: 0 };
}

/**
 * Recovery and invitation: marks the link used, replaces the passkeys (recovery
 * only), revokes every session of the account, stores the new passkey, activates
 * the account and opens a session.
 */
export async function completeLinked(env: Env, input: { link: LinkRow; account: Pick<Account, "id" | "name" | "role">; registration: VerifiedRegistration; passkeyName: string; userAgent: string | null; now?: number }): Promise<Enrolled> {
  const now = input.now ?? Date.now();
  const stamp = randomB64url(16);
  const session = await mintSession(now);
  const ours = "EXISTS (SELECT 1 FROM setup_links WHERE id = ?1 AND used_by = ?2)";
  const accountId = input.account.id;
  const credential = input.registration.credentialId;
  const recovery = input.link.purpose === "recovery";
  const steps: Array<[string, D1PreparedStatement]> = [
    ["nonce", claimNonce(env, input.registration)],
    ["link", env.DB.prepare("UPDATE setup_links SET used_at = ?3, used_by = ?2 WHERE id = ?1 AND account_id = ?4 AND used_at IS NULL AND expires_at > ?3").bind(input.link.id, stamp, now, accountId)],
    ["sessions", env.DB.prepare(`DELETE FROM sessions WHERE account_id = ?3 AND ${ours}`).bind(input.link.id, stamp, accountId)],
  ];
  if (recovery) {
    steps.push(["replace", env.DB.prepare(`DELETE FROM passkeys WHERE account_id = ?3 AND ${ours}`).bind(input.link.id, stamp, accountId)]);
    // Recovery is also the path after a lost or exposed credential, so the tokens that account created end with it
    // (the owner makes new ones afterwards). `--keep-tokens` on the host command opts out.
    steps.push(["tokens", env.DB.prepare(`UPDATE api_tokens SET revoked_at = ?4 WHERE account_id = ?3 AND revoked_at IS NULL AND ${ours} AND NOT EXISTS (SELECT 1 FROM setup_links WHERE id = ?1 AND keep_tokens = 1)`).bind(input.link.id, stamp, accountId, now)]);
  }
  steps.push(
    ["passkey", insertPasskey(env, input.registration, accountId, input.passkeyName, now, `${ours.replace("?1", "?10").replace("?2", "?11")} AND EXISTS (SELECT 1 FROM accounts WHERE id = ?12 AND state IN ('invited', 'active'))`, [input.link.id, stamp, accountId])],
    ["activate", env.DB.prepare("UPDATE accounts SET state = 'active', last_seen_at = ?2 WHERE id = ?1 AND state IN ('invited', 'active') AND EXISTS (SELECT 1 FROM passkeys WHERE id = ?3 AND account_id = ?1)").bind(accountId, now, credential)],
    ["session", insertSessionStatement(env, session, accountId, now, input.userAgent, "EXISTS (SELECT 1 FROM passkeys WHERE id = ?7 AND account_id = ?3)", [credential])],
  );
  let results: D1Result[] = [];
  try {
    results = await env.DB.batch(steps.map(([, s]) => s));
  } catch (e) {
    mapConstraint(e);
  }
  const at = (name: string) => results[steps.findIndex(([n]) => n === name)]?.meta?.changes ?? 0;
  if (!at("link")) throw new AuthError(410, "FK_SETUP_LINK_INVALID", "This link was already used or has expired. Ask for a new one.");
  if (!at("session")) throw new AuthError(409, "FK_ACCOUNT_STATE", "This account was removed. Ask an owner for a new invitation.");
  return { account: input.account, session, tokensRevoked: at("tokens") };
}

/** A signed-in person adds another passkey to their own account. */
export async function addPasskey(env: Env, input: { accountId: string; registration: VerifiedRegistration; passkeyName: string; now?: number }): Promise<void> {
  const now = input.now ?? Date.now();
  let results: D1Result[] = [];
  try {
    results = await env.DB.batch([claimNonce(env, input.registration), insertPasskey(env, input.registration, input.accountId, input.passkeyName, now, "EXISTS (SELECT 1 FROM accounts WHERE id = ?10 AND state = 'active')", [input.accountId])]);
  } catch (e) {
    mapConstraint(e);
  }
  if (!results[1]?.meta?.changes) throw new AuthError(409, "FK_ACCOUNT_STATE", "This account is not active.");
}

/** A verified assertion: counts the passkey use, opens a session. Fails when the account was removed in between. */
export async function completeSignIn(env: Env, input: { passkeyId: string; accountId: string; newCounter: number; challenge: { nonce: string; expiresAt: number }; userAgent: string | null; now?: number }): Promise<NewSession> {
  const now = input.now ?? Date.now();
  const session = await mintSession(now);
  let results: D1Result[] = [];
  try {
    results = await env.DB.batch([
      env.DB.prepare("INSERT INTO used_challenges (nonce, expires_at) VALUES (?1, ?2)").bind(input.challenge.nonce, input.challenge.expiresAt),
      env.DB.prepare("UPDATE passkeys SET counter = ?2, last_used_at = ?3 WHERE id = ?1 AND counter <= ?2").bind(input.passkeyId, input.newCounter, now),
      insertSessionStatement(env, session, input.accountId, now, input.userAgent, "EXISTS (SELECT 1 FROM passkeys p JOIN accounts a ON a.id = p.account_id WHERE p.id = ?7 AND a.state = 'active')", [input.passkeyId]),
      env.DB.prepare("UPDATE accounts SET last_seen_at = ?2 WHERE id = ?1 AND state = 'active'").bind(input.accountId, now),
    ]);
  } catch (e) {
    // The same assertion presented twice: the nonce is already in used_challenges.
    if (/used_challenges/i.test(String((e as Error)?.message))) throw new AuthError(401, "FK_SIGNIN_FAILED", "Sign-in failed. Start the sign-in again.");
    mapConstraint(e);
  }
  if (!results[2]?.meta?.changes) throw new AuthError(401, "FK_SIGNIN_FAILED", "Sign-in failed. Use a passkey registered for this site.");
  return session;
}

export type { Role };
export const bootstrapAccountId = async (linkId: string): Promise<string> => {
  // Deterministic per link, so "begin" (the passkey's user handle) and "finish" (the account row) agree without state.
  const h = await sha256Hex(`fk-bootstrap-account:${linkId}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
