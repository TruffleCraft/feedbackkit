import { test, expect } from "@playwright/test";
import { installMocks } from "./helpers";

const placeholder = /tell us anything/i;
const send = { name: "Send", exact: true } as const;

test("happy path: type → send → issue created", async ({ page }) => {
  await installMocks(page, { post1: { v: 1, status: "created", id: "1", issueUrl: "https://github.com/acme/site/issues/1" } });
  await page.goto("/");
  await page.getByRole("button", { name: "Feedback" }).click();
  await page.getByPlaceholder(placeholder).fill("the save button does nothing");
  const [req] = await Promise.all([page.waitForRequest("**/api/feedback**"), page.getByRole("button", send).click()]);
  const payload = req.postDataJSON();
  expect(payload.feedbackId).toBeTruthy();
  expect(payload.message).toContain("save button");
  expect(payload.pageUrl).toContain("/");
  await expect(page.getByText("Thanks!")).toBeVisible();
  await expect(page.getByRole("link", { name: "View issue" })).toHaveAttribute("href", /github\.com/);
});

test("follow_up: shows ONE conversational question, freetext answer → created", async ({ page }) => {
  await installMocks(page, {
    post1: { v: 1, status: "follow_up", question: "What did you expect to happen?", extracted: { repro: "clicked save" } },
    post2: { v: 1, status: "created", id: "2", issueUrl: "https://github.com/acme/site/issues/2" },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Feedback" }).click();
  await page.getByPlaceholder(placeholder).fill("save broken");
  await page.getByRole("button", send).click();
  await expect(page.locator("#fk-question")).toHaveText("What did you expect to happen?"); // single natural question
  const [req] = await Promise.all([
    page.waitForRequest("**/api/feedback**"),
    page.locator("#fk-answer").fill("it should save the form"),
    page.getByRole("button", send).click(),
  ]);
  expect(req.postDataJSON().followUpText).toContain("save the form"); // freetext answer, not per-field
  await expect(page.getByText("Thanks!")).toBeVisible();
});

test("LLM degrade / incomplete: accepted_incomplete → soft done", async ({ page }) => {
  await installMocks(page, { post1: { v: 1, status: "accepted_incomplete", id: "3", issueUrl: "https://github.com/acme/site/issues/3" } });
  await page.goto("/");
  await page.getByRole("button", { name: "Feedback" }).click();
  await page.getByPlaceholder(placeholder).fill("everything is broken!!");
  await page.getByRole("button", send).click();
  await expect(page.getByText("Thanks!")).toBeVisible();
});

test("error → failed → retry returns to the form", async ({ page }) => {
  await installMocks(page, { post1: { v: 1, status: "error", error: "boom" } });
  await page.goto("/");
  await page.getByRole("button", { name: "Feedback" }).click();
  await page.getByPlaceholder(placeholder).fill("x");
  await page.getByRole("button", send).click();
  await expect(page.getByRole("button", { name: /try again/i })).toBeVisible(); // failed state
  await page.getByRole("button", { name: /try again/i }).click();
  await expect(page.getByPlaceholder(placeholder)).toBeVisible();
});
