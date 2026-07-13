# Webhook signing (spec — implemented in P2)

> Status: authoritative spec for the P2 webhook sink. No code exists yet; this is the contract the implementation and the receiver reference must follow.

FeedbackKit can POST a normalized JSON payload to a per-project URL for every piece of feedback. Every request is signed so receivers can reject forged or replayed events.

## Algorithm decision: HMAC-SHA256 (not SHA-384)

We sign with **HMAC-SHA256**, deliberately, even though SHA-384 has theoretical advantages:

- **SHA-384 upside (acknowledged):** on native 64-bit CPUs it needs fewer instructions per block (64-bit words), and its larger output/state gives more collision margin.
- **Why SHA-256 wins here anyway:**
  1. **Ecosystem standard (zero friction).** GitHub, Stripe, GitLab, Vercel and every automation tool (n8n, Zapier, Make) verify HMAC-SHA256 out of the box. SHA-384 would force users into custom-code nodes.
  2. **System context.** SHA-384's CPU edge is nanoseconds; inside a Cloudflare Worker (V8/Wasm) it's dwarfed ~10,000× by JSON serialization and network latency (TLS handshake, roundtrip). We give up no measurable performance and gain maximum integration friendliness.
  3. **256 bits is enough.** Practically unbreakable against brute-force and collision attacks for webhook signatures; 384 is theoretical overkill here.

## Signature scheme

Three components: **raw body**, **per-project secret**, **timestamp**.

- **Secret:** 32 random bytes, hex-encoded, one per project in D1. Generate with `crypto.getRandomValues(new Uint8Array(32))`. Rotatable (see below).
- **Timestamp:** Unix epoch seconds — replay protection.
- **Signature:** HMAC-SHA256 over `` `${timestamp}.${rawBody}` `` (the exact bytes we send, never a re-serialized object).

Header (Stripe-style; `v1` is the scheme version for forward-compat):

```
X-FeedbackKit-Signature: t=1690000000,v1=a1b2c3d4…
```

## Sender (FeedbackKit Worker, Hono)

**Sign the raw body, never a re-serialized object** — JSON parsers reorder keys and change whitespace, which breaks the signature.

```ts
// WRONG: const rawBody = JSON.stringify(await c.req.json()); // ordering/formatting may differ
const rawBody = await c.req.text(); // RIGHT: the exact string we will send

async function generateSignature(rawBody: string, secret: string): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signedPayload = `${timestamp}.${rawBody}`;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(signedPayload));
  const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${timestamp},v1=${hex}`;
}

// Send: the body MUST be the exact string that was signed.
await fetch(project.webhookUrl, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-FeedbackKit-Signature": await generateSignature(rawBody, project.webhookSecret),
    "User-Agent": "FeedbackKit-Webhook/1.0",
  },
  body: rawBody,
});
```

Use compact JSON (no `JSON.stringify(payload, null, 2)`) — the receiver verifies the body 1:1 as a string.

## Receiver reference (Node.js / Next.js — for our users)

```ts
import crypto from "node:crypto";

const TOLERANCE_SECONDS = 300; // 5 minutes

export function verifyWebhook(rawBody: string, signatureHeader: string, secret: string): boolean {
  // 1. Parse header
  const parts = Object.fromEntries(signatureHeader.split(",").map((p) => p.split("=")));
  const timestamp = parts["t"];
  const signature = parts["v1"];
  if (!timestamp || !signature) return false;

  // 2. Replay protection
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > TOLERANCE_SECONDS) return false;

  // 3. Expected signature over `${timestamp}.${rawBody}`
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");

  // 4. Constant-time compare — guard equal length first (timingSafeEqual throws otherwise)
  if (signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
```

Read the raw body **before** any JSON parsing (Next.js App Router: `await req.text()`; Pages Router: disable the body parser). Verifying a parsed-and-restringified body will fail.

## Secret rotation

To rotate without downtime: store up to **two active secrets** per project. FeedbackKit signs with the newest; document that receivers should accept a valid `v1` signature against **either** secret during the rotation window, then drop the old one.

## Testing (do / don't)

- **DO** test end-to-end against a real external receiver (e.g. an ngrok tunnel to a small Express server) to catch header formatting and raw-body integrity.
- **DO** generate the secret with `crypto.getRandomValues(new Uint8Array(32))`, store hex-encoded.
- **DON'T** use `===` to compare hashes — a timing attack can recover the signature byte by byte. Always `timingSafeEqual` (after the length guard).
- **DON'T** pretty-print the payload before sending if the receiver expects the body 1:1. Stick to compact JSON.
