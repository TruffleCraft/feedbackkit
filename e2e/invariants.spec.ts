import { test, expect } from "@playwright/test";
import { installMocks } from "./helpers";

const placeholder = /tell us anything/i;
const send = { name: "Send", exact: true } as const;
const feedbackBtn = { name: "Feedback" } as const;
const closeBtn = { name: "Close" } as const;

test("does not steal host-page focus on load", async ({ page }) => {
  await installMocks(page, { post1: {} });
  await page.goto("/");
  await expect(page.getByRole("button", feedbackBtn)).toBeVisible(); // widget booted
  expect(await page.evaluate(() => document.activeElement?.id)).toBe("host-input");
});

test("scroll-lock: set on open, restored on close — twice, no corruption (regression)", async ({ page }) => {
  await installMocks(page, { post1: { v: 1, status: "created", id: "1", issueUrl: "https://github.com/acme/site/issues/1" } });
  await page.goto("/");
  const overflow = () => page.evaluate(() => document.documentElement.style.overflow);

  await page.getByRole("button", feedbackBtn).click();
  expect(await overflow()).toBe("hidden");
  await page.getByRole("button", closeBtn).click();
  expect(await overflow()).toBe(""); // restored to the host's original

  // Full cycle incl. a submit, then close — must STILL restore.
  await page.getByRole("button", feedbackBtn).click();
  await page.getByPlaceholder(placeholder).fill("x");
  await page.getByRole("button", send).click();
  await expect(page.getByText("Thanks!")).toBeVisible();
  await page.getByRole("button", closeBtn).click();
  expect(await overflow()).toBe("");
});

test("form input survives a DOM toggle (re-render ban)", async ({ page }) => {
  await installMocks(page, { post1: {} });
  await page.goto("/");
  await page.getByRole("button", feedbackBtn).click();
  await page.getByPlaceholder(placeholder).fill("my typed feedback");
  await page.getByRole("button", { name: "Remove screenshot" }).click();
  await expect(page.getByPlaceholder(placeholder)).toHaveValue("my typed feedback"); // form not rebuilt
});

test("a fresh attempt clears text, answer, and media without replacing persistent inputs", async ({ page }) => {
  await installMocks(page, { post1: { v: 1, status: "follow_up", question: "What happened?", extracted: {} } });
  await page.goto("/");
  await page.getByRole("button", feedbackBtn).click();
  const text = page.getByPlaceholder(placeholder);
  await text.evaluate((node) => node.setAttribute("data-persistent", "yes"));
  await page.locator("#fk-file").setInputFiles({ name: "old.png", mimeType: "image/png", buffer: Buffer.from([1]) });
  await page.getByRole("button", { name: "Remove screenshot" }).click();
  await text.fill("old attempt");
  await page.getByRole("button", send).click();
  await page.locator("#fk-answer").fill("stale answer");
  await page.getByRole("button", closeBtn).click();
  await page.getByRole("button", feedbackBtn).click();

  await expect(text).toHaveValue("");
  await expect(text).toHaveAttribute("data-persistent", "yes");
  await expect(page.locator("#fk-answer")).toHaveValue("");
  await expect(page.locator(".fk-files .fk-chip")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove screenshot" })).toBeVisible();
});

test("renders full-viewport even when an ancestor is transformed (fixed-positioning trap)", async ({ page }) => {
  await installMocks(page, { post1: {} });
  await page.goto("/");
  await page.addStyleTag({ content: "#app { transform: translateZ(0); }" });
  await page.getByRole("button", feedbackBtn).click();
  const box = await page.locator(".fk-backdrop").boundingBox();
  const vp = page.viewportSize()!;
  // Widget appends to <body> (not #app), so its fixed backdrop covers the viewport.
  expect(box!.width).toBeGreaterThanOrEqual(vp.width - 2);
  expect(box!.height).toBeGreaterThanOrEqual(vp.height - 2);
});

test("panel is lower-right on desktop, bottom-aligned on mobile, with a clear backdrop", async ({ page }) => {
  await installMocks(page, { post1: {} });
  await page.goto("/");
  await page.getByRole("button", feedbackBtn).click();
  const panelLocator = page.locator(".fk-panel");
  await panelLocator.evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
  const panel = (await panelLocator.boundingBox())!;
  const vp = page.viewportSize()!;
  expect(vp.height - panel.y - panel.height).toBeLessThanOrEqual(vp.width <= 600 ? 1 : 22);
  if (vp.width > 600) expect(vp.width - panel.x - panel.width).toBeLessThanOrEqual(22);
  const backdrop = page.locator(".fk-backdrop");
  await expect(backdrop).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(backdrop).toHaveCSS("backdrop-filter", "none");
});

test("host theme follows document data-theme and falls back to color scheme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await installMocks(page, { post1: {} });
  await page.goto("/");
  const host = page.locator('[data-feedbackkit="host"]');
  await expect(host).not.toHaveAttribute("data-theme");
  await page.getByRole("button", feedbackBtn).click();
  await expect(page.locator(".fk-panel")).toHaveCSS("background-color", "rgb(12, 17, 23)");

  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await expect(host).toHaveAttribute("data-theme", "light");
  await expect(page.locator(".fk-panel")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await expect(host).toHaveAttribute("data-theme", "dark");
});
