import { test, expect } from "@playwright/test";

// The consent page's Allow button is a plain HTML form post. Which Origin the
// browser puts on it depends on the page's Referrer-Policy; the POST handler
// refuses anything but this origin. e2e/serve.mjs serves the form with the real
// consent headers (src/worker/oauth/consent-headers.ts) and answers the POST with
// the real check (isSameOriginRequest in src/worker/admin/auth.ts).

test("Allow on the consent page passes the same-origin check", async ({ page, baseURL }) => {
  const res = await page.goto("/oauth/authorize");
  await page.getByRole("button", { name: "Allow" }).click();
  const body = page.locator("body");
  // With Referrer-Policy: no-referrer this was "Origin: null" and "Request blocked".
  await expect(body).toContainText(`Origin: ${new URL(baseURL!).origin}`);
  await expect(body).toContainText("Allowed");
  expect(res!.headers()["referrer-policy"]).toBe("same-origin");
});

test("the same form posted from another origin is blocked", async ({ page }) => {
  // 127.0.0.1 and localhost are different origins (and different sites).
  await page.goto("http://127.0.0.1:8788/e2e/foreign-consent-form");
  await page.getByRole("button", { name: "Allow" }).click();
  const body = page.locator("body");
  await expect(body).toContainText("Request blocked");
  await expect(body).toContainText("Origin: http://127.0.0.1:8788");
  await expect(body).toContainText("Sec-Fetch-Site: cross-site");
});
