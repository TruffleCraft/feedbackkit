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
    post1: { v: 1, status: "follow_up", question: "What did you expect to happen?", extracted: { repro: "clicked save" }, summary: "Save action fails" },
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
  expect(req.postDataJSON().summary).toBe("Save action fails");
  await expect(page.getByText("Thanks!")).toBeVisible();
});

test("category guidance: shows the per-type hint and updates on type switch", async ({ page }) => {
  await installMocks(page, {
    config: {
      v: 1,
      enabled: true,
      locale: "en",
      askType: true,
      configVersion: 1,
      types: [
        { type: "bug", label: "Bug", guidance: "Include what you did, expected, and saw.", fields: [{ key: "repro", label: "Steps", kind: "longtext", required: true }] },
        { type: "idea", label: "Idea", guidance: "Tell us the problem this solves and who it's for.", fields: [{ key: "problem", label: "Problem", kind: "longtext", required: true }] },
      ],
    },
    post1: { v: 1, status: "created", id: "1", issueUrl: "https://github.com/acme/site/issues/1" },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Feedback" }).click();
  await expect(page.locator(".fk-guidance")).toHaveText("Include what you did, expected, and saw.");
  await page.getByRole("button", { name: "Idea", exact: true }).click();
  await expect(page.locator(".fk-guidance")).toHaveText("Tell us the problem this solves and who it's for."); // patched, not re-rendered
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

test("send waits for a visible attachment upload before creating feedback", async ({ page }) => {
  await installMocks(page, { post1: { v: 1, status: "created", id: "4" } });
  await page.route("**/api/upload**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ v: 1, key: "fk_test/manual.png" }) });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Feedback" }).click();
  await page.locator("#fk-file").setInputFiles({ name: "evidence.png", mimeType: "image/png", buffer: Buffer.from([1, 2, 3]) });
  await page.getByRole("button", { name: "Remove screenshot" }).click();
  await page.getByPlaceholder(placeholder).fill("attachment must not be dropped");
  const feedback = page.waitForRequest("**/api/feedback**");
  await page.getByRole("button", send).click();
  expect((await feedback).postDataJSON().attachmentKeys).toContain("fk_test/manual.png");
});
