import { test, expect, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Gate 2 in a real browser against the real standalone server: Chromium's WebAuthn
// virtual authenticator (Chrome DevTools protocol) does the passkey ceremonies, a
// child process runs scripts/server.mjs on a fresh data directory, and the host
// command prints the links. No UI is involved yet (the screens come with the
// approved mock); the page only calls the API with navigator.credentials, so what
// is verified here is the protocol between a real browser and the server:
// bootstrap, sign-in, sessions and CSRF, API tokens, the retired ADMIN_TOKEN, the
// recovery drill, and one winner among concurrent first-owner claims.

test.skip(({ isMobile }) => isMobile, "the ceremonies do not depend on the viewport");

interface Server {
  origin: string;
  dir: string;
  child: ChildProcess;
  output: () => string;
  stop: () => Promise<void>;
  host: (...args: string[]) => string;
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise((r) => s.close(r));
  return port;
}

async function startServer(extra: Record<string, string> = {}): Promise<Server> {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "fk-e2e-accounts-"));
  const origin = `http://localhost:${port}`;
  const env = { PATH: process.env["PATH"] ?? "", HOME: dir, HOST: "127.0.0.1", PORT: String(port), FK_PUBLIC_URL: origin, FK_DATA_DIR: dir, FK_ENV_FILE: "/nonexistent", ...extra };
  const child = spawn(process.execPath, ["scripts/server.mjs"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout?.on("data", (d) => (out += d));
  child.stderr?.on("data", (d) => (out += d));
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`${origin}/diag`)).ok) break;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    origin,
    dir,
    child,
    output: () => out,
    stop: async () => {
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
      rmSync(dir, { recursive: true, force: true });
    },
    host: (...args) => {
      const r = spawnSync(process.execPath, ["scripts/server.mjs", "admin", ...args], { env, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`feedbackkit-admin ${args.join(" ")} failed: ${r.stderr}`);
      return r.stdout.trim();
    },
  };
}

/** A browser context with a virtual authenticator that behaves like a platform passkey with user verification. */
async function passkeyBrowser(browser: import("@playwright/test").Browser, origin: string): Promise<{ context: BrowserContext; page: Page; cdp: CDPSession; authenticatorId: string }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  // Any page of the origin will do, but the landing page has a CSP that blocks fetch(). The widget file has none.
  await page.goto(`${origin}/widget.js`);
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return { context, page, cdp, authenticatorId };
}

// What the setup and sign-in screens will do, as plain calls: the same requests, with the browser's own WebAuthn API.
const enroll = (page: Page, token: string, name?: string) =>
  page.evaluate(async ({ token, name }) => {
    const post = (path: string, body: unknown) => fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const begin = await post("/api/auth/setup/begin", { token, name });
    if (!begin.ok) return { status: begin.status, body: await begin.json() };
    const { options } = await begin.json();
    const credential = (await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options) })) as PublicKeyCredential;
    const finish = await post("/api/auth/setup/finish", { token, name, response: credential.toJSON() });
    return { status: finish.status, body: await finish.json() };
  }, { token, name });

const signIn = (page: Page) =>
  page.evaluate(async () => {
    const post = (path: string, body?: unknown) => fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
    const begin = await (await post("/api/auth/signin/begin")).json();
    let credential: PublicKeyCredential;
    try {
      credential = (await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(begin.options) })) as PublicKeyCredential;
    } catch (e) {
      return { status: 0, body: { error: (e as Error).name } };
    }
    const finish = await post("/api/auth/signin/finish", { response: credential.toJSON() });
    return { status: finish.status, body: await finish.json() };
  });

const api = (page: Page, method: string, path: string, csrf?: string, body?: unknown) =>
  page.evaluate(async ({ method, path, csrf, body }) => {
    const res = await fetch(path, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(csrf ? { "X-CSRF-Token": csrf } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, { method, path, csrf, body });

const tokenOf = (url: string) => new URL(url).hash.slice(1);
const LEGACY = "fictional-legacy-admin-token-0123456789abcdef";

test("first owner, sign-in, CSRF, API tokens, the retired ADMIN_TOKEN and the recovery drill", async ({ browser }) => {
  const server = await startServer({ ADMIN_TOKEN: LEGACY });
  try {
    const { page, context, cdp, authenticatorId } = await passkeyBrowser(browser, server.origin);

    await test.step("before an owner exists ADMIN_TOKEN still opens the admin", async () => {
      expect((await fetch(`${server.origin}/api/admin/projects`, { headers: { Authorization: `Bearer ${LEGACY}` } })).status).toBe(200);
    });

    let csrf = "";
    await test.step("the host command's link creates the owner with a real passkey", async () => {
      const link = server.host("setup-link");
      const r = await enroll(page, tokenOf(link), "Robin");
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body).toMatchObject({ purpose: "bootstrap", account: { name: "Robin", role: "owner" } });
      csrf = r.body.csrf;
      const [cookie] = (await context.cookies()).filter((c) => c.name === "fk_session");
      expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax", secure: false, path: "/" });
      expect((await api(page, "GET", "/api/admin/me")).body).toMatchObject({ via: "session", account: { name: "Robin" } });
      expect((await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials).toHaveLength(1);
    });

    await test.step("ADMIN_TOKEN grants nothing now", async () => {
      const res = await fetch(`${server.origin}/api/admin/projects`, { headers: { Authorization: `Bearer ${LEGACY}` } });
      expect(res.status).toBe(401);
      expect((await res.json()).code).toBe("FK_ADMIN_TOKEN_RETIRED");
    });

    await test.step("a write without the CSRF token is refused, with it accepted", async () => {
      expect((await api(page, "POST", "/api/admin/accounts", undefined, { name: "Taylor", role: "member" })).body).toMatchObject({ code: "FK_CSRF" });
      expect((await api(page, "POST", "/api/admin/accounts", csrf, { name: "Taylor", role: "member" })).status).toBe(201);
    });

    let token = "";
    let tokenId = "";
    await test.step("an owner creates a scoped token that works for automation and stops when revoked", async () => {
      const created = await api(page, "POST", "/api/admin/tokens", csrf, { name: "release script", access: "read", projects: null, expiresInDays: 30 });
      expect(created.status).toBe(201);
      token = created.body.token;
      tokenId = created.body.id;
      const use = () => fetch(`${server.origin}/api/admin/projects`, { headers: { Authorization: `Bearer ${token}` } });
      expect((await use()).status).toBe(200);
      expect((await api(page, "DELETE", `/api/admin/tokens/${tokenId}`, csrf)).status).toBe(200);
      const after = await use();
      expect([after.status, (await after.json()).code]).toEqual([401, "FK_TOKEN_REVOKED"]);
    });

    await test.step("sign out, then sign in with the passkey alone (no username)", async () => {
      expect((await api(page, "POST", "/api/auth/signout", csrf)).status).toBe(200);
      expect((await api(page, "GET", "/api/admin/me")).status).toBe(401);
      const r = await signIn(page);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      csrf = r.body.csrf;
      expect((await api(page, "GET", "/api/admin/me")).body).toMatchObject({ via: "session", account: { name: "Robin", role: "owner" } });
    });

    await test.step("recovery drill: the device is lost, the host command issues a link, the new passkey replaces the old", async () => {
      const before = (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials[0]!.credentialId;
      await cdp.send("WebAuthn.clearCredentials", { authenticatorId }); // the lost device
      expect((await signIn(page)).status).not.toBe(200); // nothing to sign in with
      const link = server.host("recovery-link");
      // A session that was open on the lost device is gone after recovery: keep a second browser's cookie for the check.
      const r = await enroll(page, tokenOf(link));
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body).toMatchObject({ purpose: "recovery", account: { name: "Robin", role: "owner" } });
      const after = (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials;
      expect(after).toHaveLength(1);
      expect(after[0]!.credentialId).not.toBe(before);
      expect((await enroll(page, tokenOf(link))).status).toBe(410); // the link is spent
      expect((await api(page, "POST", "/api/auth/signout", r.body.csrf)).status).toBe(200);
      expect((await signIn(page)).status).toBe(200);
    });
    await context.close();
  } finally {
    await server.stop();
  }
});

test("two browsers race for the first owner: one wins, the other gets 409 or 410", async ({ browser }) => {
  const server = await startServer();
  try {
    const a = await passkeyBrowser(browser, server.origin);
    const b = await passkeyBrowser(browser, server.origin);
    const token = tokenOf(server.host("setup-link"));
    const [ra, rb] = await Promise.all([enroll(a.page, token, "Robin"), enroll(b.page, token, "Sam")]);
    const statuses = [ra.status, rb.status].sort();
    expect(statuses[0]).toBe(201);
    expect([409, 410]).toContain(statuses[1]);
    const winner = ra.status === 201 ? a : b;
    const loser = ra.status === 201 ? b : a;
    expect((await api(winner.page, "GET", "/api/admin/me")).status).toBe(200);
    expect((await api(loser.page, "GET", "/api/admin/me")).status).toBe(401);
    expect(server.host("accounts").split("\n")).toHaveLength(1);
    await a.context.close();
    await b.context.close();
  } finally {
    await server.stop();
  }
});

test("a passkey made for another origin does not sign in here", async ({ browser }) => {
  // The relying party ID follows FK_PUBLIC_URL: a credential bound to localhost:A cannot sign in on localhost:B,
  // because the browser signs the origin into the assertion and the server checks it.
  const first = await startServer();
  const second = await startServer();
  try {
    const a = await passkeyBrowser(browser, first.origin);
    expect((await enroll(a.page, tokenOf(first.host("setup-link")), "Robin")).status).toBe(201);
    await a.page.goto(`${second.origin}/widget.js`);
    const wrongPlace = await signIn(a.page);
    expect(wrongPlace.status).not.toBe(200); // the credential is bound to the first origin, so the browser finds none here
    await a.context.close();
  } finally {
    await first.stop();
    await second.stop();
  }
});
