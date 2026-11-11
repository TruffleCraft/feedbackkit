import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { authenticateConsent, signInRequired } from "../src/worker/oauth/consent-identity.js";
import { app } from "../src/worker/app.js";
import { sha256Hex } from "../src/worker/auth/crypto.js";
import { resetAccessCache } from "../src/worker/admin/access.js";
import { AUD, TEAM, makeKey, claims, signJwt, jwksFetch, type TestKey } from "./access-helpers.js";
import { fakeD1 } from "./helpers.js";
import type { Env } from "../src/worker/env.js";

// The one seam of /oauth/authorize (ADR-015): who is signing in. A Cloudflare Access identity or an account's session
// cookie, on both runtimes; a binding replaces both and only test code sets one
// (test/mcp-oauth.test.ts covers the consent page end to end on the Worker, test/server-mcp-accounts.test.mjs on a standalone server).

const SESSION = "fk_ses_" + "s".repeat(43);
const GW = "https://gw.test";
const req = (headers: Record<string, string> = {}) => new Request(`${GW}/oauth/authorize`, { headers });
const sessionCookie = (token = SESSION) => ({ Cookie: `__Host-fk_session=${token}` });

/** A D1 that knows one live session (its hash) of an active owner account. */
function withSession(extra: Record<string, unknown> = {}): Env {
  let hash = "";
  return {
    FK_ENV: "test",
    WIDGET_VERSION: "t",
    DB: fakeD1((sql: string, params: unknown[]) => {
      if (sql.includes("FROM sessions s JOIN accounts a")) return params[0] === hash ? { id: hash, public_id: "pub", account_id: "acct-1", last_seen_at: Date.now(), name: "Robin", role: "owner" } : null;
      return null;
    }),
    __setHash: (h: string) => (hash = h),
    ...extra,
  } as unknown as Env & { __setHash: (h: string) => void };
}

describe("authenticateConsent", () => {
  it("has no identity without Access, a session or a binding", async () => {
    const env = withSession();
    (env as unknown as { __setHash: (h: string) => void }).__setHash(await sha256Hex(SESSION));
    expect(await authenticateConsent(req(), env)).toBeNull();
    expect(await authenticateConsent(req({ "Cf-Access-Jwt-Assertion": "a.b.c", Authorization: "Bearer admin-token" }), env)).toBeNull();
    expect(await authenticateConsent(req(sessionCookie("fk_ses_" + "t".repeat(43))), env)).toBeNull(); // a session the database does not know
  });

  it("is the account behind a live session cookie: its name, its id, and the id again as accountId so the grant can end with it", async () => {
    const env = withSession();
    (env as unknown as { __setHash: (h: string) => void }).__setHash(await sha256Hex(SESSION));
    expect(await authenticateConsent(req(sessionCookie()), env)).toEqual({ email: "Robin", sub: "acct-1", accountId: "acct-1" });
  });

  it("asks the binding when one is set, and takes its answer as it is", async () => {
    const seen: Request[] = [];
    const env = withSession({
      CONSENT_AUTHENTICATOR: async (r: Request) => {
        seen.push(r);
        return { email: "robin@example.org", sub: "acct-1" };
      },
    });
    expect(await authenticateConsent(req(), env)).toEqual({ email: "robin@example.org", sub: "acct-1" });
    expect(seen).toHaveLength(1);
    expect(await authenticateConsent(req(), withSession({ CONSENT_AUTHENTICATOR: async () => null }))).toBeNull();
  });

  describe("with a valid Access sign-in on the request", () => {
    let key: TestKey;
    beforeAll(async () => {
      key = await makeKey("kid-1");
    });
    beforeEach(() => {
      resetAccessCache();
      vi.stubGlobal("fetch", jwksFetch([key]).fn);
    });
    afterEach(() => vi.unstubAllGlobals());

    it("is the Access identity, ahead of a session", async () => {
      const env = withSession({ FK_ACCESS_TEAM_DOMAIN: TEAM, FK_ACCESS_AUD: AUD });
      (env as unknown as { __setHash: (h: string) => void }).__setHash(await sha256Hex(SESSION));
      const jwt = { "Cf-Access-Jwt-Assertion": await signJwt(key, claims({ email: "dana@example.com" })) };
      expect(await authenticateConsent(req(jwt), env)).toMatchObject({ email: "dana@example.com" });
      expect(await authenticateConsent(req({ ...jwt, ...sessionCookie() }), env)).toMatchObject({ email: "dana@example.com" });
    });

    it("does not fall back to Access or a session when the binding answers nobody", async () => {
      const env = withSession({ FK_ACCESS_TEAM_DOMAIN: TEAM, FK_ACCESS_AUD: AUD, CONSENT_AUTHENTICATOR: async () => null });
      (env as unknown as { __setHash: (h: string) => void }).__setHash(await sha256Hex(SESSION));
      const request = req({ "Cf-Access-Jwt-Assertion": await signJwt(key, claims({ email: "dana@example.com" })), ...sessionCookie() });
      // The same request is an identity without the binding.
      expect(await authenticateConsent(request, withSession({ FK_ACCESS_TEAM_DOMAIN: TEAM, FK_ACCESS_AUD: AUD }))).toMatchObject({ email: "dana@example.com" });
      expect(await authenticateConsent(request, env)).toBeNull();
    });
  });

  it("names the sign-in this gateway has: a passkey, and Access too where it is configured", () => {
    const plain = signInRequired(withSession(), GW);
    expect(plain[0]).toBe("Sign-in required");
    expect(plain[1]).toContain(`${GW}/admin`);
    expect(plain[1]).toContain("passkey");
    expect(plain[1]).not.toContain("Cloudflare Access");
    expect(signInRequired(withSession({ FK_ACCESS_TEAM_DOMAIN: TEAM, FK_ACCESS_AUD: AUD }), GW)[1]).toContain("Cloudflare Access");
  });
});

describe("/diag and MCP_STATUS", () => {
  const diag = async (extra: Record<string, unknown>) => {
    const env = { FK_ENV: "test", WIDGET_VERSION: "t", DB: fakeD1(() => null), UPLOADS: { get: async () => null }, ...extra } as unknown as Env;
    return (await app.request("/diag", {}, env)).json() as Promise<Record<string, unknown>>;
  };

  it("carries the one-line MCP status where the server sets it, and no such field on the Worker", async () => {
    expect((await diag({ MCP_STATUS: "on (issuer https://gw.test, resource https://gw.test/mcp)" }))["mcp"]).toBe("on (issuer https://gw.test, resource https://gw.test/mcp)");
    expect(Object.keys(await diag({}))).not.toContain("mcp");
  });
});
