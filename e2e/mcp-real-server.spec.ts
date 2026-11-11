import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// MCP with accounts in a real browser against the real standalone server (ADR-015, second amendment). Chromium's WebAuthn
// virtual authenticator makes the owner and a member with real passkeys (the same ceremonies as accounts-real-server.spec.ts),
// the server is scripts/server.mjs in a child process with MCP on, and the consent page is the real page: the browser holds the
// session cookie, opens the page an MCP client would open, and a real click on Allow ends the OAuth flow. Then a token created
// through the API is a bearer on /mcp, and removing the member ends the connection the member approved.
// No MCP client product is involved: the requests are the ones the MCP SDK's client sends, made with fetch.

test.skip(({ isMobile }) => isMobile, "the ceremonies and the consent page do not depend on the viewport");

interface Server {
  origin: string;
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

async function startServer(): Promise<Server> {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "fk-e2e-mcp-"));
  const origin = `http://localhost:${port}`;
  // http://localhost is the one http address MCP accepts, and only on loopback: FK_MCP=on says it is a test.
  const env = { PATH: process.env["PATH"] ?? "", HOME: dir, HOST: "127.0.0.1", PORT: String(port), FK_PUBLIC_URL: origin, FK_DATA_DIR: dir, FK_MCP: "on", FK_ENV_FILE: "/nonexistent" };
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

async function passkeyBrowser(browser: Browser, origin: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${origin}/widget.js`); // an origin page without a CSP, so fetch() works
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  return { context, page };
}

const enroll = (page: Page, token: string, name?: string) =>
  page.evaluate(
    async ({ token, name }) => {
      const post = (path: string, body: unknown) => fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const begin = await post("/api/auth/setup/begin", { token, name });
      if (!begin.ok) return { status: begin.status, body: await begin.json() };
      const { options } = await begin.json();
      const credential = (await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options) })) as PublicKeyCredential;
      const finish = await post("/api/auth/setup/finish", { token, name, response: credential.toJSON() });
      return { status: finish.status, body: await finish.json() };
    },
    { token, name },
  );

const api = (page: Page, method: string, path: string, csrf?: string, body?: unknown) =>
  page.evaluate(
    async ({ method, path, csrf, body }) => {
      const res = await fetch(path, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(csrf ? { "X-CSRF-Token": csrf } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    { method, path, csrf, body },
  );

const tokenOf = (url: string) => new URL(url).hash.slice(1);
const REDIRECT = "http://127.0.0.1:9/callback"; // a loopback redirect nothing listens on: the address bar carries the result

/** What an MCP client does before it sends the person to the consent page. */
async function registerClient(origin: string): Promise<{ clientId: string; verifier: string; consentUrl: string }> {
  const reg = await (await fetch(`${origin}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Browser test client", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }) })).json();
  const verifier = randomBytes(40).toString("base64url");
  const q = new URLSearchParams({
    response_type: "code",
    client_id: reg.client_id,
    redirect_uri: REDIRECT,
    scope: "feedback:read config:read",
    state: "st",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource: `${origin}/mcp`,
  });
  return { clientId: reg.client_id, verifier, consentUrl: `${origin}/oauth/authorize?${q}` };
}

const mcp = (origin: string, bearer: string, method = "tools/list", params: unknown = {}) =>
  fetch(`${origin}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });

/** Opens the consent page in a fresh tab of the signed-in browser and clicks Allow; returns the authorization code the redirect carries. */
async function approve(context: BrowserContext, consentUrl: string): Promise<string> {
  const page = await context.newPage();
  await page.goto(consentUrl);
  await expect(page.getByRole("button", { name: "Allow" })).toBeVisible();
  // The redirect goes to a port nothing listens on, so the tab lands on the browser's error page; the request carries the code.
  const callback = page.waitForRequest((r) => r.url().startsWith(REDIRECT));
  await page.getByRole("button", { name: "Allow" }).click();
  const code = new URL((await callback).url()).searchParams.get("code");
  expect(code).toBeTruthy();
  await page.close();
  return code!;
}

async function exchange(origin: string, clientId: string, verifier: string, code: string): Promise<string> {
  const res = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: `${origin}/mcp` }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { access_token: string }).access_token;
}

test("an owner and a member approve connections with their passkey sessions, a token reads, and removing the member ends their connection", async ({ browser }) => {
  const server = await startServer();
  try {
    expect(server.output()).toMatch(/MCP on \(issuer http:\/\/localhost:\d+/);
    const owner = await passkeyBrowser(browser, server.origin);
    const member = await passkeyBrowser(browser, server.origin);

    await test.step("a real passkey makes the owner, who then invites a member", async () => {
      const r = await enroll(owner.page, tokenOf(server.host("setup-link")), "Robin");
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      (owner as unknown as { csrf: string }).csrf = r.body.csrf;
    });
    const csrf = (owner as unknown as { csrf: string }).csrf;

    await test.step("without a session the consent page sends the person to sign in and grants nothing", async () => {
      const { consentUrl } = await registerClient(server.origin);
      const anonymous = await browser.newContext();
      const page = await anonymous.newPage();
      const res = await page.goto(consentUrl);
      expect(res!.status()).toBe(403);
      await expect(page.locator("body")).toContainText("Sign-in required");
      await expect(page.locator("body")).toContainText(`${server.origin}/admin`);
      await expect(page.getByRole("button", { name: "Allow" })).toHaveCount(0);
      await anonymous.close();
    });

    await test.step("the owner's session approves an OAuth connection with a real click, and the connection works", async () => {
      const { clientId, verifier, consentUrl } = await registerClient(server.origin);
      const look = await owner.context.newPage();
      await look.goto(consentUrl);
      await expect(look.locator("body")).toContainText("Signed in as");
      await expect(look.locator("body")).toContainText("Robin");
      await look.close();
      const code = await approve(owner.context, consentUrl);
      const access = await exchange(server.origin, clientId, verifier, code);
      const list = await mcp(server.origin, access);
      expect(list.status).toBe(200);
      expect(await list.text()).toContain("list_projects");
      const who = await (await mcp(server.origin, access, "tools/call", { name: "whoami", arguments: {} })).text();
      expect(who).toContain("Robin");
    });

    await test.step("Cancel sends the client away with access_denied", async () => {
      const { consentUrl } = await registerClient(server.origin);
      const page = await owner.context.newPage();
      await page.goto(consentUrl);
      const callback = page.waitForRequest((r) => r.url().startsWith(REDIRECT));
      await page.getByRole("button", { name: "Cancel" }).click();
      expect(new URL((await callback).url()).searchParams.get("error")).toBe("access_denied");
      await page.close();
    });

    let memberAccess = "";
    await test.step("a member, made by the owner's invitation and a second passkey, approves their own connection", async () => {
      const created = await api(owner.page, "POST", "/api/admin/accounts", csrf, { name: "Taylor", role: "member" });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const r = await enroll(member.page, tokenOf(created.body.link.url));
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      const { clientId, verifier, consentUrl } = await registerClient(server.origin);
      const look = await member.context.newPage();
      await look.goto(consentUrl);
      await expect(look.locator("body")).toContainText("Taylor");
      await look.close();
      memberAccess = await exchange(server.origin, clientId, verifier, await approve(member.context, consentUrl));
      expect((await mcp(server.origin, memberAccess)).status).toBe(200);
    });

    let token = "";
    await test.step("an owner's scoped token is a bearer, read-only, and stops when revoked", async () => {
      const created = await api(owner.page, "POST", "/api/admin/tokens", csrf, { name: "litellm", access: "write", projects: null, expiresInDays: 30 });
      expect(created.status).toBe(201);
      token = created.body.token;
      const res = await mcp(server.origin, token);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("get_config");
      expect(text).not.toContain(token);
      expect((await api(owner.page, "DELETE", `/api/admin/tokens/${created.body.id}`, csrf)).status).toBe(200);
      const after = await mcp(server.origin, token);
      expect(after.status).toBe(401);
      expect(await after.text()).toContain("revoked");
    });

    await test.step("removing the member ends the connection they approved, and the owner's connection stays", async () => {
      const accounts = await api(owner.page, "GET", "/api/admin/accounts");
      const taylor = (accounts.body.accounts as Array<{ id: string; name: string }>).find((a) => a.name === "Taylor")!;
      expect((await api(owner.page, "DELETE", `/api/admin/accounts/${taylor.id}`, csrf)).status).toBe(200);
      const ended = await mcp(server.origin, memberAccess);
      expect(ended.status).toBe(401);
      expect(await ended.text()).toContain("no longer active");
    });

    await test.step("no token, session or code reached the process output", async () => {
      expect(server.output()).not.toContain(token);
      expect(server.output()).not.toContain(memberAccess);
      expect(server.output()).not.toMatch(/fk_ses_|fk_tok_/);
    });

    await owner.context.close();
    await member.context.close();
  } finally {
    await server.stop();
  }
});
