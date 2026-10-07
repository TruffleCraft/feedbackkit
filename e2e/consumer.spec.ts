import { test, expect } from "@playwright/test";
import { CONFIG, installMocks } from "./helpers";

// Consumer-app knobs: capture policy, privacy link, host context, URL redaction,
// lazy loading with data-trigger="none" + data-autoopen, and Turnstile tokens.

const placeholder = /in your own words/i;
const send = { name: "Send", exact: true } as const;
const created = { v: 1, status: "created", id: "1", issueUrl: "https://github.com/acme/site/issues/1" };

test("screenshot + console off: no capture UI, no upload, no console; privacy link; context; URL without query", async ({ page }) => {
  await installMocks(page, {
    config: { ...CONFIG, capture: { screenshot: "off", console: false }, privacyUrl: "https://acme.dev/privacy" },
    post1: created,
  });
  const uploads: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/upload")) uploads.push(r.url());
  });
  await page.goto("/?token=magic-link-secret#frag");
  await page.evaluate(() => {
    console.error("transcript: very private");
    (window as unknown as { FeedbackKitContext: unknown }).FeedbackKitContext = () => ({ userId: "u_42", appVersion: "1.2.3" });
  });
  await page.getByRole("button", { name: "Feedback" }).click();
  await expect(page.getByText("Screenshot", { exact: true })).toBeHidden();
  await expect(page.getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "https://acme.dev/privacy");
  await page.getByPlaceholder(placeholder).fill("the save button does nothing");
  const [req] = await Promise.all([page.waitForRequest("**/api/feedback**"), page.getByRole("button", send).click()]);
  const payload = req.postDataJSON();
  expect(payload.pageUrl).toBe("http://localhost:8788/");
  expect(payload.consoleErrors).toEqual([]);
  expect(payload.attachmentKeys).toEqual([]);
  expect(payload.context).toEqual({ userId: "u_42", appVersion: "1.2.3" });
  expect(uploads).toEqual([]);
  await expect(page.getByText("Thanks, got it.")).toBeVisible();
});

const LAZY_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>lazy</title></head><body>
<button id="own">Give feedback</button>
<script>
document.getElementById("own").addEventListener("click", () => {
  if (window.FeedbackKit) return window.FeedbackKit.open();
  const s = document.createElement("script");
  s.src = "/widget.js";
  s.dataset.project = "fk_test";
  s.dataset.trigger = "none";
  s.dataset.autoopen = "";
  document.body.appendChild(s);
});
</script></body></html>`;

test("lazy load: nothing from the gateway before the click; data-trigger=none + autoopen; open() reopens", async ({ page }) => {
  await installMocks(page, { post1: created });
  await page.route("**/lazy.html", (r) => r.fulfill({ status: 200, contentType: "text/html", body: LAZY_PAGE }));
  const gateway: string[] = [];
  page.on("request", (r) => {
    if (/widget\.js|\/api\//.test(r.url())) gateway.push(r.url());
  });
  await page.goto("/lazy.html");
  await page.waitForTimeout(200);
  expect(gateway).toEqual([]);

  await page.getByRole("button", { name: "Give feedback" }).click();
  await expect(page.getByPlaceholder(placeholder)).toBeVisible(); // opened without a floating trigger
  await expect(page.locator("[data-feedbackkit=host]").getByRole("button", { name: "Feedback" })).toBeHidden();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByPlaceholder(placeholder)).toBeHidden();
  await expect(page.getByRole("button", { name: "Give feedback" })).toBeFocused(); // focus back to the host button

  await page.getByRole("button", { name: "Give feedback" }).click(); // second click → FeedbackKit.open()
  await expect(page.getByPlaceholder(placeholder)).toBeVisible();
});

const FAKE_TURNSTILE = `
let n = 0, cb = null;
window.turnstile = {
  render(el, opts) { cb = opts.callback; window.__tsOpts = { sitekey: opts.sitekey, action: opts.action }; return "w1"; },
  execute() { setTimeout(() => cb && cb("tok-" + (++n)), 10); },
  reset() {},
};`;

test("turnstile: fresh token on POST-1 and POST-2, site key + action passed to render", async ({ page }) => {
  await installMocks(page, {
    config: { ...CONFIG, turnstileSiteKey: "0x4AAA-test" },
    post1: { v: 1, status: "follow_up", question: "What did you expect?", extracted: {}, summary: "s" },
    post2: created,
  });
  await page.route("https://challenges.cloudflare.com/**", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: FAKE_TURNSTILE }));
  await page.goto("/");
  await page.getByRole("button", { name: "Feedback" }).click();
  await page.getByPlaceholder(placeholder).fill("saving fails");
  const [req1] = await Promise.all([page.waitForRequest("**/api/feedback**"), page.getByRole("button", send).click()]);
  expect(req1.postDataJSON().turnstileToken).toBe("tok-1");
  await page.getByPlaceholder("Your answer").fill("that it saves");
  const [req2] = await Promise.all([page.waitForRequest("**/api/feedback**"), page.getByRole("button", send).click()]);
  expect(req2.postDataJSON().turnstileToken).toBe("tok-2");
  expect(await page.evaluate(() => (window as unknown as { __tsOpts: unknown }).__tsOpts)).toEqual({ sitekey: "0x4AAA-test", action: "feedback" });
  await expect(page.getByText("Thanks, got it.")).toBeVisible();
});
