import { test, expect } from "@playwright/test";
import { CONFIG, installMocks } from "./helpers";

const placeholder = /in your own words/i;
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
  await expect(page.getByText("Thanks, got it.")).toBeVisible();
  await expect(page.getByRole("link", { name: "View ticket" })).toHaveAttribute("href", /github\.com/);
  await page.getByRole("button", { name: "Report something else" }).click();
  await expect(page.getByPlaceholder(placeholder)).toHaveValue("");
});

test("follow_up: shows ONE conversational question, freetext answer → created", async ({ page }) => {
  await installMocks(page, {
    post1: { v: 1, status: "follow_up", question: "What did you expect to happen?", extracted: { repro: "clicked save" }, summary: "Save action fails" },
    post2: { v: 1, status: "created", id: "2", issueUrl: "https://github.com/acme/site/issues/2", type: "bug", summary: "Save action fails" },
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
  await expect(page.getByText("Thanks, got it.")).toBeVisible();
  await expect(page.locator(".fk-summary")).toHaveText("Save action fails"); // how it was understood
  await expect(page.locator(".fk-card .fk-tag")).toHaveText("Bug");
});

test("auto-type: no type picker, no type sent; the gateway's pick is shown and completed", async ({ page }) => {
  await installMocks(page, {
    config: {
      ...CONFIG,
      autoType: true,
      types: [...CONFIG.types, { type: "idea", label: "Idea", fields: [{ key: "problem", label: "Problem", kind: "longtext", required: true }] }],
    },
    post1: { v: 1, status: "follow_up", question: "Which problem would it solve?", extracted: {}, summary: "Dark mode", type: "idea" },
    post2: { v: 1, status: "created", id: "6", type: "idea", summary: "Dark mode for the editor" },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Feedback" }).click();
  await expect(page.locator(".fk-tabs")).toBeHidden();
  await page.getByPlaceholder(placeholder).fill("a dark mode would be nice");
  const [req1] = await Promise.all([page.waitForRequest("**/api/feedback**"), page.getByRole("button", send).click()]);
  expect(req1.postDataJSON().type).toBeUndefined();
  await expect(page.locator(".fk-me")).toHaveText("a dark mode would be nice"); // the user's own words stay visible
  await expect(page.getByText("Filed as Idea")).toBeVisible();
  await page.locator("#fk-answer").fill("reading at night");
  const [req2] = await Promise.all([page.waitForRequest("**/api/feedback**"), page.locator("#fk-answer").press("Enter")]);
  expect(req2.postDataJSON()).toMatchObject({ type: "idea", followUpText: "reading at night" });
  await expect(page.locator(".fk-summary")).toHaveText("Dark mode for the editor");
  await expect(page.getByRole("link", { name: "View ticket" })).toBeHidden(); // no issue URL → no link
});

test("what gets sent: the disclosure lists the auto-collected context", async ({ page }) => {
  await installMocks(page, { post1: {} });
  await page.goto("/");
  await page.getByRole("button", { name: "Feedback" }).click();
  const disclose = page.getByRole("button", { name: "What gets sent?" });
  await expect(page.locator("#fk-sent")).toBeHidden();
  await disclose.click();
  await expect(disclose).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#fk-sent")).toContainText("Page: /");
  await expect(page.locator("#fk-sent")).toContainText("Screenshot: no");
  await page.getByRole("button", { name: "Screenshot", exact: true }).click();
  await expect(page.locator("#fk-sent")).toContainText("Screenshot: yes");
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
  await expect(page.getByText("Thanks, got it.")).toBeVisible();
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
  await page.getByPlaceholder(placeholder).fill("attachment must not be dropped");
  const feedback = page.waitForRequest("**/api/feedback**");
  await page.getByRole("button", send).click();
  expect((await feedback).postDataJSON().attachmentKeys).toContain("fk_test/manual.png");
});

test("drop processes every file and keeps independent status chips through failure and cap rejection", async ({ page }) => {
  await installMocks(page, { post1: { v: 1, status: "created", id: "5" } });
  let upload = 0;
  await page.route("**/api/upload**", async (route) => {
    upload++;
    if (upload === 2) return route.fulfill({ status: 500, body: "failed" });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ v: 1, key: `fk_test/manual-${upload}.png` }) });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Feedback" }).click();
  await expect(page.locator("#fk-file")).toHaveAttribute("multiple", "");
  await page.locator(".fk-composer").evaluate((node) => {
    const transfer = new DataTransfer();
    for (let i = 1; i <= 5; i++) transfer.items.add(new File([String(i)], `evidence-${i}.png`, { type: "image/png" }));
    node.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });

  await expect(page.locator(".fk-files .fk-chip")).toHaveCount(5);
  await expect(page.locator('.fk-chip.file[data-status="uploaded"]')).toHaveCount(3);
  await expect(page.locator('.fk-chip.file[data-status="failed"]')).toHaveCount(1);
  await expect(page.locator('.fk-chip.file[data-status="limit"]')).toContainText(["evidence-5.png"]);
  const chips = await page.locator(".fk-chip.file").allTextContents();
  for (let i = 1; i <= 5; i++) expect(chips.some((text) => text.includes(`evidence-${i}.png`))).toBe(true);
});
