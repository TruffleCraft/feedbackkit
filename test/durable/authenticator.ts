// A software WebAuthn authenticator for tests: what a browser and a passkey
// provider send to the server, built with WebCrypto only so it runs in workerd
// and on Node. It makes registration responses (attestation "none", ES256) and
// assertions with the flags and counters a real authenticator sets. Tests use it
// to drive the real server code with real signatures, and to break them in
// exactly one place at a time. A real browser with a virtual authenticator
// covers the other side (e2e/accounts-real-server.spec.ts).

const enc = new TextEncoder();

export const b64u = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const unb64u = (text: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

// Just enough CBOR: unsigned and negative integers, byte and text strings, maps.
function cbor(value: unknown): Uint8Array {
  const head = (major: number, n: number): number[] => {
    if (n < 24) return [(major << 5) | n];
    if (n < 256) return [(major << 5) | 24, n];
    if (n < 65536) return [(major << 5) | 25, n >> 8, n & 255];
    throw new Error("cbor: value too large for this helper");
  };
  const concat = (parts: Array<Uint8Array | number[]>) => Uint8Array.from(parts.flatMap((p) => [...p]));
  if (typeof value === "number") return Uint8Array.from(value >= 0 ? head(0, value) : head(1, -1 - value));
  if (typeof value === "string") {
    const b = enc.encode(value);
    return concat([head(3, b.length), b]);
  }
  if (value instanceof Uint8Array) return concat([head(2, value.length), value]);
  if (value instanceof Map) return concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
  throw new Error("cbor: unsupported value");
}

const sha256 = async (data: Uint8Array): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));

/** WebCrypto signs ECDSA as r || s; WebAuthn wants a DER SEQUENCE of two INTEGERs. */
function derFromRaw(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const v = b.slice(i);
    const body = v[0]! & 0x80 ? Uint8Array.from([0, ...v]) : v;
    return Uint8Array.from([0x02, body.length, ...body]);
  };
  const r = int(raw.slice(0, 32));
  const s = int(raw.slice(32));
  return Uint8Array.from([0x30, r.length + s.length, ...r, ...s]);
}

export interface CreationOptions {
  challenge: string;
  rp: { id?: string };
  user: { id: string; name: string };
}
export interface RequestOptions {
  challenge: string;
  rpId?: string;
}

export interface Tamper {
  /** Origin written into clientDataJSON (default: the authenticator's). */
  origin?: string;
  /** Leave the user-verified flag out. */
  noUserVerification?: boolean;
  /** Flip a bit in the signature. */
  badSignature?: boolean;
  /** Use this counter instead of the next one. */
  counter?: number;
  /** Replace the challenge in clientDataJSON. */
  challenge?: string;
  /** Omit the user handle in an assertion. */
  noUserHandle?: boolean;
  /** Use this user handle in an assertion. */
  userHandle?: string;
}

export class SoftAuthenticator {
  counter = 0;
  userHandle: string | null = null;

  private constructor(
    readonly rpId: string,
    readonly origin: string,
    readonly credentialId: Uint8Array,
    private readonly keys: CryptoKeyPair,
    private readonly publicJwk: JsonWebKey,
  ) {}

  static async create(origin = "http://localhost"): Promise<SoftAuthenticator> {
    const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    return new SoftAuthenticator(new URL(origin).hostname, origin, crypto.getRandomValues(new Uint8Array(32)), keys, (await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey);
  }

  get id(): string {
    return b64u(this.credentialId);
  }

  private clientData(type: "webauthn.create" | "webauthn.get", challenge: string, tamper: Tamper): Uint8Array {
    return enc.encode(JSON.stringify({ type, challenge: tamper.challenge ?? challenge, origin: tamper.origin ?? this.origin, crossOrigin: false }));
  }

  async register(options: CreationOptions, tamper: Tamper = {}) {
    this.userHandle = options.user.id;
    const x = unb64u(this.publicJwk.x!);
    const y = unb64u(this.publicJwk.y!);
    const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, x], [-3, y]]));
    const flags = 0x01 | (tamper.noUserVerification ? 0 : 0x04) | 0x40; // user present, user verified, attested credential data
    const counter = tamper.counter ?? this.counter;
    const authData = Uint8Array.from([
      ...(await sha256(enc.encode(options.rp.id ?? this.rpId))),
      flags,
      ...new Uint8Array(new Uint32Array([counter]).buffer).reverse(),
      ...new Uint8Array(16),
      this.credentialId.length >> 8,
      this.credentialId.length & 255,
      ...this.credentialId,
      ...cose,
    ]);
    const attestationObject = cbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key" as const,
      response: { clientDataJSON: b64u(this.clientData("webauthn.create", options.challenge, tamper)), attestationObject: b64u(attestationObject), transports: ["internal" as const] },
      clientExtensionResults: {},
      authenticatorAttachment: "platform" as const,
    };
  }

  async sign(options: RequestOptions, tamper: Tamper = {}) {
    this.counter = tamper.counter ?? this.counter + 1;
    const flags = 0x01 | (tamper.noUserVerification ? 0 : 0x04);
    const authData = Uint8Array.from([...(await sha256(enc.encode(options.rpId ?? this.rpId))), flags, ...new Uint8Array(new Uint32Array([this.counter]).buffer).reverse()]);
    const clientData = this.clientData("webauthn.get", options.challenge, tamper);
    const signed = Uint8Array.from([...authData, ...(await sha256(clientData))]);
    const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, signed));
    const signature = derFromRaw(raw);
    if (tamper.badSignature) signature[signature.length - 1]! ^= 1;
    const userHandle = tamper.noUserHandle ? undefined : (tamper.userHandle ?? this.userHandle ?? undefined);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key" as const,
      response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(signature), ...(userHandle ? { userHandle } : {}) },
      clientExtensionResults: {},
      authenticatorAttachment: "platform" as const,
    };
  }
}
