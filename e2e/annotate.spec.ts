import { test, expect } from "@playwright/test";
import { installMocks } from "./helpers";

// #54: screenshot annotator — capture → preview → crop/annotate → the flattened
// image travels the existing upload path and its key rides on the payload.

const placeholder = /tell us anything/i;

async function openAnnotator(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Feedback" }).click();
  await page.getByRole("button", { name: "Mark up" }).click();
  await expect(page.locator(".fk-canvas")).toBeVisible({ timeout: 10_000 }); // html-to-image capture can take a moment
}

test("annotate: capture → draw → use → flattened shot uploads and key rides on submit", async ({ page }) => {
  await installMocks(page, { post1: { v: 1, status: "created", id: "1", issueUrl: "https://github.com/acme/site/issues/1" } });
  await page.goto("/");
  await openAnnotator(page);

  await expect(page.locator(".fk-panel")).toHaveAttribute("inert", "");
  await expect(page.locator(".fk-backdrop")).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByRole("button", { name: "Crop" })).toBeFocused();
  await page.getByRole("button", { name: "Use screenshot" }).focus();
  await page.keyboard.press("Tab");
  await expect(page.locator(".fk-editor .fk-x")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Use screenshot" })).toBeFocused();

  // Draw a rectangle annotation (pointer drag on the canvas).
  await page.getByRole("button", { name: "Rectangle" }).click();
  const canvas = page.locator(".fk-canvas");
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + 140, box.y + 100, { steps: 4 });
  await page.mouse.up();

  // Use it → overlay closes and the screenshot chip records the edit.
  await page.getByRole("button", { name: "Use screenshot" }).click();
  await expect(page.locator(".fk-editor")).toBeHidden();
  await expect(page.locator(".fk-chip.shot .txt")).toContainText("edited");

  // Send → the edited blob uploads (screenshot kind) and its key is on the payload.
  await page.getByPlaceholder(placeholder).fill("the header overlaps the menu");
  const [upload, feedback] = await Promise.all([
    page.waitForResponse("**/api/upload**"),
    page.waitForRequest("**/api/feedback**"),
    page.getByRole("button", { name: "Send", exact: true }).click(),
  ]);
  expect(upload.url()).toContain("kind=screenshot");
  expect((await upload.request().sizes()).requestBodySize).toBeGreaterThan(0);
  expect(feedback.postDataJSON().attachmentKeys).toContain("fk_test/shot.webp");
  await expect(page.getByText("Thanks!")).toBeVisible();
});

test("annotate: crop drag shrinks the exported image to the selected region", async ({ page }) => {
  await installMocks(page, { post1: { v: 1, status: "created", id: "1" } });
  await page.goto("/");
  await openAnnotator(page);

  // Crop tool is pre-selected; drag a small region.
  const canvas = page.locator(".fk-canvas");
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 80, { steps: 4 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Use screenshot" }).click();

  await page.getByPlaceholder(placeholder).fill("cropped report");
  const [upload] = await Promise.all([page.waitForResponse("**/api/upload**"), page.getByRole("button", { name: "Send", exact: true }).click()]);
  // A ~100×60 CSS-px crop of the capture must be far smaller than the full-page shot.
  const cropped = (await upload.request().sizes()).requestBodySize;
  expect(cropped).toBeGreaterThan(0);
  expect(cropped).toBeLessThan(20_000);
});

test("annotate: cancel leaves no edited shot; undo/clear controls exist", async ({ page }) => {
  await installMocks(page, { post1: { v: 1, status: "created", id: "1" } });
  await page.goto("/");
  await openAnnotator(page);

  await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled(); // nothing drawn yet
  await page.getByRole("button", { name: "Rectangle" }).click();
  const box = (await page.locator(".fk-canvas").boundingBox())!;
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + 60, { steps: 3 });
  await page.mouse.up();
  await expect(page.getByRole("button", { name: "Undo" })).toBeEnabled();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled();

  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".fk-editor")).toBeHidden();
  await expect(page.locator(".fk-chip.shot .txt")).not.toContainText("edited");
  await expect(page.locator(".fk-panel")).not.toHaveAttribute("inert", "");
  await expect(page.getByRole("button", { name: "Mark up" })).toBeFocused();
  await expect(page.getByPlaceholder(placeholder)).toBeVisible(); // back on the form
});

test("annotate: text size controls are accessible and input stays inside the canvas edge", async ({ page }) => {
  await installMocks(page, { post1: { v: 1, status: "created", id: "1" } });
  await page.goto("/");
  await openAnnotator(page);

  const smaller = page.getByRole("button", { name: "Smaller text" });
  const larger = page.getByRole("button", { name: "Larger text" });
  await expect(smaller).toBeDisabled();
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await expect(smaller).toBeEnabled();
  await smaller.click();
  await larger.click();

  const canvas = page.locator(".fk-canvas");
  const canvasBox = (await canvas.boundingBox())!;
  await page.mouse.click(canvasBox.x + canvasBox.width - 2, canvasBox.y + 30);
  const input = page.locator(".fk-canvas-text");
  const inputBox = (await input.boundingBox())!;
  expect(inputBox.x).toBeGreaterThanOrEqual(canvasBox.x - 1);
  expect(inputBox.x + inputBox.width).toBeLessThanOrEqual(canvasBox.x + canvasBox.width + 1);
  await input.fill("averylongunbrokenannotationthatmustwrap");
  await input.press("Enter");
  await expect(input).toBeHidden();
  await expect(page.getByRole("button", { name: "Undo" })).toBeEnabled();
});
