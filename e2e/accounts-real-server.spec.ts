import { test, expect, type Browser, type Page } from "@playwright/test";
import { api, newDevice, startServer, tokenOf } from "./accounts-harness";

// The protocol between a real browser and the real standalone server, without the
// screens (accounts-ui.spec.ts clicks those): Chromium's WebAuthn virtual
// authenticator does the passkey ceremonies, and the page only calls the API with
// navigator.credentials. Covered: bootstrap, sign-in, sessions and CSRF, API
// tokens, the retired ADMIN_TOKEN, the recovery drill, and one winner among
// concurrent first-owner claims.

test.skip(({ isMobile }) => isMobile, "the ceremonies do not depend on the viewport");

async function passkeyBrowser(browser: Browser, origin: string) {
  const device = await newDevice(browser);
  // Any page of the origin will do, but the landing page has a CSP that blocks fetch(). The widget file has none.
  await device.page.goto(`${origin}/widget.js`);
  return device;
}

// The same requests as the setup and sign-in screens, as plain calls with the browser's own WebAuthn API.
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
    expect(server.host("users").split("\n")).toHaveLength(1);
    expect(server.host("accounts")).toBe(server.host("users")); // the old name of the command
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
