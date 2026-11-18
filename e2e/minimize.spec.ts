import { test, expect, type Page } from "@playwright/test";
import { installMocks } from "./helpers";

// #170: the panel minimizes to a pill, the report goes on across pages and page
// loads, and the reports sent in this tab are listed above the form.

const placeholder = /in your own words/i;
const send = { name: "Send", exact: true } as const;

async function logEvents(page: Page) {
  await page.addInitScript(() => {
    const log: string[] = [];
    (window as unknown as { fkLog: string[] }).fkLog = log;
    window.addEventListener("feedbackkit:open", () => log.push("open"));
    window.addEventListener("feedbackkit:close", () => log.push("close"));
  });
  return () => page.evaluate(() => (window as unknown as { fkLog: string[] }).fkLog);
}

test("minimize and restore fire nothing: no backdrop, no scroll lock, focus on the pill", async ({ page }) => {
  await installMocks(page, { post1: { v: 1, status: "created", id: "1" } });
  const log = await logEvents(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Feedback" }).click();
  await page.getByPlaceholder(placeholder).fill("the total shows $0.00");
  await page.getByRole("button", { name: "Minimize" }).click();
  await expect(page.locator(".fk-backdrop")).toBeHidden();
  await expect(page.getByRole("button", { name: "Feedback" })).toBeHidden(); // the pill sits where the trigger was
  await expect(page.getByRole("group", { name: "Report draft" })).toContainText("0 screenshots");
  await expect(page.getByRole("button", { name: "Open report" })).toBeFocused();
  expect(await page.evaluate(() => [document.documentElement.style.overflow, document.body.style.position])).toEqual(["", ""]);

  // FeedbackKit.open() brings it back, Escape minimizes again, the pill restores.
  await page.evaluate(() => (window as unknown as { FeedbackKit: { open(): void } }).FeedbackKit.open());
  await expect(page.getByPlaceholder(placeholder)).toHaveValue("the total shows $0.00");
  await expect(page.locator(".fk-panel")).toHaveAttribute("aria-modal", "true");
  await page.keyboard.press("Escape");
  await expect(page.locator(".fk-backdrop")).toBeHidden();
  await page.getByRole("button", { name: "Open report" }).click();
  await expect(page.getByPlaceholder(placeholder)).toBeFocused();
  expect(await log()).toEqual(["open"]);
});

test("the pill's camera captures the page without opening the panel and uploads at once", async ({ page }) => {
  await installMocks(page, { post1: { v: 1, status: "created", id: "1" } });
  await page.goto("/");
  await page.getByRole("button", { name: "Feedback" }).click();
  await page.getByRole("button", { name: "Minimize" }).click();
  const [upload] = await Promise.all([page.waitForRequest("**/api/upload**"), page.getByRole("button", { name: "Add screenshot of this page" }).click()]);
  expect(upload.url()).toContain("kind=screenshot");
  await expect(page.getByRole("group", { name: "Report draft" })).toContainText("1 screenshot", { timeout: 10_000 });
  await expect(page.locator(".fk-backdrop")).toBeHidden();
  await expect(page.getByRole("status")).toHaveText("Screenshot added · 1 of 4");
});

test("with data-trigger=none the pill still shows", async ({ page }) => {
  await installMocks(page, { post1: { v: 1, status: "created", id: "1" } });
  await page.route("**/none.html", (r) =>
    r.fulfill({ status: 200, contentType: "text/html", body: '<!doctype html><html><head><meta charset="utf-8"><title>none</title></head><body><script src="/widget.js" data-project="fk_test" data-trigger="none"></script></body></html>' }),
  );
  await page.goto("/none.html");
  await page.waitForFunction(() => !!(window as unknown as { FeedbackKit?: unknown }).FeedbackKit);
  await page.evaluate(() => (window as unknown as { FeedbackKit: { open(): void } }).FeedbackKit.open());
  await page.getByRole("button", { name: "Minimize" }).click();
  await expect(page.getByRole("button", { name: "Open report" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Feedback" })).toHaveCount(0);
});

test("after a full page load the draft comes back minimized and fires feedbackkit:open once", async ({ page }) => {
  await installMocks(page, { post1: { v: 1, status: "created", id: "1" } });
  const log = await logEvents(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Feedback" }).click();
  await page.getByPlaceholder(placeholder).fill("the total shows $0.00");
  const [upload] = await Promise.all([page.waitForResponse("**/api/upload**"), page.getByRole("button", { name: "Screenshot", exact: true }).click()]);
  const uploadId = new URL(upload.url()).searchParams.get("feedbackId");
  await expect(page.locator(".fk-thumb")).toHaveCount(1, { timeout: 10_000 });

  await page.goto("/?step=2");
  await expect(page.getByRole("group", { name: "Report draft" })).toContainText("1 screenshot");
  await expect(page.locator(".fk-backdrop")).toBeHidden();
  await expect(page.locator("#host-input")).toBeFocused(); // the restore does not steal the page's focus
  expect(await log()).toEqual(["open"]);

  await page.getByRole("button", { name: "Open report" }).click();
  await expect(page.getByPlaceholder(placeholder)).toHaveValue("the total shows $0.00");
  await expect(page.locator(".fk-thumb-p")).toHaveText("/"); // the page it came from
  await expect(page.getByRole("button", { name: "Mark up screenshot 1" })).toBeDisabled(); // its image stayed on the other page
  const [feedback] = await Promise.all([page.waitForRequest("**/api/feedback**"), page.getByRole("button", send).click()]);
  expect(feedback.postDataJSON().feedbackId).toBe(uploadId);
  expect(feedback.postDataJSON().attachmentKeys).toEqual(["fk_test/shot.webp"]);
  await page.getByRole("button", { name: "Done" }).click();
  expect(await log()).toEqual(["open", "close"]);

  // Sent: nothing comes back on the next page.
  await page.goto("/?step=3");
  await expect(page.getByRole("button", { name: "Feedback" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open report" })).toBeHidden();
});

test("sent list: the ticket link when the response has one, otherwise a reference; kept across page loads", async ({ page }) => {
  await installMocks(page, { post1: { v: 1, status: "created", id: "7f3a0000-0000-4000-8000-000000000000", type: "bug", summary: "Total shows $0.00 after changing the ticket count" } });
  await page.goto("/");
  await page.getByRole("button", { name: "Feedback" }).click();
  await expect(page.getByText("Sent in this session")).toBeHidden();
  await page.getByPlaceholder(placeholder).fill("the total shows $0.00");
  await page.getByRole("button", send).click();
  await expect(page.locator(".fk-card")).toContainText("Ref. 7F3A");
  await expect(page.getByText("Kept in this tab's list")).toBeVisible();
  await page.getByRole("button", { name: "Report something else" }).click();
  const list = page.locator(".fk-hist li");
  await expect(page.getByText("Sent in this session · 1")).toBeVisible();
  await expect(list).toHaveCount(1);
  await expect(list.first()).toContainText("Total shows $0.00 after changing the ticket count");
  await expect(list.first()).toContainText("Bug");
  await expect(list.first()).toContainText("Ref. 7F3A");

  await page.unroute("**/api/feedback**");
  await page.route("**/api/feedback**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ v: 1, status: "created", id: "2", type: "bug", summary: "Filter past orders by date", issueUrl: "https://github.com/acme/site/issues/215" }) }),
  );
  await page.getByPlaceholder(placeholder).fill("filter past orders by date");
  await page.getByRole("button", send).click();
  await expect(page.getByRole("link", { name: "View ticket" })).toBeVisible();
  await expect(page.locator(".fk-card")).not.toContainText("Ref.");
  await page.getByRole("button", { name: "Report something else" }).click();
  await expect(list).toHaveCount(2);
  await expect(list.nth(1).getByRole("link", { name: "#215" })).toHaveAttribute("href", "https://github.com/acme/site/issues/215");

  await page.reload();
  await page.getByRole("button", { name: "Feedback" }).click();
  await expect(page.getByText("Sent in this session · 2")).toBeVisible();
  await expect(page.getByRole("button", { name: "Feedback" })).toHaveCount(0); // no count on the trigger: it is hidden while open
});
