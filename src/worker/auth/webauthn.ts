import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { Env } from "../env.js";
import { AuthError } from "./accounts.js";
import { checkChallenge, makeChallenge, type CheckedChallenge, type ChallengePurpose } from "./challenge.js";
import { b64urlToBytes, bytesToB64url } from "./crypto.js";

// The WebAuthn ceremonies. The protocol (CBOR, COSE keys, attestation and
// assertion checks, counters) is @simplewebauthn/server. This file chooses the
// options and ties the library's challenge hook to challenge.ts.
//
// Policy, and why:
//   - discoverable credentials and user verification are required: the sign-in
//     page has no username field, and a stolen security key without its PIN is
//     not enough to open the admin;
//   - attestation "none": the gateway has no reason to ask which authenticator
//     a person owns;
//   - ES256, EdDSA and RS256 only, for registration and verification alike. The
//     library's default adds a post-quantum algorithm where the runtime supports
//     it, and a credential made on one runtime must verify on the other;
//   - RP ID and origin come from FK_PUBLIC_URL when set (Worker) and otherwise
//     from the request URL, which the standalone server builds from its
//     FK_PUBLIC_URL, never from the Host header.

const ALGORITHMS = [-7, -8, -257];
const RP_NAME = "FeedbackKit";

export function relyingParty(env: Env, request: Request): { rpID: string; origin: string } {
  const configured = typeof env["FK_PUBLIC_URL"] === "string" && env["FK_PUBLIC_URL"] ? new URL(env["FK_PUBLIC_URL"] as string) : new URL(request.url);
  return { rpID: configured.hostname, origin: configured.origin };
}

export async function registrationOptions(
  env: Env,
  request: Request,
  input: { purpose: Extract<ChallengePurpose, "setup" | "passkey-add">; subject: string; accountId: string; userName: string; exclude: string[] },
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const { rpID } = relyingParty(env, request);
  return generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: input.userName,
    userDisplayName: input.userName,
    userID: new TextEncoder().encode(input.accountId) as Uint8Array<ArrayBuffer>,
    challenge: await makeChallenge(env, input.purpose, input.subject).catch(unavailable),
    timeout: 120_000,
    attestationType: "none",
    excludeCredentials: input.exclude.map((id) => ({ id })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    supportedAlgorithmIDs: ALGORITHMS,
  });
}

export interface VerifiedRegistration {
  credentialId: string;
  publicKey: string; // base64url COSE key
  counter: number;
  transports: string[] | null;
  deviceType: string;
  backedUp: boolean;
  challenge: CheckedChallenge;
}

export async function verifyRegistration(
  env: Env,
  request: Request,
  response: RegistrationResponseJSON,
  input: { purpose: Extract<ChallengePurpose, "setup" | "passkey-add">; subject: string },
): Promise<VerifiedRegistration> {
  const { rpID, origin } = relyingParty(env, request);
  let challenge: CheckedChallenge | null = null;
  try {
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge: async (c) => {
        challenge = await checkChallenge(env, c, input.purpose, input.subject);
        return challenge !== null;
      },
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserPresence: true,
      requireUserVerification: true,
      supportedAlgorithmIDs: ALGORITHMS,
    });
    if (!result.verified || !challenge) throw new Error("not verified");
    const info = result.registrationInfo;
    return {
      credentialId: info.credential.id,
      publicKey: bytesToB64url(info.credential.publicKey),
      counter: info.credential.counter,
      transports: info.credential.transports && info.credential.transports.length ? [...info.credential.transports] : null,
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
      challenge,
    };
  } catch {
    throw new AuthError(400, "FK_PASSKEY_REJECTED", "The passkey could not be verified. Try again.");
  }
}

export async function authenticationOptions(env: Env, request: Request): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const { rpID } = relyingParty(env, request);
  return generateAuthenticationOptions({
    rpID,
    userVerification: "required",
    timeout: 120_000,
    challenge: await makeChallenge(env, "signin", "").catch(unavailable),
  });
}

export interface StoredPasskey {
  id: string;
  accountId: string;
  publicKey: string;
  counter: number;
  transports: string[] | null;
}

export async function verifyAuthentication(
  env: Env,
  request: Request,
  response: AuthenticationResponseJSON,
  stored: StoredPasskey,
): Promise<{ newCounter: number; challenge: CheckedChallenge }> {
  const { rpID, origin } = relyingParty(env, request);
  let challenge: CheckedChallenge | null = null;
  try {
    // A discoverable credential also returns the user handle it was created with. When it is there it must be this account's.
    const handle = response.response.userHandle;
    if (handle && new TextDecoder().decode(b64urlToBytes(handle)) !== stored.accountId) throw new Error("user handle mismatch");
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: async (c) => {
        challenge = await checkChallenge(env, c, "signin", "");
        return challenge !== null;
      },
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: { id: stored.id, publicKey: b64urlToBytes(stored.publicKey), counter: stored.counter, transports: (stored.transports ?? undefined) as never },
      requireUserVerification: true,
    });
    if (!result.verified || !challenge) throw new Error("not verified");
    return { newCounter: result.authenticationInfo.newCounter, challenge };
  } catch {
    throw new AuthError(401, "FK_SIGNIN_FAILED", "Sign-in failed. Use a passkey registered for this site.");
  }
}

function unavailable(): never {
  throw new AuthError(503, "FK_AUTH_UNAVAILABLE", "Sign-in is not available right now because the storage could not be reached. Try again in a moment.");
}
