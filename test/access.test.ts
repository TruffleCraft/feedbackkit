// Cloudflare Access JWT verification (src/worker/admin/access.ts) against a
// locally generated RSA key and a mocked team JWKS endpoint.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { verifyAccess, resetAccessCache, normalizeTeamDomain } from "../src/worker/admin/access.js";
import { AUD, TEAM, CERTS_URL, makeKey, claims, signJwt, jwksFetch, type TestKey } from "./access-helpers.js";
import type { Env } from "../src/worker/env.js";

let keyA: TestKey;
let keyB: TestKey;
beforeAll(async () => {
  keyA = await makeKey("kid-a");
  keyB = await makeKey("kid-b");
});

const env = (over: Record<string, unknown> = {}) => ({ FK_ACCESS_TEAM_DOMAIN: TEAM, FK_ACCESS_AUD: AUD, ...over }) as unknown as Env;
const reqWith = (jwt?: string, extra: Record<string, string> = {}) =>
  new Request("https://fk.example.com/api/admin/me", { headers: { ...(jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {}), ...extra } });

let jwks: ReturnType<typeof jwksFetch>;
let keys: TestKey[];
beforeEach(() => {
  resetAccessCache();
  keys = [keyA];
  jwks = jwksFetch(keys);
  vi.stubGlobal("fetch", jwks.fn);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("verifyAccess", () => {
  it("accepts a valid token and returns email and sub", async () => {
    const jwt = await signJwt(keyA, claims());
    expect(await verifyAccess(env(), reqWith(jwt))).toEqual({ email: "dana@example.com", sub: "7335d417-61da-459d-899c-0a01c76a2f94" });
    expect(jwks.calls).toEqual([CERTS_URL]);
  });

  it("caches the key set: a second token does not fetch again", async () => {
    await verifyAccess(env(), reqWith(await signJwt(keyA, claims())));
    await verifyAccess(env(), reqWith(await signJwt(keyA, claims({ email: "lee@example.com" }))));
    expect(jwks.calls).toHaveLength(1);
  });

  it("accepts aud as a plain string too", async () => {
    expect(await verifyAccess(env(), reqWith(await signJwt(keyA, claims({ aud: AUD }))))).not.toBeNull();
  });

  it("rejects a wrong aud", async () => {
    expect(await verifyAccess(env(), reqWith(await signJwt(keyA, claims({ aud: ["some-other-app"] }))))).toBeNull();
    expect(await verifyAccess(env(), reqWith(await signJwt(keyA, claims({ aud: undefined }))))).toBeNull();
  });

  it("rejects a wrong iss", async () => {
    expect(await verifyAccess(env(), reqWith(await signJwt(keyA, claims({ iss: "https://evil.cloudflareaccess.com" }))))).toBeNull();
    expect(await verifyAccess(env(), reqWith(await signJwt(keyA, claims({ iss: `${TEAM}/` }))))).toBeNull();
  });

  it("honours exp and nbf with 60 s of skew", async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(await verifyAccess(env(), reqWith(await signJwt(keyA, claims({ exp: now - 120 }))))).toBeNull();
    expect(await verifyAccess(env(), reqWith(await signJwt(keyA, claims({ exp: now - 30 }))))).not.toBeNull();
    expect(await verifyAccess(env(), reqWith(await signJwt(keyA, claims({ exp: undefined }))))).toBeNull();
    expect(await verifyAccess(env(), reqWith(await signJwt(keyA, claims({ nbf: now + 120 }))))).toBeNull();
    expect(await verifyAccess(env(), reqWith(await signJwt(keyA, claims({ nbf: now + 30 }))))).not.toBeNull();
  });

  it("rejects a bad signature", async () => {
    const good = await signJwt(keyA, claims());
    const [h, , s] = good.split(".");
    const otherPayload = (await signJwt(keyA, claims({ email: "mallory@example.com" }))).split(".")[1];
    expect(await verifyAccess(env(), reqWith(`${h}.${otherPayload}.${s}`))).toBeNull();
    // Signed by a key the team does not publish, under a kid it does.
    const forged = await signJwt({ ...keyB, kid: "kid-a" }, claims());
    expect(await verifyAccess(env(), reqWith(forged))).toBeNull();
  });

  it("rejects other algorithms, malformed tokens and service tokens", async () => {
    expect(await verifyAccess(env(), reqWith(await signJwt(keyA, claims(), { alg: "none" })))).toBeNull();
    expect(await verifyAccess(env(), reqWith(await signJwt(keyA, claims(), { alg: "HS256" })))).toBeNull();
    expect(await verifyAccess(env(), reqWith("not-a-jwt"))).toBeNull();
    expect(await verifyAccess(env(), reqWith("a.b.c"))).toBeNull();
    expect(await verifyAccess(env(), reqWith((await signJwt(keyA, claims())) + "."))).toBeNull();
    // A service-token JWT has no email and an empty sub.
    const svc = await signJwt(keyA, claims({ email: undefined, sub: "", common_name: "e367826f93b8d711.access" }));
    expect(await verifyAccess(env(), reqWith(svc))).toBeNull();
  });

  it("refetches the key set for an unknown kid (key rotation)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = new Date("2026-10-08T10:00:00Z").getTime();
    vi.setSystemTime(t0);
    expect(await verifyAccess(env(), reqWith(await signJwt(keyA, claims())))).not.toBeNull();
    expect(jwks.calls).toHaveLength(1);

    // Access rotates: the new key shows up at the certs URL.
    keys.unshift(keyB);
    vi.setSystemTime(t0 + 31_000);
    expect(await verifyAccess(env(), reqWith(await signJwt(keyB, claims())))).not.toBeNull();
    expect(jwks.calls).toHaveLength(2);
    // The old key stays valid (Access keeps it for 7 days) without another fetch.
    expect(await verifyAccess(env(), reqWith(await signJwt(keyA, claims())))).not.toBeNull();
    expect(jwks.calls).toHaveLength(2);
  });

  it("refetches for an unknown kid at most every 30 s", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = new Date("2026-10-08T10:00:00Z").getTime();
    vi.setSystemTime(t0);
    await verifyAccess(env(), reqWith(await signJwt(keyA, claims())));
    const bogus = await signJwt({ ...keyA, kid: "kid-unknown" }, claims());
    for (let i = 0; i < 5; i++) expect(await verifyAccess(env(), reqWith(bogus))).toBeNull();
    expect(jwks.calls).toHaveLength(1);
    vi.setSystemTime(t0 + 31_000);
    expect(await verifyAccess(env(), reqWith(bogus))).toBeNull();
    expect(jwks.calls).toHaveLength(2);
  });

  it("refetches after the cache hour", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = new Date("2026-10-08T10:00:00Z").getTime();
    vi.setSystemTime(t0);
    await verifyAccess(env(), reqWith(await signJwt(keyA, claims())));
    vi.setSystemTime(t0 + 61 * 60_000);
    expect(await verifyAccess(env(), reqWith(await signJwt(keyA, claims())))).not.toBeNull();
    expect(jwks.calls).toHaveLength(2);
  });

  it("returns null when the config is unset, without fetching anything", async () => {
    const jwt = await signJwt(keyA, claims());
    expect(await verifyAccess(env({ FK_ACCESS_AUD: undefined }), reqWith(jwt))).toBeNull();
    expect(await verifyAccess(env({ FK_ACCESS_TEAM_DOMAIN: undefined }), reqWith(jwt))).toBeNull();
    expect(await verifyAccess(env({ FK_ACCESS_TEAM_DOMAIN: "", FK_ACCESS_AUD: "" }), reqWith(jwt))).toBeNull();
    expect(jwks.calls).toEqual([]);
  });

  it("reads the header only, never the CF_Authorization cookie", async () => {
    const jwt = await signJwt(keyA, claims());
    expect(await verifyAccess(env(), reqWith(undefined, { Cookie: `CF_Authorization=${jwt}` }))).toBeNull();
  });

  it("returns null instead of throwing when the key set can't be fetched", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    expect(await verifyAccess(env(), reqWith(await signJwt(keyA, claims())))).toBeNull();
    vi.stubGlobal("fetch", async () => new Response("<html>", { status: 200 }));
    expect(await verifyAccess(env(), reqWith(await signJwt(keyA, claims())))).toBeNull();
  });

  it("accepts the team domain with or without scheme", async () => {
    const jwt = await signJwt(keyA, claims());
    expect(await verifyAccess(env({ FK_ACCESS_TEAM_DOMAIN: "acme-team.cloudflareaccess.com" }), reqWith(jwt))).not.toBeNull();
    expect(await verifyAccess(env({ FK_ACCESS_TEAM_DOMAIN: `${TEAM}/` }), reqWith(jwt))).not.toBeNull();
  });
});

describe("normalizeTeamDomain", () => {
  it("normalizes to an https origin and rejects anything else", () => {
    expect(normalizeTeamDomain("acme-team.cloudflareaccess.com")).toBe(TEAM);
    expect(normalizeTeamDomain(" https://acme-team.cloudflareaccess.com/ ")).toBe(TEAM);
    expect(normalizeTeamDomain("http://acme-team.cloudflareaccess.com")).toBeNull();
    expect(normalizeTeamDomain("https://acme-team.cloudflareaccess.com/cdn-cgi")).toBeNull();
    expect(normalizeTeamDomain("https://user:pw@acme-team.cloudflareaccess.com")).toBeNull();
    expect(normalizeTeamDomain("")).toBeNull();
    expect(normalizeTeamDomain(undefined)).toBeNull();
  });
});
