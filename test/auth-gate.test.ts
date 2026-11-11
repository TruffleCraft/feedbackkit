// Gate 2 at the seams the durable suite cannot reach (it registers only the admin
// and auth routes, because app.ts pulls in modules that workerd refuses at test
// scope): the full app's /diag deep check and config import, and Cloudflare Access
// beside accounts (S15). D1 is a small fake that answers the account queries.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/worker/app.js";
import { sha256Hex } from "../src/worker/auth/crypto.js";
import { resetAccessCache } from "../src/worker/admin/access.js";
import { fakeD1 } from "./helpers.js";
import { AUD, TEAM, claims, jwksFetch, makeKey, signJwt, type TestKey } from "./access-helpers.js";
import type { Env } from "../src/worker/env.js";

const LEGACY = "legacy-admin-token-0123456789abcdef0123456789";
const TOKEN = "fk_tok_" + "a".repeat(43);

function gate(opts: { owner: boolean; token?: { access: "read" | "write"; projects: string[] | null; revoked?: boolean } }, extra: Record<string, unknown> = {}): Env {
  return {
    DB: fakeD1((sql: string, params: unknown[]) => {
      if (sql.includes("FROM owner_claim")) return opts.owner ? { singleton: 1 } : null;
      if (sql.includes("FROM api_tokens t")) {
        if (!opts.token || params[0] !== tokenHash) return null;
        return { id: "t1", prefix: "fk_tok_aaaaaa", name: "ci", account_id: "a1", access: opts.token.access, projects: opts.token.projects ? JSON.stringify(opts.token.projects) : null, created_at: 1, expires_at: Date.now() + 86_400_000, last_used_at: Date.now(), revoked_at: opts.token.revoked ? 5 : null, account_state: "active" };
      }
      if (sql.includes("FROM meta")) return { value: "5" };
      if (sql.includes("INSERT INTO counters")) return { count: 1 };
      if (sql.includes("FROM projects WHERE")) return null;
      if (sql.includes("COUNT(*)")) return { n: 0 };
      return null;
    }),
    UPLOADS: { get: async () => null } as unknown as R2Bucket,
    ASSETS: { fetch: async () => new Response("") } as unknown as Fetcher,
    FK_ENV: "test",
    WIDGET_VERSION: "t",
    ADMIN_TOKEN: LEGACY,
    ...extra,
  } as unknown as Env;
}
let tokenHash: string;
beforeEach(async () => {
  tokenHash = await sha256Hex(TOKEN);
});

const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}`, "CF-Connecting-IP": "203.0.113.7", "Content-Type": "application/json" } });

describe("ADMIN_TOKEN after the first owner", () => {
  it("opens /diag?project= and config import before an owner exists, and neither after", async () => {
    const before = gate({ owner: false });
    expect(((await (await app.request("/diag?project=fk_pub_x", bearer(LEGACY), before)).json()) as { checks: { tracker: string } }).checks.tracker).not.toContain("unauthorized");
    expect((await app.request("/api/admin/config/import", { method: "POST", body: "{}", ...bearer(LEGACY) }, before)).status).toBe(400); // past the gate, then "projectId" is missing

    const after = gate({ owner: true });
    expect(((await (await app.request("/diag?project=fk_pub_x", bearer(LEGACY), after)).json()) as { checks: { tracker: string } }).checks.tracker).toContain("unauthorized");
    const refused = await app.request("/api/admin/config/import", { method: "POST", body: "{}", ...bearer(LEGACY) }, after);
    expect(refused.status).toBe(401);
    expect(((await refused.json()) as { code: string }).code).toBe("FK_ADMIN_TOKEN_RETIRED");
  });

  it("the server does not need an ADMIN_TOKEN to answer the public routes", async () => {
    const e = gate({ owner: true }, { ADMIN_TOKEN: undefined });
    expect((await app.request("/diag", {}, e)).status).toBe(200);
    expect((await app.request("/api/admin/projects", { headers: { "CF-Connecting-IP": "203.0.113.7" } }, e)).status).toBe(401);
  });
});

describe("scoped tokens at the app level", () => {
  it("a token limited to projects cannot import config, create a project or read /diag?project=", async () => {
    const e = gate({ owner: true, token: { access: "write", projects: ["demo"] } });
    expect((await app.request("/api/admin/config/import", { method: "POST", body: "{}", ...bearer(TOKEN) }, e)).status).toBe(403);
    expect((await app.request("/api/admin/projects", { method: "POST", body: "{}", ...bearer(TOKEN) }, e)).status).toBe(403);
    expect(((await (await app.request("/diag?project=fk_pub_x", bearer(TOKEN), e)).json()) as { checks: { tracker: string } }).checks.tracker).toContain("unauthorized");
  });

  it("an unrestricted token with write access reaches config import, and a read-only one does not", async () => {
    expect((await app.request("/api/admin/config/import", { method: "POST", body: "{}", ...bearer(TOKEN) }, gate({ owner: true, token: { access: "write", projects: null } }))).status).toBe(400);
    const readOnly = await app.request("/api/admin/config/import", { method: "POST", body: "{}", ...bearer(TOKEN) }, gate({ owner: true, token: { access: "read", projects: null } }));
    expect([readOnly.status, ((await readOnly.json()) as { code: string }).code]).toEqual([403, "FK_TOKEN_SCOPE"]);
  });

  it("a revoked token is refused on the app routes too", async () => {
    const r = await app.request("/api/admin/projects", bearer(TOKEN), gate({ owner: true, token: { access: "read", projects: null, revoked: true } }));
    expect([r.status, ((await r.json()) as { code: string }).code]).toEqual([401, "FK_TOKEN_REVOKED"]);
  });
});

describe("Cloudflare Access stays an accepted identity beside accounts (S15)", () => {
  let key: TestKey;
  beforeEach(async () => {
    resetAccessCache();
    key = await makeKey("k1");
    vi.stubGlobal("fetch", jwksFetch([key]).fn);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("an Access sign-in still opens the admin after an owner exists, and a write needs the same origin", async () => {
    const e = gate({ owner: true }, { FK_ACCESS_TEAM_DOMAIN: TEAM, FK_ACCESS_AUD: AUD });
    const jwt = await signJwt(key, claims());
    const headers = { "Cf-Access-Jwt-Assertion": jwt, "CF-Connecting-IP": "203.0.113.7" };
    expect((await app.request("/api/admin/me", { headers }, e)).status).toBe(200);
    expect(((await (await app.request("/api/admin/me", { headers }, e)).json()) as { via: string }).via).toBe("access");
    const cross = await app.request("/api/admin/projects", { method: "POST", body: "{}", headers: { ...headers, Origin: "https://evil.example" } }, e);
    expect(cross.status).toBe(401);
  });

  it("an Access identity is not an account: it cannot create tokens or manage accounts", async () => {
    const e = gate({ owner: true }, { FK_ACCESS_TEAM_DOMAIN: TEAM, FK_ACCESS_AUD: AUD });
    const headers = { "Cf-Access-Jwt-Assertion": await signJwt(key, claims()), "CF-Connecting-IP": "203.0.113.7", Origin: "http://localhost", "Content-Type": "application/json" };
    for (const [method, path] of [["GET", "/api/admin/accounts"], ["POST", "/api/admin/tokens"], ["GET", "/api/admin/account"]] as const) {
      const r = await app.request(path, { method, headers, ...(method === "POST" ? { body: "{}" } : {}) }, e);
      expect([r.status, ((await r.json()) as { code: string }).code], path).toEqual([403, "FK_SESSION_REQUIRED"]);
    }
  });
});
