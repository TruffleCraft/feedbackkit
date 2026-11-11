import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { api, copyPasskeys, newDevice, replaceAuthenticator, startServer, syncPasskeys, tokenOf, type Device, type Server } from "./accounts-harness";

// The account screens (Gate 2) in a real Chrome against the real standalone
// server: every control is clicked, and the passkey ceremonies run on Chromium's
// virtual authenticator. The names are made up. With FK_SHOTS_DIR set, the run also
// writes the screenshots that go into the PR.

test.skip(({ isMobile }) => isMobile, "the phone layout is checked below with an explicit viewport");
test.setTimeout(120_000);

const SHOTS = process.env["FK_SHOTS_DIR"];
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
};

const PROJECT = (id: string) => ({ projectId: id, templates: [{ type: "bug", label: "Bug" }], llm: { provider: "off" }, tracker: { kind: "github", defaultRepo: "acme/site", patSecret: "GITHUB_PAT_default" }, auth: { origins: [] } });
const csrfOf = async (page: Page): Promise<string> => (await api(page, "GET", "/api/admin/me")).body.csrf;
const dialog = (page: Page) => page.locator("dialog[open]");
const row = (list: Locator, text: string) => list.locator(":scope > *").filter({ hasText: text });

/** Opens the setup link and clicks through the first-owner screen. */
async function createOwner(server: Server, device: Device, name: string) {
  await device.page.goto(server.host("setup-link"));
  await expect(device.page.getByRole("heading", { name: "Set up the first owner" })).toBeVisible();
  await device.page.getByLabel("Your name").fill(name);
  await device.page.getByRole("button", { name: "Create passkey" }).click();
  await expect(device.page.getByRole("heading", { name: "Passkey created" })).toBeVisible();
}

/** The page must have no horizontal scroll and no blocked inline code or style. */
const watch = (page: Page) => {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to/.test(m.text())) problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(e.message));
  return problems;
};

test("an owner works through every screen: setup, account, sessions, accounts, invitations, tokens, sign-out and recovery", async ({ browser }) => {
  const server = await startServer();
  const a = await newDevice(browser, { viewport: { width: 1100, height: 820 }, permissions: ["clipboard-read", "clipboard-write"] });
  const b = await newDevice(browser);
  const c = await newDevice(browser);
  const problems = watch(a.page);
  try {
    const page = a.page;

    await test.step("setup: the first owner creates a passkey with the link from the host command", async () => {
      await page.goto(`${server.origin}/admin/setup`);
      await expect(page.getByRole("heading", { name: "Open the setup link" })).toBeVisible();
      await shot(page, "setup-no-link");
      const link = server.host("setup-link");
      await page.goto(link);
      await expect(page.getByRole("heading", { name: "Set up the first owner" })).toBeVisible();
      expect(page.url()).not.toContain("#"); // the token left the address bar
      await shot(page, "setup-first-owner");
      await page.getByRole("button", { name: "Create passkey" }).click();
      await expect(page.locator("#st-msg")).toBeVisible(); // no name yet
      await page.getByLabel("Your name").fill("Robin");
      await page.getByRole("button", { name: "Create passkey" }).click();
      await expect(page.getByRole("heading", { name: "Passkey created" })).toBeVisible();
      await expect(page.locator("#st-done-who")).toHaveText("Robin, owner");
      await expect(page.locator("#st-done-note")).toContainText("Add a second passkey in Your account");
      await shot(page, "setup-done");
      await page.getByRole("link", { name: "Open the admin" }).click();
      await expect(page).toHaveURL(`${server.origin}/admin`);
      await expect(page.locator("#who")).toContainText("Signed in as Robin");
      await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    });

    await test.step("the name in the header leads to the account page", async () => {
      await page.locator("#who").getByRole("link", { name: "Robin" }).click();
      await expect(page).toHaveURL(`${server.origin}/admin/account`);
      await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
      await expect(page.locator("#acct-sub")).toHaveText("Robin · owner");
    });

    await test.step("account: one passkey cannot be removed, and the page says why", async () => {
      await expect(page.locator("#one-pk")).toBeVisible();
      await expect(row(page.locator("#pk-list"), "Created").getByRole("button", { name: "Remove" })).toBeDisabled();
      await expect(page.locator("#revoke-others")).toBeDisabled();
      await shot(page, "account-one-passkey");
    });

    await test.step("account: add a passkey on a new device, cancel once, then save", async () => {
      await replaceAuthenticator(a); // the first passkey stays on the old device, which is gone; the new one has none yet
      await page.getByRole("button", { name: "Add a passkey" }).click();
      await expect(dialog(page).getByRole("heading", { name: "Add a passkey" })).toBeVisible();
      await dialog(page).getByRole("button", { name: "Cancel" }).click();
      await expect(dialog(page)).toHaveCount(0);
      await page.getByRole("button", { name: "Add a passkey" }).click();
      await dialog(page).getByLabel("Name").fill("Security key");
      await shot(page, "account-add-passkey");
      await dialog(page).getByRole("button", { name: "Create passkey" }).click();
      await expect(dialog(page)).toHaveCount(0);
      await expect(page.locator("#pk-list > div")).toHaveCount(2);
      await expect(page.locator("#one-pk")).toBeHidden();
      await shot(page, "account-two-passkeys");
    });

    await test.step("account: remove the old passkey (cancel first, then confirm)", async () => {
      const old = page.locator("#pk-list > div").filter({ hasNotText: "Security key" });
      await old.getByRole("button", { name: "Remove" }).click();
      await expect(dialog(page).getByRole("heading", { name: /^Remove Passkey/ })).toBeVisible();
      await dialog(page).getByRole("button", { name: "Cancel" }).click();
      await expect(page.locator("#pk-list > div")).toHaveCount(2);
      await old.getByRole("button", { name: "Remove" }).click();
      await dialog(page).getByRole("button", { name: "Remove passkey" }).click();
      await expect(page.locator("#pk-list > div")).toHaveCount(1);
      await expect(page.locator("#pk-list")).toContainText("Security key");
      await expect(page.locator("#one-pk")).toBeVisible();
    });

    await test.step("sessions: a second browser signs in, then one session and then all others are revoked", async () => {
      await copyPasskeys(a, b);
      await b.page.goto(`${server.origin}/admin/sign-in`);
      await expect(b.page.getByRole("heading", { name: "Sign in" })).toBeVisible();
      await b.page.getByRole("button", { name: "Sign in with a passkey" }).click();
      await expect(b.page).toHaveURL(`${server.origin}/admin`);
      await page.reload();
      await expect(page.locator("#ses-list > div")).toHaveCount(2);
      await expect(page.locator("#revoke-others")).toBeEnabled();
      await shot(page, "account-two-sessions");
      await page.locator("#ses-list > div").filter({ hasNotText: "This browser" }).getByRole("button", { name: "Revoke" }).click();
      await expect(page.locator("#ses-list > div")).toHaveCount(1);
      await b.page.goto(`${server.origin}/admin/account`);
      await expect(b.page).toHaveURL(`${server.origin}/admin/sign-in`); // the revoked session is gone
      await b.page.getByRole("button", { name: "Sign in with a passkey" }).click();
      await expect(b.page).toHaveURL(`${server.origin}/admin`);
      await page.reload();
      await expect(page.locator("#ses-list > div")).toHaveCount(2);
      await page.getByRole("button", { name: "Revoke all other sessions" }).click();
      await expect(page.locator("#ses-list > div")).toHaveCount(1);
      await expect(page.locator("#revoke-others")).toBeDisabled();
      await syncPasskeys(b, a); // B signed in with its copy, so A needs the newer sign counter
    });

    await test.step("accounts: the only owner cannot be demoted or removed, and the page says why", async () => {
      await page.getByRole("link", { name: "Accounts", exact: true }).click();
      await expect(page).toHaveURL(`${server.origin}/admin/accounts`);
      const robin = row(page.locator("#acct-list"), "Robin");
      await expect(robin).toContainText("(you)");
      await expect(robin.getByRole("button", { name: "Make member" })).toBeDisabled();
      await expect(robin.getByRole("button", { name: "Remove" })).toBeDisabled();
      await expect(robin).toContainText("the only owner");
      await shot(page, "accounts-only-owner");
    });

    let invitation = "";
    await test.step("accounts: invite someone (an empty name is refused), copy the link, make a new link", async () => {
      await page.getByRole("button", { name: "Invite someone" }).click();
      await dialog(page).getByRole("button", { name: "Create invitation" }).click();
      await expect(dialog(page).locator("#inv-msg")).toContainText("Enter a name");
      await dialog(page).getByLabel("Name").fill("Taylor");
      await shot(page, "accounts-invite");
      await dialog(page).getByRole("button", { name: "Create invitation" }).click();
      await expect(dialog(page).getByRole("heading", { name: "Invitation for Taylor" })).toBeVisible();
      invitation = await dialog(page).locator("#inv-link-out").inputValue();
      expect(invitation).toMatch(/\/admin\/setup#fk_link_/);
      await dialog(page).getByRole("button", { name: "Copy link" }).click();
      await expect(dialog(page).getByRole("button", { name: "Copied" })).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(invitation);
      await shot(page, "accounts-invitation-link");
      await dialog(page).getByRole("button", { name: "Done" }).click();
      const taylor = row(page.locator("#acct-list"), "Taylor");
      await expect(taylor).toContainText("Invited");
      await taylor.getByRole("button", { name: "New link" }).click();
      const fresh = await dialog(page).locator("#inv-link-out2").inputValue();
      expect(fresh).not.toBe(invitation);
      await dialog(page).getByRole("button", { name: "Done" }).click();
      invitation = fresh;
    });

    await test.step("the invited person opens the link, creates a passkey and sees only what a member may", async () => {
      await c.page.goto(invitation);
      await expect(c.page.getByRole("heading", { name: "Join FeedbackKit" })).toBeVisible();
      await expect(c.page.locator("#st-p")).toContainText("finish the account for Taylor");
      await expect(c.page.locator("#st-name-field")).toBeHidden();
      await shot(c.page, "setup-invitation");
      await c.page.getByRole("button", { name: "Create passkey" }).click();
      await expect(c.page.getByRole("heading", { name: "Passkey created" })).toBeVisible();
      await expect(c.page.locator("#st-done-who")).toHaveText("Taylor, member");
      await c.page.getByRole("link", { name: "Open the admin" }).click();
      await expect(c.page.getByRole("heading", { name: "Projects" })).toBeVisible();
      await c.page.goto(`${server.origin}/admin/accounts`);
      await expect(c.page.getByRole("heading", { name: "Only owners can manage Accounts" })).toBeVisible();
      await c.page.goto(`${server.origin}/admin/tokens`);
      await expect(c.page.getByRole("heading", { name: "Only owners can manage API tokens" })).toBeVisible();
      await shot(c.page, "tokens-member-denied");
      await c.page.goto(`${server.origin}/admin/account`);
      await expect(c.page.locator("#acct-sub")).toHaveText("Taylor · member");
      await expect(c.page.locator("#area-nav")).toBeHidden();
      expect((await api(page, "GET", "/api/admin/accounts")).body.accounts).toHaveLength(2);
      expect((await api(c.page,"POST", "/api/auth/setup/begin", undefined, { token: tokenOf(invitation), name: "Taylor" })).status).toBe(410);
    });

    await test.step("accounts: make an owner (cancel first), make a member, remove, show removed", async () => {
      await page.reload();
      const taylor = row(page.locator("#acct-list"), "Taylor");
      await expect(taylor).toContainText("Active");
      await taylor.getByRole("button", { name: "Make owner" }).click();
      await expect(dialog(page).getByRole("heading", { name: "Make Taylor an owner?" })).toBeVisible();
      await shot(page, "accounts-make-owner");
      await dialog(page).getByRole("button", { name: "Cancel" }).click();
      await expect(taylor).toContainText("Member");
      await taylor.getByRole("button", { name: "Make owner" }).click();
      await dialog(page).getByRole("button", { name: "Make owner" }).click();
      await expect(taylor).toContainText("Owner");
      await expect(page.locator("#accts-sub")).toHaveText("2 accounts · 2 owners");
      await expect(row(page.locator("#acct-list"), "Robin").getByRole("button", { name: "Make member" })).toBeEnabled(); // two owners now
      await taylor.getByRole("button", { name: "Make member" }).click();
      await dialog(page).getByRole("button", { name: "Make member" }).click();
      await expect(taylor).toContainText("Member");
      await taylor.getByRole("button", { name: "Remove" }).click();
      await expect(dialog(page).getByRole("heading", { name: "Remove Taylor?" })).toBeVisible();
      await shot(page, "accounts-remove");
      await dialog(page).getByRole("button", { name: "Cancel" }).click();
      await expect(taylor).toHaveCount(1);
      await taylor.getByRole("button", { name: "Remove" }).click();
      await dialog(page).getByRole("button", { name: "Remove Taylor" }).click();
      await expect(row(page.locator("#acct-list"), "Taylor")).toHaveCount(0);
      await expect(page.locator("#accts-sub")).toHaveText("1 account · 1 owner");
      const chip = page.getByRole("button", { name: "Show removed" });
      await chip.click();
      await expect(chip).toHaveAttribute("aria-pressed", "true");
      const gone = row(page.locator("#acct-list"), "Taylor");
      await expect(gone).toContainText("Removed");
      await expect(gone.getByRole("button")).toHaveCount(0);
      await shot(page, "accounts-show-removed");
      await chip.click();
      await expect(row(page.locator("#acct-list"), "Taylor")).toHaveCount(0);
      await c.page.goto(`${server.origin}/admin/account`);
      await expect(c.page).toHaveURL(`${server.origin}/admin/sign-in`); // Taylor's session ended with the removal
    });

    let readToken = "";
    await test.step("tokens: the empty page, the form checks, a read token for all projects", async () => {
      await page.getByRole("link", { name: "API tokens" }).click();
      await expect(page.getByText("No API tokens yet")).toBeVisible();
      await shot(page, "tokens-empty");
      await page.locator("#tok-open").click();
      await dialog(page).locator("#tok-go").click();
      await expect(dialog(page).locator("#tok-msg")).toContainText("Give the token a name");
      await dialog(page).getByLabel("Name").fill("Setup agent");
      await expect(dialog(page).getByRole("radio", { name: /^Read/ })).toBeChecked(); // the safe default
      await shot(page, "tokens-create");
      await dialog(page).locator("#tok-go").click();
      await expect(dialog(page).getByRole("heading", { name: "Copy your token" })).toBeVisible();
      readToken = await dialog(page).locator("#tok-out").inputValue();
      expect(readToken).toMatch(/^fk_tok_/);
      await dialog(page).getByRole("button", { name: "Copy token" }).click();
      await expect(dialog(page).getByRole("button", { name: "Copied" })).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(readToken);
      await shot(page, "tokens-shown-once");
      await dialog(page).getByRole("button", { name: "Done" }).click();
      await expect(page.locator("#tok-out")).toHaveValue(""); // the token does not stay in the page
      const setup = row(page.locator("#tok-list"), "Setup agent");
      await expect(setup).toContainText("Read");
      await expect(setup).toContainText("All projects");
      await expect(setup).toContainText("Active");
      expect((await fetch(`${server.origin}/api/admin/projects`, { headers: { Authorization: `Bearer ${readToken}` } })).status).toBe(200);
    });

    let writeToken = "";
    await test.step("tokens: a write token for one project works there and nowhere else", async () => {
      const csrf = await csrfOf(page);
      expect((await api(page, "POST", "/api/admin/projects", csrf, { config: PROJECT("harborline") })).status).toBe(201);
      expect((await api(page, "POST", "/api/admin/projects", csrf, { config: PROJECT("ledgerkite-docs") })).status).toBe(201);
      await page.locator("#tok-open").click();
      await dialog(page).getByLabel("Name").fill("Release script");
      await dialog(page).getByRole("radio", { name: /^Write/ }).check();
      await dialog(page).getByRole("radio", { name: /^Only these projects/ }).check();
      await expect(dialog(page).locator("#tk-projects input")).toHaveCount(2);
      await dialog(page).locator("#tok-go").click();
      await expect(dialog(page).locator("#tok-msg")).toContainText("Choose at least one project");
      await dialog(page).locator("#tk-projects").getByLabel("harborline").check();
      await dialog(page).locator("#tk-exp").selectOption("30");
      await shot(page, "tokens-create-projects");
      await dialog(page).locator("#tok-go").click();
      await expect(dialog(page).getByRole("heading", { name: "Copy your token" })).toBeVisible();
      writeToken = await dialog(page).locator("#tok-out").inputValue();
      expect(writeToken).toMatch(/^fk_tok_/);
      expect(writeToken).not.toBe(readToken);
      await dialog(page).getByRole("button", { name: "Done" }).click();
      const release = row(page.locator("#tok-list"), "Release script");
      await expect(release).toContainText("Write");
      await expect(release).toContainText("harborline");
      const use = (path: string, init: RequestInit = {}) => fetch(`${server.origin}${path}`, { ...init, headers: { Authorization: `Bearer ${writeToken}`, "Content-Type": "application/json" } });
      const listed = (await (await use("/api/admin/projects")).json()) as { projects: Array<{ id: string }> };
      expect(listed.projects.map((p) => p.id)).toEqual(["harborline"]);
      expect((await use("/api/admin/projects/harborline/config")).status).toBe(200);
      expect((await use("/api/admin/projects/ledgerkite-docs/config")).status).toBe(403);
      expect((await use("/api/admin/projects", { method: "POST", body: JSON.stringify({ config: PROJECT("third") }) })).status).toBe(403);
      expect((await use("/api/admin/tokens")).status).toBe(403); // a token never manages tokens
      await shot(page, "tokens-two");
    });

    await test.step("tokens: revoke (cancel first, then confirm); the token stops working", async () => {
      const setup = row(page.locator("#tok-list"), "Setup agent");
      await setup.getByRole("button", { name: "Revoke" }).click();
      await expect(dialog(page).getByRole("heading", { name: "Revoke Setup agent?" })).toBeVisible();
      await shot(page, "tokens-revoke");
      await dialog(page).getByRole("button", { name: "Cancel" }).click();
      await expect(setup.getByRole("button", { name: "Revoke" })).toBeVisible();
      await setup.getByRole("button", { name: "Revoke" }).click();
      await dialog(page).getByRole("button", { name: "Revoke token" }).click();
      await expect(setup).toContainText("Revoked");
      await expect(setup.getByRole("button")).toHaveCount(0);
      const after = await fetch(`${server.origin}/api/admin/projects`, { headers: { Authorization: `Bearer ${readToken}` } });
      expect([after.status, ((await after.json()) as { code: string }).code]).toEqual([401, "FK_TOKEN_REVOKED"]);
    });

    await test.step("sign out from the header and sign in again with the passkey", async () => {
      await page.getByRole("button", { name: "Sign out" }).click();
      await expect(page).toHaveURL(`${server.origin}/admin/sign-in`);
      await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toBeVisible();
      await shot(page, "sign-in");
      await page.getByRole("button", { name: "Sign in with a passkey" }).click();
      await expect(page).toHaveURL(`${server.origin}/admin`);
      await page.goto(`${server.origin}/admin/account`);
      await page.locator("#ses-list").getByRole("button", { name: "Sign out" }).click(); // the sign-out in the session row
      await expect(page).toHaveURL(`${server.origin}/admin/sign-in`);
      await page.getByRole("button", { name: "Sign in with a passkey" }).click();
      await expect(page).toHaveURL(`${server.origin}/admin`);
    });

    await test.step("recovery: the device is lost, the host command issues a link, the API tokens it created are revoked", async () => {
      await syncPasskeys(a, b); // A signed in since B last did
      await b.page.goto(`${server.origin}/admin/sign-in`);
      await b.page.getByRole("button", { name: "Sign in with a passkey" }).click();
      await expect(b.page).toHaveURL(`${server.origin}/admin`); // a session on another browser, which the recovery must end
      await api(page, "POST", "/api/auth/signout", await csrfOf(page));
      await a.cdp.send("WebAuthn.clearCredentials", { authenticatorId: a.authenticatorId });
      await page.goto(`${server.origin}/admin/sign-in`);
      await page.getByRole("button", { name: "Sign in with a passkey" }).click();
      await expect(page.locator("#signin-msg")).toContainText("No passkey for this site was found");
      await page.getByText("Locked out? Recover access on the server.").click();
      await expect(page.getByText("feedbackkit-admin recovery-link")).toBeVisible();
      await shot(page, "sign-in-locked-out");
      await page.goto(server.host("recovery-link"));
      await expect(page.getByRole("heading", { name: "Recover access" })).toBeVisible();
      await expect(page.locator("#st-warn")).toContainText("Your old passkeys and sessions will be replaced");
      await expect(page.locator("#st-who")).toHaveText("Robin");
      await expect(page.locator("#st-name-field")).toBeHidden();
      await shot(page, "setup-recovery");
      await page.getByRole("button", { name: "Create new passkey" }).click();
      await expect(page.getByRole("heading", { name: "Passkey created" })).toBeVisible();
      await expect(page.locator("#st-done-note")).toContainText("1 API token you created was revoked");
      await shot(page, "setup-recovery-done");
      const after = await fetch(`${server.origin}/api/admin/projects`, { headers: { Authorization: `Bearer ${writeToken}` } });
      expect([after.status, ((await after.json()) as { code: string }).code]).toEqual([401, "FK_TOKEN_REVOKED"]);
      await b.page.goto(`${server.origin}/admin/account`);
      await expect(b.page).toHaveURL(`${server.origin}/admin/sign-in`); // the other browser's session ended with the recovery
    });
    expect(problems).toEqual([]);
  } finally {
    await Promise.all([a.context.close(), b.context.close(), c.context.close()]);
    await server.stop();
  }
});

test("states: no link, a spent link, an owner that exists, rate limit, no passkey support, an insecure address, an ended session, the legacy token form and the theme", async ({ browser }) => {
  const LEGACY = "fictional-legacy-admin-token-0123456789abcdef";
  const server = await startServer({ ADMIN_TOKEN: LEGACY });
  const d = await newDevice(browser, { viewport: { width: 1100, height: 820 } });
  const problems = watch(d.page);
  try {
    const page = d.page;

    await test.step("before the first owner: the sign-in page shows the host command and the legacy token form", async () => {
      await page.goto(`${server.origin}/admin/sign-in`);
      await expect(page.getByRole("heading", { name: "Set up the first owner" })).toBeVisible();
      await expect(page.getByText("feedbackkit-admin setup-link", { exact: false }).first()).toBeVisible();
      await expect(page.getByRole("heading", { name: "Sign in with the admin token" })).toBeVisible();
      await shot(page, "sign-in-before-owner");
      await page.getByLabel("Admin token").fill(LEGACY);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(page).toHaveURL(`${server.origin}/admin`);
      await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    });

    await test.step("a link that is not valid", async () => {
      await page.goto(`${server.origin}/admin/setup#fk_link_not-a-real-link`);
      await expect(page.getByRole("heading", { name: "This link no longer works" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Go to sign in" })).toBeVisible();
      await shot(page, "setup-link-invalid");
    });

    await test.step("pasting a new link into the open page starts over with it", async () => {
      await page.goto(`${server.origin}/admin/setup`);
      await expect(page.getByRole("heading", { name: "Open the setup link" })).toBeVisible();
      await page.goto(server.host("setup-link"));
      await expect(page.getByRole("heading", { name: "Set up the first owner" })).toBeVisible();
    });

    await test.step("an insecure address and a browser without passkeys keep the button off and say what to do", async () => {
      const insecure = await browser.newContext();
      await insecure.addInitScript(() => Object.defineProperty(window, "isSecureContext", { value: false }));
      const p1 = await insecure.newPage();
      await p1.goto(server.host("setup-link"));
      await expect(p1.locator("#st-insecure")).toBeVisible();
      await expect(p1.getByRole("button", { name: "Create passkey" })).toBeDisabled();
      await shot(p1, "setup-insecure");
      await insecure.close();
      const old = await browser.newContext();
      await old.addInitScript(() => Object.defineProperty(window, "PublicKeyCredential", { value: undefined }));
      const p2 = await old.newPage();
      await p2.goto(server.host("setup-link"));
      await expect(p2.locator("#st-unsupported")).toBeVisible();
      await expect(p2.getByRole("button", { name: "Create passkey" })).toBeDisabled();
      await old.close();
    });

    await test.step("the server says too many attempts: the page says when to try again", async () => {
      await page.route("**/api/auth/setup/begin", (route) => route.fulfill({ status: 429, headers: { "Retry-After": "600", "Content-Type": "application/json" }, body: JSON.stringify({ v: 1, status: "error", error: "Too many attempts.", code: "FK_THROTTLED" }) }));
      await page.goto(server.host("setup-link"));
      await expect(page.locator("#st-msg")).toContainText("Try again in 10 minutes");
      await page.unroute("**/api/auth/setup/begin");
    });

    await test.step("the server says an owner exists (mocked: the real server cannot issue such a link)", async () => {
      await page.route("**/api/auth/setup/begin", (route) => route.fulfill({ status: 409, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ v: 1, status: "error", error: "An owner already exists.", code: "FK_OWNER_EXISTS" }) }));
      await page.goto(`${server.origin}/admin/setup#fk_link_whatever`);
      await expect(page.getByRole("heading", { name: "This gateway already has an owner" })).toBeVisible();
      await shot(page, "setup-owner-exists");
      await page.unroute("**/api/auth/setup/begin");
    });

    await test.step("with an owner: the sign-in page, an ended session, a cancelled and a failing sign-in, the theme", async () => {
      await createOwner(server, d, "Robin");
      await api(page, "POST", "/api/auth/signout", await csrfOf(page));
      await page.goto(`${server.origin}/admin/sign-in#ended`);
      await expect(page.getByText("Your session ended. Sign in again.")).toBeVisible();
      await page.goto(`${server.origin}/admin/account`);
      await expect(page).toHaveURL(`${server.origin}/admin/sign-in`);
      await expect(page.getByText("Your session ended.")).toBeHidden();
      await page.route("**/api/auth/signin/begin", (route) => route.fulfill({ status: 429, headers: { "Retry-After": "120", "Content-Type": "application/json" }, body: JSON.stringify({ v: 1, status: "error", error: "Too many.", code: "FK_THROTTLED" }) }));
      await page.getByRole("button", { name: "Sign in with a passkey" }).click();
      await expect(page.locator("#signin-msg")).toContainText("Too many failed attempts from your network. Try again in 2 minutes");
      await page.unroute("**/api/auth/signin/begin");
      const html = page.locator("html");
      await page.emulateMedia({ colorScheme: "light" });
      await page.locator("#theme").click();
      await expect(html).toHaveAttribute("data-theme", "dark");
      await shot(page, "sign-in-dark");
      await page.locator("#theme").click();
      await expect(html).toHaveAttribute("data-theme", "light");
    });

    await test.step("the pages are not indexed, carry a nonce-based policy and load no inline code or style", async () => {
      for (const path of ["/admin/sign-in", "/admin/setup", "/admin/account", "/admin/accounts", "/admin/tokens"]) {
        const res = await page.request.get(`${server.origin}${path}`);
        expect(res.status(), path).toBe(200);
        const csp = res.headers()["content-security-policy"] ?? "";
        expect(csp, path).toMatch(/script-src[^;]*'nonce-/);
        expect(csp, path).not.toContain("unsafe-inline");
        const html = await res.text();
        expect(html, path).toContain('<meta name="robots" content="noindex,nofollow">');
        expect(html.match(/<[a-z]+ [^>]*\sstyle=/gi), path).toBeNull();
        expect(html.match(/\son[a-z]+=/gi), path).toBeNull();
      }
    });
    expect(problems).toEqual([]);
  } finally {
    await d.context.close();
    await server.stop();
  }
});

test("phone and dark: every screen fits 375 px without horizontal scroll", async ({ browser }) => {
  const server = await startServer();
  const d = await newDevice(browser, { viewport: { width: 375, height: 812 }, colorScheme: "dark", isMobile: true, hasTouch: true });
  const problems = watch(d.page);
  try {
    const page = d.page;
    const fits = async (name: string) => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${name} fits the viewport`).toBe(true);
      await shot(page, `phone-${name}`);
    };
    await page.goto(`${server.origin}/admin/sign-in`);
    await expect(page.getByRole("heading", { name: "Set up the first owner" })).toBeVisible();
    await fits("sign-in-before-owner");
    await createOwner(server, d, "Robin");
    await fits("setup-done");
    await page.goto(`${server.origin}/admin/account`);
    await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
    await fits("account");
    await page.getByRole("button", { name: "Add a passkey" }).click();
    await fits("account-add-passkey");
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.goto(`${server.origin}/admin/accounts`);
    await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible();
    await page.getByRole("button", { name: "Invite someone" }).click();
    await fits("accounts-invite");
    await page.getByRole("button", { name: "Cancel" }).click();
    await fits("accounts");
    await page.goto(`${server.origin}/admin/tokens`);
    await expect(page.getByRole("heading", { name: "API tokens" })).toBeVisible();
    await page.locator("#tok-open").click();
    await fits("tokens-create");
    await page.getByRole("button", { name: "Cancel" }).click();
    await fits("tokens");
    await api(page, "POST", "/api/auth/signout", await csrfOf(page));
    await page.goto(`${server.origin}/admin/sign-in`);
    await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toBeVisible();
    await fits("sign-in");
    expect(problems).toEqual([]);
  } finally {
    await d.context.close();
    await server.stop();
  }
});
