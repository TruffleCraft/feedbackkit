import type { Env } from "../env.js";
import { b64urlToBytes, bytesToB64url, hmacSha256, timingSafeEqual } from "./crypto.js";
import { storedInstanceSecret } from "../security/secret.js";

// WebAuthn challenges without a table. A challenge is 56 bytes: 16 random bytes
// (the nonce), the expiry as 8 bytes, and an HMAC-SHA256 over nonce, expiry,
// purpose and subject, keyed with the instance secret. The server keeps nothing
// when it hands one out, so a flood of "begin" requests cannot fill the
// database or push a real visitor's challenge out. A challenge is single-use:
// the batch that completes a ceremony inserts its nonce into `used_challenges`,
// and a second use fails on the primary key.
//
// Why not the textbook "store the challenge": the library asks for a function
// as `expectedChallenge` exactly so that this is possible, and a stored challenge
// would need a per-address limit on the begin routes, which is the shared-address
// problem the account system must not have (a valid login is never blocked by
// other people's requests).

export type ChallengePurpose = "signin" | "setup" | "passkey-add";

export const CHALLENGE_TTL_MS = 5 * 60_000;
const MAC_BYTES = 32;

function expiryBytes(ms: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(ms));
  return out;
}

async function mac(secret: string, purpose: string, subject: string, nonceAndExpiry: Uint8Array): Promise<Uint8Array> {
  const head = new TextEncoder().encode(`fk-challenge-v1|${purpose}|${subject}|`);
  const msg = new Uint8Array(head.length + nonceAndExpiry.length);
  msg.set(head);
  msg.set(nonceAndExpiry, head.length);
  return hmacSha256(secret, msg);
}

/** Throws when the store cannot provide the instance secret: a challenge must never be signed with a guessable key. */
export async function makeChallenge(env: Env, purpose: ChallengePurpose, subject: string, now = Date.now()): Promise<Uint8Array<ArrayBuffer>> {
  const secret = await storedInstanceSecret(env);
  if (!secret) throw new Error("instance secret unavailable");
  const body = new Uint8Array(24);
  body.set(crypto.getRandomValues(new Uint8Array(16)));
  body.set(expiryBytes(now + CHALLENGE_TTL_MS), 16);
  const out = new Uint8Array(24 + MAC_BYTES);
  out.set(body);
  out.set(await mac(secret, purpose, subject, body), 24);
  return out;
}

export interface CheckedChallenge {
  /** base64url of the 16 random bytes: what `used_challenges` records. */
  nonce: string;
  expiresAt: number;
}

/** Verifies signature, purpose, subject and expiry. Returns null for anything else. */
export async function checkChallenge(env: Env, challenge: string, purpose: ChallengePurpose, subject: string, now = Date.now()): Promise<CheckedChallenge | null> {
  let bytes: Uint8Array;
  try {
    bytes = b64urlToBytes(challenge);
  } catch {
    return null;
  }
  if (bytes.length !== 24 + MAC_BYTES) return null;
  const secret = await storedInstanceSecret(env);
  if (!secret) return null;
  const body = bytes.slice(0, 24);
  const expected = await mac(secret, purpose, subject, body);
  if (!timingSafeEqual(bytesToB64url(expected), bytesToB64url(bytes.slice(24)))) return null;
  const expiresAt = Number(new DataView(body.buffer, body.byteOffset, body.byteLength).getBigUint64(16));
  if (!(expiresAt > now)) return null;
  return { nonce: bytesToB64url(body.slice(0, 16)), expiresAt };
}
