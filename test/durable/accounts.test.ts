import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { registerAdminRoutes } from "../../src/worker/admin/routes.js";
import { registerAuthRoutes } from "../../src/worker/auth/routes.js";
import { hostRecoveryLink, hostSetupLink, pruneExpiredAuth } from "../../src/worker/auth/host.js";
import { checkChallenge, makeChallenge } from "../../src/worker/auth/challenge.js";
import { issueLink } from "../../src/worker/auth/links.js";
import { ownerExists } from "../../src/worker/auth/accounts.js";
import { authenticateAccount } from "../../src/worker/auth/index.js";
import type { Env } from "../../src/worker/env.js";
import { SoftAuthenticator, type Tamper } from "./authenticator.js";
import { resetStorage } from "./reset.js";

// Gate 2, local accounts, on the real D1 (workerd) and on SQLite (the standalone
// server's storage): first-owner bootstrap, passkey sign-in, recovery, invitations,
// sessions with CSRF, scoped API tokens, last-owner protection and the failed-login
// throttle. One file, two runtimes: vitest.workers.config.ts and
// vitest.conformance.config.ts run it against each. The authenticator is software
// (test/durable/authenticator.ts) so the server code verifies real signatures.

const app = new Hono<{ Bindings: Env }>();
registerAdminRoutes(app);
registerAuthRoutes(app);

const BASE = "http://localhost";
const LEGACY = "legacy-admin-token-0123456789abcdef0123456789";
const gw = { ...env, FK_ENV: "test" } as unknown as Env; // no ADMIN_TOKEN: the instance does not need it
const gwWithLegacy = { ...env, FK_ENV: "test", ADMIN_TOKEN: LEGACY } as unknown as Env;

interface Client {
  cookie: string | null;
  csrf: string | null;
  ip: string;
  base: string;
}
const newClient = (ip = "203.0.113.10", base = BASE): Client => ({ cookie: null, csrf: null, ip, base });

interface Reply {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  res: Response;
}

async function call(method: string, path: string, opts: { body?: unknown; client?: Client; headers?: Record<string, string | undefined>; csrf?: boolean | string; origin?: string | null; env?: Env } = {}): Promise<Reply> {
  const client = opts.client ?? newClient();
  const headers: Record<string, string> = { "CF-Connecting-IP": client.ip };
  if (opts.origin !== null) headers["Origin"] = opts.origin ?? client.base;
  if (client.cookie) headers["Cookie"] = client.cookie;
  const unsafe = !["GET", "HEAD", "OPTIONS"].includes(method);
  if (unsafe && opts.csrf !== false && (typeof opts.csrf === "string" || client.csrf)) headers["X-CSRF-Token"] = typeof opts.csrf === "string" ? opts.csrf : client.csrf!;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  for (const [k, v] of Object.entries(opts.headers ?? {})) if (v === undefined) delete headers[k];
  else headers[k] = v;
  const res = await app.request(client.base + path, { method, headers, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) }, opts.env ?? gw);
  const set = res.headers.get("Set-Cookie");
  if (set) {
    const [pair] = set.split(";");
    const value = pair!.slice(pair!.indexOf("=") + 1);
    client.cookie = value ? pair! : null;
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if ((body as { csrf?: string } | null)?.csrf) client.csrf = (body as { csrf: string }).csrf;
  return { status: res.status, body, res };
}

const tokenOf = (url: string): string => new URL(url).hash.slice(1);

/** Runs the two setup steps for a link token with a fresh software passkey. */
async function enroll(token: string, client: Client, opts: { name?: string; auth?: SoftAuthenticator; tamper?: Tamper } = {}) {
  const auth = opts.auth ?? (await SoftAuthenticator.create(client.base));
  const begin = await call("POST", "/api/auth/setup/begin", { client, body: { token, name: opts.name } });
  if (begin.status !== 200) return { auth, begin, finish: begin };
  const response = await auth.register(begin.body.options, opts.tamper);
  const finish = await call("POST", "/api/auth/setup/finish", { client, body: { token, name: opts.name, response } });
  return { auth, begin, finish };
}

async function bootstrap(name = "Robin", client = newClient(), e: Env = gw) {
  const link = await hostSetupLink(e, { origin: client.base });
  const r = await enroll(tokenOf(link.url), client, { name });
  expect(r.finish.status, JSON.stringify(r.finish.body)).toBe(201);
  return { client, auth: r.auth, accountId: r.finish.body.account.id as string };
}

async function signIn(auth: SoftAuthenticator, client = newClient(), tamper?: Tamper): Promise<Reply> {
  const begin = await call("POST", "/api/auth/signin/begin", { client });
  expect(begin.status).toBe(200);
  const response = await auth.sign({ challenge: begin.body.options.challenge, rpId: begin.body.options.rpId }, tamper);
  return call("POST", "/api/auth/signin/finish", { client, body: { response } });
}

const count = async (table: string, where = "1=1") => Number((await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).first<{ n: number }>())!.n);

const projectConfig = (id: string) => ({ projectId: id, templates: [{ type: "bug", label: "Bug" }], llm: { provider: "off" }, tracker: { kind: "github", defaultRepo: "acme/site", patSecret: "GITHUB_PAT_default" }, auth: { origins: [] } });
async function seedProjects() {
  for (const id of ["demo", "other"]) {
    await env.DB.prepare("INSERT INTO projects (id, public_key, config, config_version, updated_at) VALUES (?1, ?2, ?3, 1, 0)").bind(id, `fk_pub_${id}0001`, JSON.stringify(projectConfig(id))).run();
  }
  await env.DB.prepare("INSERT INTO feedback (id, project_id, outcome, payload, created_at, client_feedback_id, delivery) VALUES ('fb-other', 'other', 'created', '{}', 1, 'c-other', 'local')").run();
}

const logs: string[] = [];
beforeEach(async () => {
  await resetStorage();
  logs.length = 0;
  for (const level of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")));
  }
});
afterEach(() => vi.restoreAllMocks());

describe("first owner (S14)", () => {
  it("creates the owner with a passkey, opens a session, and the link works once", async () => {
    const link = await hostSetupLink(gw, { origin: BASE });
    expect(link.url).toMatch(/^http:\/\/localhost\/admin\/setup#fk_link_[A-Za-z0-9_-]{43}$/);
    const first = await enroll(tokenOf(link.url), newClient(), { name: "Robin" });
    expect(first.finish.status).toBe(201);
    expect(first.finish.body).toMatchObject({ status: "signed_in", purpose: "bootstrap", account: { name: "Robin", role: "owner" } });
    expect(await count("accounts", "role = 'owner' AND state = 'active'")).toBe(1);
    expect(await count("passkeys")).toBe(1);
    expect(await ownerExists(gw)).toBe(true);
    // The same link again, with another passkey: refused.
    const again = await enroll(tokenOf(link.url), newClient(), { name: "Mallory" });
    expect(again.finish.status).toBeGreaterThanOrEqual(400);
    expect(await count("accounts")).toBe(1);
  });

  it("concurrent bootstrap yields exactly one owner", async () => {
    const link = await hostSetupLink(gw, { origin: BASE });
    const token = tokenOf(link.url);
    const runs = await Promise.all(
      Array.from({ length: 8 }, async (_, i) => {
        const client = newClient(`198.51.100.${i + 1}`);
        const auth = await SoftAuthenticator.create();
        const begin = await call("POST", "/api/auth/setup/begin", { client, body: { token, name: `Racer ${i}` } });
        expect(begin.status).toBe(200);
        return { client, auth, begin, name: `Racer ${i}`, response: await auth.register(begin.body.options) };
      }),
    );
    const results = await Promise.all(runs.map((r) => call("POST", "/api/auth/setup/finish", { client: r.client, body: { token, name: r.name, response: r.response } })));
    const wins = results.filter((r) => r.status === 201);
    expect(wins).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 201)) expect([409, 410]).toContain(r.status);
    expect(await count("accounts", "role = 'owner'")).toBe(1);
    expect(await count("owner_claim")).toBe(1);
    expect(await count("passkeys")).toBe(1);
    expect(await count("sessions")).toBe(1);
    // The winner's session works; the losers hold nothing.
    const winner = runs[results.findIndex((r) => r.status === 201)]!;
    expect((await call("GET", "/api/admin/account", { client: winner.client })).status).toBe(200);
    for (const [i, r] of results.entries()) if (r.status !== 201) expect(runs[i]!.client.cookie).toBeNull();
  });

  it("negative control: a check-then-insert claim lets two owners through, so the concurrency test can fail", async () => {
    // What an implementation without the owner_claim primary key and the guarded batch would do.
    const naive = async (name: string) => {
      const exists = await env.DB.prepare("SELECT 1 AS x FROM owner_claim LIMIT 1").first();
      await new Promise((r) => setTimeout(r, 5));
      if (exists) return false;
      await env.DB.prepare("INSERT INTO accounts (id, name, name_key, role, state, created_at) VALUES (?1, ?2, ?3, 'owner', 'active', 1)").bind(crypto.randomUUID(), name, name.toLowerCase()).run();
      return true;
    };
    const wins = (await Promise.all([naive("A"), naive("B"), naive("C")])).filter(Boolean).length;
    expect(wins).toBeGreaterThan(1);
    expect(await count("accounts", "role = 'owner'")).toBeGreaterThan(1);
  });

  it("refuses a bootstrap link once an owner exists, and an old link stops working", async () => {
    const early = await hostSetupLink(gw, { origin: BASE });
    await bootstrap();
    await expect(hostSetupLink(gw, { origin: BASE })).rejects.toMatchObject({ code: "FK_OWNER_EXISTS" });
    const late = await enroll(tokenOf(early.url), newClient(), { name: "Late" });
    expect(late.begin.status).toBeGreaterThanOrEqual(400);
    expect(await count("accounts")).toBe(1);
  });

  it("a link expires, and a new one replaces the unused older one", async () => {
    const past = await issueLink(gw, { purpose: "bootstrap", accountId: null, createdBy: "host", now: Date.now() - 3_600_000 });
    const expired = await enroll(past.token, newClient(), { name: "Slow" });
    expect(expired.begin.status).toBe(410);
    expect(expired.begin.body.code).toBe("FK_SETUP_LINK_INVALID");
    const a = await hostSetupLink(gw, { origin: BASE });
    const b = await hostSetupLink(gw, { origin: BASE });
    expect((await enroll(tokenOf(a.url), newClient(), { name: "Old" })).begin.status).toBe(410);
    expect((await enroll(tokenOf(b.url), newClient(), { name: "New" })).finish.status).toBe(201);
  });

  it("works without ADMIN_TOKEN in the environment", async () => {
    expect((gw as unknown as Record<string, unknown>)["ADMIN_TOKEN"]).toBeUndefined();
    const { client } = await bootstrap();
    expect((await call("GET", "/api/admin/projects", { client })).status).toBe(200);
  });

  it("refuses a passkey without user verification, a wrong origin and a forged challenge", async () => {
    const mk = async (tamper: Tamper) => {
      const link = await hostSetupLink(gw, { origin: BASE });
      return enroll(tokenOf(link.url), newClient(), { name: "Robin", tamper });
    };
    expect((await mk({ noUserVerification: true })).finish).toMatchObject({ status: 400, body: { code: "FK_PASSKEY_REJECTED" } });
    expect((await mk({ origin: "https://evil.example" })).finish.status).toBe(400);
    expect((await mk({ challenge: "AAAA" })).finish.status).toBe(400);
    expect(await count("accounts")).toBe(0);
    expect(await ownerExists(gw)).toBe(false);
  });
});

describe("sign-in and sessions", () => {
  it("signs in with a passkey, with the documented cookie attributes", async () => {
    const { auth } = await bootstrap();
    const client = newClient();
    const r = await signIn(auth, client);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "signed_in", account: { name: "Robin", role: "owner" } });
    const cookie = r.res.headers.get("Set-Cookie")!;
    expect(cookie).toMatch(/^fk_session=fk_ses_[A-Za-z0-9_-]{43}; Max-Age=2592000; Path=\/; HttpOnly; SameSite=Lax$/);
    expect(cookie).not.toMatch(/Domain=/i);
    expect(cookie).not.toMatch(/Secure/);
    expect(r.res.headers.get("Cache-Control")).toBe("no-store");
    const me = await call("GET", "/api/admin/me", { client });
    expect(me.body).toMatchObject({ via: "session", account: { name: "Robin", role: "owner" }, csrf: client.csrf });
  });

  it("on https the cookie is Secure and carries the __Host- prefix", async () => {
    const base = "https://gw.example.org";
    const client = newClient("203.0.113.10", base);
    const { auth } = await bootstrap("Robin", client);
    const again = newClient("203.0.113.11", base);
    const r = await signIn(auth, again);
    expect(r.status).toBe(200);
    expect(r.res.headers.get("Set-Cookie")).toMatch(/^__Host-fk_session=fk_ses_[A-Za-z0-9_-]{43}; Max-Age=2592000; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
    expect((await call("GET", "/api/admin/me", { client: again })).status).toBe(200);
  });

  it("mints a new session at every sign-in and drops a session that came with the request (fixation)", async () => {
    const { auth } = await bootstrap();
    const attacker = newClient();
    attacker.cookie = "fk_session=fk_ses_" + "A".repeat(43); // a value planted in advance
    const r = await signIn(auth, attacker);
    expect(r.status).toBe(200);
    expect(attacker.cookie).not.toContain("A".repeat(43));
    // A valid older session is ended by the next sign-in on the same browser.
    const first = attacker.cookie!;
    await signIn(auth, attacker);
    expect(attacker.cookie).not.toBe(first);
    expect((await call("GET", "/api/admin/me", { client: { ...newClient(), cookie: first } })).status).toBe(401);
  });

  it("stores no session token, link token or API token: the database holds hashes only", async () => {
    const link = await hostSetupLink(gw, { origin: BASE });
    const client = newClient();
    const r = await enroll(tokenOf(link.url), client, { name: "Robin" });
    const sessionToken = client.cookie!.split("=")[1]!;
    const created = await call("POST", "/api/admin/tokens", { client, body: { name: "ci", access: "read", projects: null } });
    const apiToken = created.body.token as string;
    expect(r.finish.status).toBe(201);
    for (const table of ["sessions", "setup_links", "api_tokens", "accounts", "passkeys", "used_challenges", "owner_claim"]) {
      const rows = JSON.stringify((await env.DB.prepare(`SELECT * FROM ${table}`).all()).results);
      expect(rows, table).not.toContain(sessionToken);
      expect(rows, table).not.toContain(tokenOf(link.url));
      expect(rows, table).not.toContain(apiToken);
    }
  });

  it("requires the CSRF token and a same-origin request for every write", async () => {
    const { client } = await bootstrap();
    const write = (o: Parameters<typeof call>[2]) => call("POST", "/api/admin/accounts", { client, body: { name: "Taylor", role: "member" }, ...o });
    expect((await write({ csrf: false })).body).toMatchObject({ code: "FK_CSRF" });
    expect((await write({ csrf: "wrong-token" })).status).toBe(403);
    expect((await write({ origin: "https://evil.example" })).body).toMatchObject({ code: "FK_CSRF" });
    expect((await write({ origin: null, headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    expect((await write({ origin: null, headers: { "Sec-Fetch-Site": "same-origin" } })).status).toBe(201);
    expect(await count("accounts", "state = 'invited'")).toBe(1);
  });

  it("sign-out needs the CSRF token, then ends the session", async () => {
    const { client } = await bootstrap();
    const cookie = client.cookie!;
    expect((await call("POST", "/api/auth/signout", { client, csrf: false })).status).toBe(403);
    expect((await call("GET", "/api/admin/me", { client })).status).toBe(200);
    const out = await call("POST", "/api/auth/signout", { client });
    expect(out.status).toBe(200);
    expect(out.res.headers.get("Set-Cookie")).toMatch(/Max-Age=0/);
    expect((await call("GET", "/api/admin/me", { client: { ...newClient(), cookie } })).status).toBe(401);
  });

  it("a session ends when it expires or sits idle too long, and the sweep removes it", async () => {
    const { client } = await bootstrap();
    await env.DB.prepare("UPDATE sessions SET last_seen_at = ?1").bind(Date.now() - 8 * 86_400_000).run();
    expect((await call("GET", "/api/admin/me", { client })).status).toBe(401);
    await pruneExpiredAuth(gw);
    expect(await count("sessions")).toBe(0);
    const fresh = await bootstrap_second();
    await env.DB.prepare("UPDATE sessions SET expires_at = ?1").bind(Date.now() - 1).run();
    expect((await call("GET", "/api/admin/me", { client: fresh })).status).toBe(401);
  });

  it("authenticateAccount returns the account behind a cookie, and null for anything else", async () => {
    const { client, accountId } = await bootstrap();
    const request = (cookie: string | null) => new Request(`${BASE}/oauth/authorize`, { headers: cookie ? { Cookie: cookie } : {} });
    expect(await authenticateAccount(request(client.cookie), gw)).toEqual({ accountId, role: "owner", name: "Robin" });
    expect(await authenticateAccount(request(null), gw)).toBeNull();
    expect(await authenticateAccount(request("fk_session=fk_ses_" + "B".repeat(43)), gw)).toBeNull();
    // A bearer token is not a session.
    const created = await call("POST", "/api/admin/tokens", { client, body: { name: "ci", access: "read", projects: null } });
    expect(await authenticateAccount(new Request(`${BASE}/`, { headers: { Authorization: `Bearer ${created.body.token}` } }), gw)).toBeNull();
    await call("DELETE", `/api/admin/accounts/${accountId}`, { client }); // refused: last owner
    expect(await authenticateAccount(request(client.cookie), gw)).not.toBeNull();
  });

  it("an assertion with a wrong origin, a bad signature or an unknown passkey is refused", async () => {
    const { auth } = await bootstrap();
    expect((await signIn(auth, newClient("192.0.2.1"), { origin: "https://evil.example" })).status).toBe(401);
    expect((await signIn(auth, newClient("192.0.2.2"), { badSignature: true })).status).toBe(401);
    expect((await signIn(auth, newClient("192.0.2.3"), { noUserVerification: true })).status).toBe(401);
    expect((await signIn(auth, newClient("192.0.2.4"), { userHandle: "bm90LXRoZS1hY2NvdW50" })).status).toBe(401);
    const stranger = await SoftAuthenticator.create();
    expect((await signIn(stranger, newClient("192.0.2.5"))).status).toBe(401);
    expect(await count("sessions")).toBe(1); // only the bootstrap session
    expect((await signIn(auth, newClient("192.0.2.6"))).status).toBe(200);
  });

  it("an assertion cannot be played twice, and a counter that goes back is refused", async () => {
    const { auth } = await bootstrap();
    // A synced passkey keeps its counter at 0, so only the challenge record can stop a replay.
    const begin = await call("POST", "/api/auth/signin/begin", { client: newClient() });
    const response = await auth.sign({ challenge: begin.body.options.challenge, rpId: begin.body.options.rpId }, { counter: 0 });
    const first = await call("POST", "/api/auth/signin/finish", { client: newClient("192.0.2.20"), body: { response } });
    expect(first.status).toBe(200);
    const replay = await call("POST", "/api/auth/signin/finish", { client: newClient("192.0.2.21"), body: { response } });
    expect(replay.status).toBe(401);
    // A real counter: the next sign-in with a lower value than the stored one fails.
    expect((await signIn(auth, newClient("192.0.2.22"), { counter: 5 })).status).toBe(200);
    expect((await signIn(auth, newClient("192.0.2.23"), { counter: 3 })).status).toBe(401);
  });

  it("challenges are signed, bound to purpose and subject, and expire", async () => {
    const made = await makeChallenge(gw, "signin", "");
    const text = btoa(String.fromCharCode(...made)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await checkChallenge(gw, text, "signin", "")).toMatchObject({ nonce: expect.any(String) });
    expect(await checkChallenge(gw, text, "setup", "")).toBeNull();
    expect(await checkChallenge(gw, text, "signin", "someone-else")).toBeNull();
    expect(await checkChallenge(gw, text, "signin", "", Date.now() + 6 * 60_000)).toBeNull();
    const flipped = new Uint8Array(made);
    flipped[30]! ^= 1;
    expect(await checkChallenge(gw, btoa(String.fromCharCode(...flipped)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), "signin", "")).toBeNull();
    expect(await checkChallenge(gw, "not-a-challenge", "signin", "")).toBeNull();
  });
});

/** A second owner session on the same instance, for tests that need a session of their own. */
async function bootstrap_second(): Promise<Client> {
  await env.DB.batch(["owner_claim", "accounts", "passkeys", "setup_links", "sessions"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  return (await bootstrap("Casey")).client;
}

describe("recovery and invitations", () => {
  it("recovery replaces the passkeys, signs out every session, and the link works once", async () => {
    const { client, auth, accountId } = await bootstrap();
    const other = newClient("203.0.113.50");
    expect((await signIn(auth, other)).status).toBe(200);

    const recovery = await hostRecoveryLink(gw, { origin: BASE });
    expect(recovery.account).toBe("Robin");
    const device = newClient("203.0.113.51");
    const fresh = await enroll(tokenOf(recovery.url), device);
    expect(fresh.finish.status).toBe(201);
    expect(fresh.finish.body).toMatchObject({ purpose: "recovery", account: { id: accountId, role: "owner" } });

    // Every old session is gone, the old passkey no longer signs in, the new one does.
    expect((await call("GET", "/api/admin/me", { client })).status).toBe(401);
    expect((await call("GET", "/api/admin/me", { client: other })).status).toBe(401);
    expect((await signIn(auth, newClient("203.0.113.52"))).status).toBe(401);
    expect((await signIn(fresh.auth, newClient("203.0.113.53"))).status).toBe(200);
    expect(await count("passkeys")).toBe(1);
    expect(await count("accounts")).toBe(1);

    // The link is spent.
    expect((await enroll(tokenOf(recovery.url), newClient())).begin.status).toBe(410);
  });

  it("recovery on a clean instance: a lost passkey, then the host command, then access again", async () => {
    await expect(hostRecoveryLink(gw, { origin: BASE })).rejects.toMatchObject({ code: "FK_NO_OWNER" });
    const { auth } = await bootstrap();
    const lost = auth; // the device is gone
    const recovery = await hostRecoveryLink(gw, { origin: BASE });
    const r = await enroll(tokenOf(recovery.url), newClient());
    expect(r.finish.status).toBe(201);
    expect((await signIn(lost, newClient("203.0.113.60"))).status).toBe(401);
    expect((await signIn(r.auth, newClient("203.0.113.61"))).status).toBe(200);
  });

  it("an owner invites a member; the invitation works once; the member cannot manage accounts or tokens", async () => {
    const { client: owner } = await bootstrap();
    const invite = await call("POST", "/api/admin/accounts", { client: owner, body: { name: "Taylor", role: "member" } });
    expect(invite.status).toBe(201);
    expect(invite.body.link.url).toMatch(/\/admin\/setup#fk_link_/);
    expect(invite.body.account).toMatchObject({ name: "Taylor", role: "member", state: "invited" });
    expect((await call("POST", "/api/admin/accounts", { client: owner, body: { name: "taylor", role: "member" } })).body.code).toBe("FK_ACCOUNT_EXISTS");

    const member = newClient("203.0.113.70");
    const done = await enroll(tokenOf(invite.body.link.url), member);
    expect(done.finish.body).toMatchObject({ purpose: "invite", account: { name: "Taylor", role: "member" } });
    expect((await enroll(tokenOf(invite.body.link.url), newClient())).begin.status).toBe(410);

    // A member works in the admin like before, but account and token management is for owners.
    await seedProjects();
    expect((await call("GET", "/api/admin/projects", { client: member })).status).toBe(200);
    for (const [method, path, body] of [["GET", "/api/admin/accounts"], ["POST", "/api/admin/accounts", { name: "X", role: "member" }], ["GET", "/api/admin/tokens"], ["POST", "/api/admin/tokens", { name: "x", access: "read", projects: null }]] as const) {
      const r = await call(method, path, { client: member, body });
      expect([r.status, r.body.code], `${method} ${path}`).toEqual([403, "FK_FORBIDDEN"]);
    }
    const list = await call("GET", "/api/admin/accounts", { client: owner });
    expect(list.body.accounts.map((a: { name: string; state: string }) => `${a.name}:${a.state}`).sort()).toEqual(["Robin:active", "Taylor:active"]);
    // A removed account is hidden until asked for.
    const taylor = list.body.accounts.find((a: { name: string }) => a.name === "Taylor").id as string;
    expect((await call("DELETE", `/api/admin/accounts/${taylor}`, { client: owner })).status).toBe(200);
    expect((await call("GET", "/api/admin/accounts", { client: owner })).body.accounts.map((a: { name: string }) => a.name)).toEqual(["Robin"]);
    const withRemoved = (await call("GET", "/api/admin/accounts?removed=1", { client: owner })).body.accounts;
    expect(withRemoved.map((a: { name: string; state: string }) => `${a.name}:${a.state}`)).toEqual(["Robin:active", "Taylor:removed"]);
    expect(withRemoved[1].removedAt).toEqual(expect.any(Number));
  });

  it("an expired invitation can be renewed; an owner's recovery needs the host", async () => {
    const { client: owner, accountId } = await bootstrap();
    const invite = await call("POST", "/api/admin/accounts", { client: owner, body: { name: "Taylor", role: "member" } });
    await env.DB.prepare("UPDATE setup_links SET expires_at = ?1").bind(Date.now() - 1).run();
    expect((await enroll(tokenOf(invite.body.link.url), newClient())).begin.status).toBe(410);
    const renewed = await call("POST", `/api/admin/accounts/${invite.body.account.id}/link`, { client: owner });
    expect(renewed.body).toMatchObject({ purpose: "invite" });
    expect((await enroll(tokenOf(renewed.body.link.url), newClient())).finish.status).toBe(201);
    const ownLink = await call("POST", `/api/admin/accounts/${accountId}/link`, { client: owner });
    expect([ownLink.status, ownLink.body.code]).toEqual([403, "FK_HOST_REQUIRED"]);
    // The member now has a passkey: a new link is a recovery link.
    const again = await call("POST", `/api/admin/accounts/${invite.body.account.id}/link`, { client: owner });
    expect(again.body.purpose).toBe("recovery");
  });

  it("removing an account signs it out and revokes its tokens", async () => {
    const { client: a } = await bootstrap();
    const invite = await call("POST", "/api/admin/accounts", { client: a, body: { name: "Sam", role: "owner" } });
    const b = newClient("203.0.113.80");
    expect((await enroll(tokenOf(invite.body.link.url), b)).finish.status).toBe(201);
    const token = (await call("POST", "/api/admin/tokens", { client: b, body: { name: "ci", access: "write", projects: null } })).body.token as string;
    expect((await call("GET", "/api/admin/projects", { client: newClient(), headers: { Authorization: `Bearer ${token}` }, origin: null })).status).toBe(200);
    const removed = await call("DELETE", `/api/admin/accounts/${invite.body.account.id}`, { client: a });
    expect(removed.status).toBe(200);
    expect((await call("GET", "/api/admin/me", { client: b })).status).toBe(401);
    const viaToken = await call("GET", "/api/admin/projects", { client: newClient(), headers: { Authorization: `Bearer ${token}` }, origin: null });
    expect([viaToken.status, viaToken.body.code]).toEqual([401, "FK_TOKEN_REVOKED"]);
    expect(await count("passkeys")).toBe(1);
  });
});

describe("recovery and API tokens", () => {
  const useToken = (token: string) => call("GET", "/api/admin/projects", { client: newClient("198.18.9.1"), headers: { Authorization: `Bearer ${token}` }, origin: null });
  const mint = async (client: Client) => (await call("POST", "/api/admin/tokens", { client, body: { name: "ci", access: "write", projects: null } })).body.token as string;

  it("recovery revokes the API tokens the account created, and says how many", async () => {
    const { client } = await bootstrap();
    const one = await mint(client);
    const two = await mint(client);
    expect((await useToken(one)).status).toBe(200);
    const recovery = await hostRecoveryLink(gw, { origin: BASE });
    const done = await enroll(tokenOf(recovery.url), newClient("203.0.113.120"));
    expect(done.finish.status).toBe(201);
    expect(done.finish.body.tokensRevoked).toBe(2);
    for (const t of [one, two]) {
      const r = await useToken(t);
      expect([r.status, r.body.code]).toEqual([401, "FK_TOKEN_REVOKED"]);
    }
    // The owner makes new ones afterwards, with the new session.
    const fresh = newClient("203.0.113.121");
    expect((await signIn(done.auth, fresh)).status).toBe(200);
    expect((await useToken(await mint(fresh))).status).toBe(200);
  });

  it("--keep-tokens (keepTokens) opts out, and tokens of other accounts are not touched", async () => {
    const { client: a } = await bootstrap();
    const invite = await call("POST", "/api/admin/accounts", { client: a, body: { name: "Sam", role: "owner" } });
    const b = newClient("203.0.113.122");
    await enroll(tokenOf(invite.body.link.url), b);
    const ownerToken = await mint(a);
    const samToken = await mint(b);
    const recovery = await hostRecoveryLink(gw, { origin: BASE, account: "Robin", keepTokens: true });
    expect((await enroll(tokenOf(recovery.url), newClient("203.0.113.123"))).finish.body.tokensRevoked).toBe(0);
    expect((await useToken(ownerToken)).status).toBe(200);
    const again = await hostRecoveryLink(gw, { origin: BASE, account: "Robin" });
    expect((await enroll(tokenOf(again.url), newClient("203.0.113.124"))).finish.body.tokensRevoked).toBe(1);
    expect((await useToken(ownerToken)).status).toBe(401);
    expect((await useToken(samToken)).status).toBe(200); // Sam's own tokens stay: only the recovered account's end
  });
});

describe("last owner and last passkey", () => {
  it("the last owner cannot be demoted or removed", async () => {
    const { client, accountId } = await bootstrap();
    const demote = await call("PATCH", `/api/admin/accounts/${accountId}`, { client, body: { role: "member" } });
    expect([demote.status, demote.body.code]).toEqual([409, "FK_LAST_OWNER"]);
    const remove = await call("DELETE", `/api/admin/accounts/${accountId}`, { client });
    expect([remove.status, remove.body.code]).toEqual([409, "FK_LAST_OWNER"]);
    expect(await count("accounts", "role = 'owner' AND state = 'active'")).toBe(1);
  });

  it("two owners who demote or remove each other at the same moment leave one owner", async () => {
    for (const action of ["demote", "remove"] as const) {
      await resetStorage();
      const { client: a, accountId: aId } = await bootstrap();
      const invite = await call("POST", "/api/admin/accounts", { client: a, body: { name: "Sam", role: "owner" } });
      const b = newClient("203.0.113.90");
      const joined = await enroll(tokenOf(invite.body.link.url), b);
      const bId = joined.finish.body.account.id as string;
      const hit = (client: Client, id: string) => (action === "demote" ? call("PATCH", `/api/admin/accounts/${id}`, { client, body: { role: "member" } }) : call("DELETE", `/api/admin/accounts/${id}`, { client }));
      const results = await Promise.all([hit(a, bId), hit(b, aId)]);
      expect(results.map((r) => r.status).sort(), action).toEqual([200, 409]);
      expect(await count("accounts", "role = 'owner' AND state = 'active'"), action).toBe(1);
    }
  });

  it("an owner can demote another owner and be demoted back", async () => {
    const { client: a } = await bootstrap();
    const invite = await call("POST", "/api/admin/accounts", { client: a, body: { name: "Sam", role: "owner" } });
    const joined = await enroll(tokenOf(invite.body.link.url), newClient("203.0.113.91"));
    const bId = joined.finish.body.account.id as string;
    expect((await call("PATCH", `/api/admin/accounts/${bId}`, { client: a, body: { role: "member" } })).status).toBe(200);
    expect((await call("PATCH", `/api/admin/accounts/${bId}`, { client: a, body: { role: "owner" } })).status).toBe(200);
  });

  it("the last passkey cannot be removed; another one can be added and then the first removed", async () => {
    const { client, auth } = await bootstrap();
    const account = await call("GET", "/api/admin/account", { client });
    expect(account.body.passkeys).toHaveLength(1);
    const only = account.body.passkeys[0].id as string;
    expect((await call("DELETE", `/api/admin/account/passkeys/${only}`, { client })).body.code).toBe("FK_LAST_PASSKEY");

    const second = await SoftAuthenticator.create();
    const begin = await call("POST", "/api/admin/account/passkeys/begin", { client });
    expect(begin.body.options.excludeCredentials.map((c: { id: string }) => c.id)).toEqual([only]);
    const added = await call("POST", "/api/admin/account/passkeys/finish", { client, body: { response: await second.register(begin.body.options), name: "Phone" } });
    expect(added.status).toBe(201);
    expect((await call("DELETE", `/api/admin/account/passkeys/${only}`, { client })).status).toBe(200);
    expect((await signIn(auth, newClient("203.0.113.92"))).status).toBe(401);
    expect((await signIn(second, newClient("203.0.113.93"))).status).toBe(200);
  });

  it("sessions: list, revoke one, revoke the others", async () => {
    const { client, auth } = await bootstrap();
    const phone = newClient("203.0.113.94");
    await signIn(auth, phone);
    const list = await call("GET", "/api/admin/account", { client });
    expect(list.body.sessions).toHaveLength(2);
    expect(list.body.sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    const other = list.body.sessions.find((s: { current: boolean }) => !s.current).id as string;
    expect((await call("DELETE", `/api/admin/account/sessions/${other}`, { client })).status).toBe(200);
    expect((await call("GET", "/api/admin/me", { client: phone })).status).toBe(401);
    await signIn(auth, phone);
    expect((await call("POST", "/api/admin/account/sessions/revoke-others", { client })).body).toMatchObject({ count: 1 });
    expect((await call("GET", "/api/admin/me", { client })).status).toBe(200);
  });
});

describe("ADMIN_TOKEN (S11)", () => {
  it("opens the admin until the first owner exists, and grants nothing afterwards", async () => {
    await seedProjects();
    const asLegacy = (e: Env) => call("GET", "/api/admin/projects", { client: newClient("203.0.113.100"), headers: { Authorization: `Bearer ${LEGACY}` }, origin: null, env: e });
    expect((await asLegacy(gwWithLegacy)).status).toBe(200);
    await bootstrap("Robin", newClient(), gwWithLegacy);
    const refused = await asLegacy(gwWithLegacy);
    expect([refused.status, refused.body.code]).toEqual([401, "FK_ADMIN_TOKEN_RETIRED"]);
    expect((await call("GET", "/api/admin/me", { client: newClient("203.0.113.101"), headers: { Authorization: `Bearer ${LEGACY}` }, origin: null, env: gwWithLegacy })).status).toBe(401);
  });
});

describe("scoped API tokens (J16)", () => {
  async function owner() {
    await seedProjects();
    return (await bootstrap()).client;
  }
  const bearer = (token: string, ip = "198.18.0.1") => ({ client: newClient(ip), headers: { Authorization: `Bearer ${token}` }, origin: null as null });
  const mint = async (client: Client, body: Record<string, unknown>) => {
    const r = await call("POST", "/api/admin/tokens", { client, body });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body as { token: string; id: string };
  };

  it("is created by an owner, shown once, hashed at rest, listed without the secret", async () => {
    const client = await owner();
    const t = await mint(client, { name: "release script", access: "read", projects: null, expiresInDays: 30 });
    expect(t.token).toMatch(/^fk_tok_[A-Za-z0-9_-]{43}$/);
    const list = await call("GET", "/api/admin/tokens", { client });
    expect(JSON.stringify(list.body)).not.toContain(t.token);
    expect(list.body.tokens[0]).toMatchObject({ name: "release script", access: "read", projects: null, state: "active", prefix: t.token.slice(0, 13) });
    expect(JSON.stringify((await env.DB.prepare("SELECT * FROM api_tokens").all()).results)).not.toContain(t.token);
    expect(logs.join("\n")).not.toContain(t.token);
  });

  it("validates its input", async () => {
    const client = await owner();
    for (const body of [{ name: "", access: "read" }, { name: "x", access: "admin" }, { name: "x", access: "read", expiresInDays: 0 }, { name: "x", access: "read", expiresInDays: 366 }, { name: "x", access: "read", projects: [] }, { name: "x", access: "read", projects: ["nope"] }]) {
      const r = await call("POST", "/api/admin/tokens", { client, body });
      expect([r.status, r.body.code], JSON.stringify(body)).toEqual([400, "FK_TOKEN_INVALID"]);
    }
  });

  it("works for automation and stops working the moment it is revoked", async () => {
    const client = await owner();
    const t = await mint(client, { name: "agent", access: "write", projects: null });
    const use = () => call("GET", "/api/admin/projects", bearer(t.token));
    expect((await use()).status).toBe(200);
    expect((await call("GET", "/api/admin/me", bearer(t.token))).body).toMatchObject({ via: "api-token", access: "write", projects: null });
    expect((await call("DELETE", `/api/admin/tokens/${t.id}`, { client })).status).toBe(200);
    const after = await use();
    expect([after.status, after.body.code]).toEqual([401, "FK_TOKEN_REVOKED"]);
    expect((await call("GET", "/api/admin/tokens", { client })).body.tokens[0].state).toBe("revoked");
  });

  it("read-only tokens cannot write; expired and unknown tokens are 401", async () => {
    const client = await owner();
    const ro = await mint(client, { name: "reader", access: "read", projects: null });
    const patch = await call("PATCH", "/api/admin/feedback/fb-other", { ...bearer(ro.token), body: { disposition: "done" } });
    expect([patch.status, patch.body.code]).toEqual([403, "FK_TOKEN_SCOPE"]);
    expect((await call("GET", "/api/admin/projects/demo/feedback", bearer(ro.token))).status).toBe(200);
    await env.DB.prepare("UPDATE api_tokens SET expires_at = ?1 WHERE id = ?2").bind(Date.now() - 1, ro.id).run();
    expect((await call("GET", "/api/admin/projects", bearer(ro.token))).body.code).toBe("FK_TOKEN_EXPIRED");
    expect((await call("GET", "/api/admin/projects", bearer("fk_tok_" + "x".repeat(43)))).body.code).toBe("FK_TOKEN_UNKNOWN");
    expect((await call("GET", "/api/admin/projects", bearer("not-a-token"))).status).toBe(401);
  });

  it("a token limited to some projects reaches only those, and nothing that is not about a project", async () => {
    const client = await owner();
    const t = await mint(client, { name: "demo only", access: "write", projects: ["demo"] });
    const as = (method: string, path: string, body?: unknown) => call(method, path, { ...bearer(t.token), body });
    expect((await as("GET", "/api/admin/projects/demo/config")).status).toBe(200);
    expect((await as("GET", "/api/admin/projects/other/config")).body.code).toBe("FK_TOKEN_SCOPE");
    expect((await as("GET", "/api/admin/projects/other/feedback")).status).toBe(403);
    expect((await as("GET", "/api/admin/projects")).body.projects.map((p: { id: string }) => p.id)).toEqual(["demo"]);
    expect((await as("PATCH", "/api/admin/feedback/fb-other", { disposition: "done" })).status).toBe(403); // a report of another project
    expect((await as("GET", "/api/admin/system")).status).toBe(403);
    expect((await as("POST", "/api/admin/projects", { config: projectConfig("new") })).status).toBe(403);
  });

  it("cannot manage accounts or tokens, and a member cannot create one", async () => {
    const client = await owner();
    const t = await mint(client, { name: "agent", access: "write", projects: null });
    for (const [method, path, body] of [["GET", "/api/admin/tokens"], ["POST", "/api/admin/tokens", { name: "y", access: "write", projects: null }], ["POST", "/api/admin/accounts", { name: "Y", role: "owner" }], ["GET", "/api/admin/account"]] as const) {
      const r = await call(method, path, { ...bearer(t.token), body });
      expect([r.status, r.body.code], `${method} ${path}`).toEqual([403, "FK_SESSION_REQUIRED"]);
    }
  });

  it("a valid token is not refused because other tokens failed (shared address, with and without a proxy)", async () => {
    const client = await owner();
    const t = await mint(client, { name: "agent", access: "read", projects: null });
    const attacker = "198.18.1.1";
    let limited = 0;
    for (let i = 0; i < 40; i++) {
      const r = await call("GET", "/api/admin/projects", bearer("fk_tok_" + String(i).padStart(43, "z"), attacker));
      if (r.status === 429) {
        limited++;
        expect(r.res.headers.get("Retry-After")).toMatch(/^\d+$/);
      } else expect(r.status).toBe(401);
    }
    expect(limited).toBeGreaterThan(0); // the throttle did something
    expect((await call("GET", "/api/admin/projects", bearer(t.token, attacker))).status).toBe(200); // behind one shared address, the valid token still works
    expect((await call("GET", "/api/admin/projects", bearer(t.token, "198.18.1.2"))).status).toBe(200); // and so does one from another address
  });
});

describe("failed sign-ins are throttled without refusing a valid one", () => {
  it("a client that fails 30 times gets 429 on the next failure, and still signs in with a valid passkey", async () => {
    const { auth } = await bootstrap();
    const shared = "198.18.2.1"; // one address for everybody, as behind a proxy without FK_TRUSTED_PROXY_HOPS
    const stranger = await SoftAuthenticator.create();
    const statuses: number[] = [];
    for (let i = 0; i < 35; i++) statuses.push((await signIn(stranger, newClient(shared))).status);
    expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(30).every((s) => s === 429)).toBe(true);
    const throttled = await signIn(stranger, newClient(shared));
    expect(throttled.body.code).toBe("FK_AUTH_THROTTLED");
    expect(throttled.res.headers.get("Retry-After")).toMatch(/^\d+$/);
    // The valid passkey from that same address: not refused.
    expect((await signIn(auth, newClient(shared))).status).toBe(200);
    // Another address was never affected.
    expect((await signIn(auth, newClient("198.18.2.2"))).status).toBe(200);
  });

  it("failures against one account, from many addresses, do not lock it out", async () => {
    const { auth } = await bootstrap();
    const results: number[] = [];
    for (let i = 0; i < 14; i++) results.push((await signIn(auth, newClient(`198.18.3.${i + 1}`), { badSignature: true })).status);
    expect(results.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(results.slice(10).every((s) => s === 429)).toBe(true);
    expect((await signIn(auth, newClient("198.18.3.200"))).status).toBe(200);
  });

  it("failed link redemptions count too, and a valid link still works", async () => {
    const link = await hostSetupLink(gw, { origin: BASE });
    const shared = "198.18.4.1";
    let last = 0;
    for (let i = 0; i < 35; i++) last = (await call("POST", "/api/auth/setup/begin", { client: newClient(shared), body: { token: `fk_link_${"q".repeat(40)}${i}` } })).status;
    expect(last).toBe(429);
    expect((await enroll(tokenOf(link.url), newClient(shared), { name: "Robin" })).finish.status).toBe(201);
  });
});

describe("what the account system never writes to the log", () => {
  it("no session, link or API token appears in any log line, and lines name accounts by id", async () => {
    const link = await hostSetupLink(gw, { origin: BASE });
    const client = newClient();
    await enroll(tokenOf(link.url), client, { name: "Robin" });
    const sessionToken = client.cookie!.split("=")[1]!;
    const t = await call("POST", "/api/admin/tokens", { client, body: { name: "ci", access: "write", projects: null } });
    await call("DELETE", `/api/admin/tokens/${t.body.id}`, { client });
    await call("GET", "/api/admin/projects", { client: newClient(), headers: { Authorization: `Bearer ${t.body.token}` }, origin: null });
    const all = logs.join("\n");
    for (const secret of [sessionToken, tokenOf(link.url), t.body.token as string]) expect(all).not.toContain(secret);
    expect(all).not.toMatch(/fk_(ses|link|tok)_[A-Za-z0-9_-]{20,}/);
    expect(all).not.toContain("Robin"); // names are data, ids are what the lines carry
    expect(all).toContain("owner_created");
  });
});

describe("the public state route", () => {
  it("tells an anonymous visitor of the admin whether to sign in or set up", async () => {
    const before = await call("GET", "/api/admin/me");
    expect([before.status, before.body.ownerExists]).toEqual([401, false]);
    await bootstrap();
    const after = await call("GET", "/api/admin/me", { client: newClient("203.0.113.130") });
    expect([after.status, after.body.ownerExists]).toEqual([401, true]);
  });

  it("says whether an owner exists and which relying party the passkeys bind to", async () => {
    expect((await call("GET", "/api/auth/state")).body).toMatchObject({ ownerExists: false, rpId: "localhost", origin: "http://localhost" });
    await bootstrap();
    expect((await call("GET", "/api/auth/state")).body.ownerExists).toBe(true);
    const https = await call("GET", "/api/auth/state", { client: newClient("203.0.113.5", "https://gw.example.org:8443") });
    expect(https.body).toMatchObject({ rpId: "gw.example.org", origin: "https://gw.example.org:8443" });
  });

  it("refuses a cross-site write to the ceremonies", async () => {
    expect((await call("POST", "/api/auth/signin/begin", { origin: "https://evil.example" })).body.code).toBe("FK_CSRF");
    expect((await call("POST", "/api/auth/setup/begin", { origin: "https://evil.example", body: { token: "x" } })).status).toBe(403);
  });
});
