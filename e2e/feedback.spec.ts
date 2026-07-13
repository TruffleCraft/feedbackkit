import { test, expect } from "@playwright/test";
import { installMocks } from "./helpers";

const desc = /describe it/i;
const send = { name: "Send", exact: true } as const;

test("happy path: type → send → issue created", async ({ page }) => {
  await installMocks(page, { post1: { v: 1, status: "created", id: "1", issueUrl: "https://github.com/acme/site/issues/1" } });
  await page.goto("/");
  await page.getByRole("button", { name: "Feedback" }).click();
  await page.getByPlaceholder(desc).fill("the save button does nothing");
  const [req] = await Promise.all([page.waitForRequest("**/api/feedback**"), page.getByRole("button", send).click()]);
  const payload = req.postDataJSON();
  expect(payload.feedbackId).toBeTruthy();
  expect(payload.message).toContain("save button");
  expect(payload.pageUrl).toContain("/");
  await expect(page.getByText("Thanks!")).toBeVisible();
  await expect(page.getByRole("link", { name: "View issue" })).toHaveAttribute("href", /github\.com/);
});

test("need_fields: prefilled + missing, then complete → created", async ({ page }) => {
  await installMocks(page, {
    post1: { v: 1, status: "need_fields", missing: ["expected"], extracted: { repro: "clicked save" } },
    post2: { v: 1, status: "created", id: "2", issueUrl: "https://github.com/acme/site/issues/2" },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Feedback" }).click();
  await page.getByPlaceholder(desc).fill("save broken");
  await page.getByRole("button", send).click();
  await expect(page.locator("#fk-completing-hint")).toContainText(/Almost done/i);
  await expect(page.locator("#fk-f-repro")).toHaveValue("clicked save"); // extracted, prefilled
  await expect(page.locator("#fk-f-expected")).toHaveValue(""); // missing
  await page.locator("#fk-f-expected").fill("the form should save");
  await page.getByRole("button", send).click();
  await expect(page.getByText("Thanks!")).toBeVisible();
});

test("LLM degrade: accepted_incomplete → soft done", async ({ page }) => {
  await installMocks(page, { post1: { v: 1, status: "accepted_incomplete", id: "3", issueUrl: "https://github.com/acme/site/issues/3" } });
  await page.goto("/");
  await page.getByRole("button", { name: "Feedback" }).click();
  await page.getByPlaceholder(desc).fill("everything is broken!!");
  await page.getByRole("button", send).click();
  await expect(page.getByText("Thanks!")).toBeVisible();
});

test("error → failed → retry returns to the form", async ({ page }) => {
  await installMocks(page, { post1: { v: 1, status: "error", error: "boom" } });
  await page.goto("/");
  await page.getByRole("button", { name: "Feedback" }).click();
  await page.getByPlaceholder(desc).fill("x");
  await page.getByRole("button", send).click();
  await expect(page.getByRole("button", { name: /try again/i })).toBeVisible(); // failed state
  await page.getByRole("button", { name: /try again/i }).click();
  await expect(page.getByPlaceholder(desc)).toBeVisible();
});
