import { test, expect, type Page } from "@playwright/test";
import { TOKEN, SHOT_URL, installAdminMocks, signedIn, feedbackItems } from "./admin-fixtures";

// Admin UI, read-only (P2, step 3): the real shells from src/worker/admin/pages.ts
// under their production CSP, with /api/admin/* mocked. Runs in both projects
// (Desktop Chrome and Pixel 5).

let consoleErrors: string[] = [];
// Chrome logs every non-2xx fetch as a console error; tests that provoke one
// list the status here.
let allowStatus: number[] = [];
test.beforeEach(({ page }) => {
  consoleErrors = [];
  allowStatus = [];
  page.on("console", (m) => {
    // Every load probes /api/admin/me without a token first; outside Access
    // that is an expected 401.
    if (m.type() === "error" && m.text().includes("status of 401") && new URL(m.location().url || "http://x/").pathname === "/api/admin/me") return;
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
});
test.afterEach(() => {
  // CSP violations, script errors and failed loads all land here.
  const expected = (m: string) => allowStatus.some((s) => m.startsWith(`Failed to load resource: the server responded with a status of ${s} `));
  expect(consoleErrors.filter((m) => !expected(m))).toEqual([]);
});

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe("login", () => {
  test("wrong token shows the error, the right one opens the project list", async ({ page }) => {
    allowStatus = [401];
    await installAdminMocks(page);
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Setup guide" })).toHaveAttribute("rel", /noopener/);

    await page.getByLabel("Admin token").fill("not-the-right-token");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("That token didn't match.")).toBeVisible();
    await expect(page.getByLabel("Admin token")).toHaveAttribute("aria-invalid", "true");

    await page.getByLabel("Admin token").fill(TOKEN);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await expect(page.locator("#projects-rows tr")).toHaveCount(3);
    await expect(page.getByRole("link", { name: "harborline" })).toHaveAttribute("href", "/admin/projects/harborline");

    // Token only in sessionStorage; no cookie, nothing in localStorage.
    expect(await page.evaluate(() => sessionStorage.getItem("fk-admin-token"))).toBe(TOKEN);
    expect(await page.evaluate(() => localStorage.getItem("fk-admin-token"))).toBeNull();
    expect(await page.context().cookies()).toEqual([]);

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem("fk-admin-token"))).toBeNull();
  });

  test("lockout (429) shows the block message", async ({ page }) => {
    allowStatus = [429];
    await installAdminMocks(page, { status: 429 });
    await page.goto("/admin");
    await page.getByLabel("Admin token").fill(TOKEN);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText(/Too many failed sign-ins from your network/)).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem("fk-admin-token"))).toBeNull();
  });

  test("a token that stops working mid-session returns to the login", async ({ page }) => {
    allowStatus = [401];
    await installAdminMocks(page, { status: 401 });
    await signedIn(page);
    await page.goto("/admin/system");
    await expect(page.getByText("The saved token no longer works. Sign in again.")).toBeVisible();
    await expect(page.locator("#view-system")).toBeHidden();
  });
});

test.describe("Cloudflare Access", () => {
  test("skips the login when /api/admin/me reports an Access sign-in", async ({ page }) => {
    const { authHeaders } = await installAdminMocks(page, { access: "dana@example.com" });
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await expect(page.locator("#projects-rows tr")).toHaveCount(3);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeHidden();
    await expect(page.getByText("Signed in as dana@example.com")).toBeVisible();

    // Sign out goes to Access, not back to the token form.
    const out = page.getByRole("link", { name: "Sign out" });
    await expect(out).toHaveAttribute("href", "/cdn-cgi/access/logout");
    await expect(page.getByRole("button", { name: "Sign out" })).toBeHidden();

    // No token anywhere: none stored, none sent.
    expect(await page.evaluate(() => sessionStorage.getItem("fk-admin-token"))).toBeNull();
    expect(authHeaders.length).toBeGreaterThan(1);
    expect(authHeaders.every((h) => h === "")).toBe(true);
  });

  test("a long email fits the header on any width", async ({ page }, info) => {
    const email = "dana.whitfield-okonkwo@harborline-logistics.example";
    await installAdminMocks(page, { access: email });
    await page.goto("/admin/system");
    await expect(page.getByText(`Signed in as ${email}`)).toBeAttached();
    await expect(page.locator("#who")).toHaveAttribute("title", email);
    await noHorizontalScroll(page);
  });

  test("ignores a stale stored token when Access signed the visitor in", async ({ page }) => {
    const { authHeaders } = await installAdminMocks(page, { access: "dana@example.com" });
    await signedIn(page);
    await page.goto("/admin/system");
    await expect(page.getByRole("heading", { name: "System" })).toBeVisible();
    await expect(page.getByText("Signed in as dana@example.com")).toBeVisible();
    expect(authHeaders.every((h) => h === "")).toBe(true);
  });

  test("without Access, the probe falls back to the token login", async ({ page }) => {
    const { authHeaders } = await installAdminMocks(page);
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page.locator("#who")).toBeHidden();
    expect(authHeaders).toEqual([""]);
  });
});

test.describe("projects", () => {
  test("table with 7-day counts and failed issues", async ({ page }) => {
    await installAdminMocks(page);
    await signedIn(page);
    await page.goto("/admin");
    await expect(page.getByText("3 projects on this gateway")).toBeVisible();
    const harbor = page.locator("#projects-rows tr").first();
    await expect(harbor).toContainText("fk_pub_3a91c07e5d22");
    await expect(harbor).toContainText("38");
    await expect(harbor.locator(".badge.failed")).toHaveText("2");
    await expect(harbor).toContainText("v12");
    await noHorizontalScroll(page);
  });

  test("empty state walks through three steps", async ({ page }) => {
    await installAdminMocks(page, { emptyProjects: true });
    await signedIn(page);
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Set up your first project" })).toBeVisible();
    await expect(page.locator("#projects-table")).toBeHidden();
    await expect(page.locator(".step")).toHaveCount(3);
    await expect(page.locator("#import-cmd")).toContainText("/api/admin/config/import");
    await noHorizontalScroll(page);
  });
});

test.describe("project detail", () => {
  test("funnel, history cards, thumbnails and disabled retry", async ({ page }) => {
    await installAdminMocks(page);
    await signedIn(page);
    await page.goto("/admin/projects/harborline");
    await expect(page.getByRole("heading", { name: "harborline" })).toBeVisible();
    await expect(page.locator("#p-meta")).toHaveText("fk_pub_3a91c07e5d22 · config v12");
    await expect(page.getByRole("tab", { name: "Feedback history" })).toHaveAttribute("aria-selected", "true");

    await expect(page.locator('#funnel [data-ev="opened"] b')).toHaveText("412");
    await expect(page.locator('#funnel [data-ev="typed"] small')).toHaveText("58%");
    await expect(page.locator('.fafter [data-ev="abandoned"]')).toHaveText("71");

    const rows = page.locator("#rows .hrow");
    await expect(rows).toHaveCount(7);
    const first = rows.first();
    await expect(first).toContainText("Payment spinner never stops");
    await expect(first.locator(".badge.failed")).toHaveText("Issue failed");
    const retry = first.getByRole("button", { name: "Retry" });
    await expect(retry).toBeDisabled();
    await expect(first).toContainText("comes in a later release");
    await expect(rows.nth(4)).toContainText("can't be retried");
    await expect(rows.nth(4)).toContainText("model not recorded");

    // The thumbnail is the real R2 image; it opens full size in a new tab.
    const thumb = first.locator("a.thumb");
    await expect(thumb).toHaveAttribute("href", SHOT_URL);
    await expect(thumb).toHaveAttribute("target", "_blank");
    await expect(thumb).toHaveAttribute("rel", /noopener/);
    await expect(thumb.locator("img")).toHaveAttribute("src", SHOT_URL);
    await expect.poll(() => thumb.locator("img").evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);

    await expect(rows.nth(1).getByRole("link", { name: "#214" })).toHaveAttribute("href", "https://github.com/harborline/web/issues/214");
    await expect(rows.nth(6).locator(".badge")).toHaveText("Saved, no issue");

    // Second page; feedback text is untrusted and stays text.
    await page.getByRole("button", { name: "Load 25 more" }).click();
    await expect(rows).toHaveCount(9);
    await expect(rows.nth(8)).toContainText("<img src=x onerror=alert(1)>");
    expect(await page.locator("#rows img:not(.thumb img)").count()).toBe(0);
    await expect(page.getByRole("button", { name: "Load 25 more" })).toBeHidden();
    await noHorizontalScroll(page);
  });

  test("outcome filters, including Saved, no issue", async ({ page }) => {
    const { requests } = await installAdminMocks(page);
    await signedIn(page);
    await page.goto("/admin/projects/harborline");
    const rows = page.locator("#rows .hrow");
    await expect(rows).toHaveCount(7);

    await page.getByRole("button", { name: "Issue failed" }).click();
    await expect(page.getByRole("button", { name: "Issue failed" })).toHaveAttribute("aria-pressed", "true");
    await expect(rows).toHaveCount(2);
    await expect(rows.locator(".badge.failed")).toHaveCount(2);
    expect(requests.at(-1)?.outcome).toBe("issue_failed");

    // "Issue created" only counts rows that really have an issue.
    await page.getByRole("button", { name: "Issue created" }).click();
    await expect(rows).toHaveCount(4);
    await expect(rows.locator(".badge.stored")).toHaveCount(0);
    expect(requests.at(-1)?.outcome).toBe("created");

    await page.getByRole("button", { name: "Saved, no issue" }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Booking a berth for two boats");

    await page.getByRole("button", { name: "Sent incomplete" }).click();
    await expect(rows).toHaveCount(1);
    await page.getByRole("button", { name: "AI failed" }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Search ignores the "pets allowed" filter');

    await page.getByRole("button", { name: "All", exact: true }).click();
    await expect(rows).toHaveCount(7);
  });

  test("a client-side filter keeps paging until something matches", async ({ page }) => {
    // Page size 2: the only saved-without-issue row is not on the first page.
    const items = feedbackItems();
    await installAdminMocks(page, { items, pageSize: 2 });
    await signedIn(page);
    await page.goto("/admin/projects/harborline");
    await page.getByRole("button", { name: "Saved, no issue" }).click();
    await expect(page.locator("#rows .hrow")).toHaveCount(1);
  });

  test("setup checklist and read-only types", async ({ page }) => {
    await installAdminMocks(page);
    await signedIn(page);
    await page.goto("/admin/projects/harborline");

    await page.getByRole("tab", { name: "Setup & snippet" }).click();
    await expect(page.locator("#panel-setup")).toBeVisible();
    await expect(page.locator("#panel-history")).toBeHidden();
    await expect(page.locator("#snippet")).toHaveText(/data-project="fk_pub_3a91c07e5d22"><\/script>$/);
    await expect(page.locator("#origins .t")).toHaveText(["https://harborline.app", "https://staging.harborline.app"]);
    await expect(page.locator("#step-origins")).toHaveClass(/done/);
    await expect(page.getByRole("link", { name: "Open test page" })).toHaveAttribute("href", "/t/fk_pub_3a91c07e5d22");
    await expect(page).toHaveURL(/#setup$/);

    await page.getByRole("tab", { name: "Types & fields" }).click();
    await expect(page.locator("#types-list details")).toHaveCount(4);
    const bug = page.locator("#types-list details").first();
    await expect(bug).toHaveAttribute("open", "");
    await expect(bug.locator("summary")).toContainText("5 fields · 4 required · harborline/web · labels bug, triage");
    await expect(bug.locator("tbody tr")).toHaveCount(5);
    await expect(bug).toContainText("4 required fields.");
    await expect(page.locator("#types-list details").nth(2).locator(".nm")).toHaveText("Improvement");
    await expect(page.locator("#types-list details").nth(3).locator("summary")).toContainText("saved without an issue");
    // Read-only: no toggles, no Save, no editors.
    await expect(page.locator("#panel-types input, #panel-types select, #panel-types textarea")).toHaveCount(0);
    await expect(page.locator("#panel-types").getByRole("button")).toHaveCount(0);

    // The tab survives a reload through the hash.
    await page.reload();
    await expect(page.getByRole("tab", { name: "Types & fields" })).toHaveAttribute("aria-selected", "true");
    await noHorizontalScroll(page);
  });

  test("unknown project", async ({ page }) => {
    allowStatus = [404];
    await installAdminMocks(page);
    await signedIn(page);
    await page.goto("/admin/projects/nope");
    await expect(page.getByText('There\'s no project called "nope" on this gateway.')).toBeVisible();
  });
});

test.describe("system", () => {
  test("needs attention first, then budgets and the gateway", async ({ page }) => {
    await installAdminMocks(page);
    await signedIn(page);
    await page.goto("/admin/system");
    await expect(page.getByRole("heading", { name: "System" })).toBeVisible();
    await expect(page.locator("#sys-sub")).toHaveText("0.2.0 on stable · schema v2");

    const attention = page.locator("#attention > div");
    await expect(page.locator("#attn-count")).toHaveText("3");
    await expect(attention).toHaveCount(3);
    await expect(attention.nth(0)).toContainText(/harborline GitHub token expires on \d+ \w+ \d{4}\./);
    await expect(attention.nth(1)).toContainText("harborline has used 172 of 200 AI calls today. The count resets at 00:00 UTC.");
    await expect(attention.nth(2)).toContainText("ledgerkite-docs can't create issues: GITHUB_PAT_LEDGER is not set.");

    const projectRows = page.locator("#sys-projects tr");
    await expect(projectRows).toHaveCount(3);
    await expect(projectRows.nth(0).locator(".bar span")).toHaveClass("hot");
    await expect(projectRows.nth(0)).toContainText("172 / 200");
    await expect(projectRows.nth(0)).toContainText("in 12 days");
    await expect(projectRows.nth(1)).toContainText("AI off");
    await expect(projectRows.nth(1)).toContainText("Secret not set");
    await expect(projectRows.nth(2)).toContainText("in 5 months");

    const gateway = page.locator("#sys-gateway tr");
    await expect(gateway).toHaveCount(4);
    await expect(gateway.nth(1)).toContainText("Matches code");
    await expect(gateway.nth(3)).toContainText("2 of 3 GitHub tokens");
    await expect(gateway.nth(3)).toContainText("1 missing");
    await noHorizontalScroll(page);
  });
});

test.describe("phone layout", () => {
  test("44 px targets and no page-wide horizontal scroll", async ({ page }, info) => {
    test.skip(info.project.name !== "mobile-chromium", "phone-only checks");
    await installAdminMocks(page);
    await signedIn(page);
    for (const path of ["/admin", "/admin/projects/harborline", "/admin/system"]) {
      await page.goto(path);
      await expect(page.locator("main > section:not([hidden])")).toHaveCount(1);
      await page.waitForLoadState("networkidle");
      await noHorizontalScroll(page);
      const small = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>("main button, header button, header a, .chip, [role=tab]")]
          .filter((e) => e.offsetParent !== null)
          .filter((e) => e.getBoundingClientRect().height < 44)
          .map((e) => e.textContent?.trim() || e.getAttribute("aria-label") || e.tagName),
      );
      expect(small, path).toEqual([]);
    }
  });
});
