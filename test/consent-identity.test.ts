import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { authenticateConsent, signInRequired, NO_ACCOUNTS_YET, SIGN_IN_REQUIRED } from "../src/worker/oauth/consent-identity.js";
import { app } from "../src/worker/app.js";
import { resetAccessCache } from "../src/worker/admin/access.js";
import { AUD, TEAM, makeKey, claims, signJwt, jwksFetch, type TestKey } from "./access-helpers.js";
import { fakeD1 } from "./helpers.js";
import type { Env } from "../src/worker/env.js";

// The one seam of /oauth/authorize (ADR-015): who is signing in. The Worker leaves it unset and gets Cloudflare Access
// (test/mcp-oauth.test.ts covers the consent page end to end); the standalone server sets its own answer.

const req = (headers: Record<string, string> = {}) => new Request("https://gw.test/oauth/authorize", { headers });
const bareEnv = (extra: Record<string, unknown> = {}) => ({ FK_ENV: "test", WIDGET_VERSION: "t", ...extra }) as unknown as Env;

describe("authenticateConsent", () => {
  it("is Cloudflare Access when nothing is set: no Access configuration, no identity", async () => {
    expect(await authenticateConsent(req({ "Cf-Access-Jwt-Assertion": "a.b.c" }), bareEnv())).toBeNull();
  });

  it("asks the binding when one is set, and takes its answer as it is", async () => {
    const seen: Request[] = [];
    const env = bareEnv({
      CONSENT_AUTHENTICATOR: async (r: Request) => {
        seen.push(r);
        return { email: "robin@example.org", sub: "acct-1" };
      },
    });
    expect(await authenticateConsent(req(), env)).toEqual({ email: "robin@example.org", sub: "acct-1" });
    expect(seen).toHaveLength(1);
    expect(await authenticateConsent(req(), bareEnv({ CONSENT_AUTHENTICATOR: async () => null }))).toBeNull();
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

    it("does not fall back to Access when the binding answers nobody", async () => {
      const access = { FK_ACCESS_TEAM_DOMAIN: TEAM, FK_ACCESS_AUD: AUD };
      const request = req({ "Cf-Access-Jwt-Assertion": await signJwt(key, claims({ email: "dana@example.com" })) });
      // The request really is a valid Access sign-in: without the binding it is an identity.
      expect(await authenticateConsent(request, bareEnv(access))).toMatchObject({ email: "dana@example.com" });
      // With the binding set the binding decides, and it says nobody.
      expect(await authenticateConsent(request, bareEnv({ ...access, CONSENT_AUTHENTICATOR: async () => null }))).toBeNull();
    });
  });

  it("says Access on the Worker and 'accounts are not built' where the binding is set", () => {
    expect(signInRequired(bareEnv())).toBe(SIGN_IN_REQUIRED);
    expect(signInRequired(bareEnv({ CONSENT_AUTHENTICATOR: async () => null }))).toBe(NO_ACCOUNTS_YET);
    expect(NO_ACCOUNTS_YET.join(" ")).toMatch(/accounts are not built/);
    expect(SIGN_IN_REQUIRED.join(" ")).toMatch(/Cloudflare Access/);
  });
});

describe("/diag and MCP_STATUS", () => {
  const diag = async (extra: Record<string, unknown>) => {
    const env = bareEnv({ DB: fakeD1(() => null), UPLOADS: { get: async () => null }, ...extra });
    return (await app.request("/diag", {}, env)).json() as Promise<Record<string, unknown>>;
  };

  it("carries the one-line MCP status where the server sets it, and no such field on the Worker", async () => {
    expect((await diag({ MCP_STATUS: "off (approving a connection needs accounts, which are not built yet)" }))["mcp"]).toBe("off (approving a connection needs accounts, which are not built yet)");
    expect(Object.keys(await diag({}))).not.toContain("mcp");
  });
});
