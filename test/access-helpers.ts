// Test helpers for Cloudflare Access JWTs: a locally generated RSA key pair, a
// signer and a stand-in for the team JWKS endpoint. Nothing here talks to
// Cloudflare.

export const TEAM = "https://acme-team.cloudflareaccess.com";
export const AUD = "4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2";
export const CERTS_URL = `${TEAM}/cdn-cgi/access/certs`;

export interface TestKey {
  kid: string;
  privateKey: CryptoKey;
  jwk: JsonWebKey & { kid: string };
}

export async function makeKey(kid: string): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { kid, privateKey: pair.privateKey, jwk: { kty: "RSA", n: pub.n, e: pub.e, alg: "RS256", use: "sig", kid } };
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64json = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)));

export function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    aud: [AUD],
    email: "dana@example.com",
    exp: now + 600,
    iat: now,
    nbf: now,
    iss: TEAM,
    type: "app",
    identity_nonce: "6ei69kawdKzMIAPF",
    sub: "7335d417-61da-459d-899c-0a01c76a2f94",
    country: "DE",
    ...over,
  };
}

export async function signJwt(key: TestKey, payload: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
  const h = b64json({ alg: "RS256", kid: key.kid, typ: "JWT", ...header });
  const p = b64json(payload);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
}

/**
 * A fetch stand-in that serves the given keys at the team's certs URL (in the
 * shape Access publishes) and counts the calls. `keys` is read on every call, so
 * a test can rotate keys by mutating the array. Other URLs go to `fallback`.
 */
export function jwksFetch(keys: TestKey[], fallback?: (url: string) => Promise<Response>) {
  const calls: string[] = [];
  const fn = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === CERTS_URL) {
      calls.push(url);
      return new Response(JSON.stringify({ keys: keys.map((k) => k.jwk), public_cert: { kid: keys[0]?.kid, cert: "-----BEGIN CERTIFICATE----- ..." } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (fallback) return fallback(url);
    return new Response("not found", { status: 404 });
  };
  return { fn, calls };
}
