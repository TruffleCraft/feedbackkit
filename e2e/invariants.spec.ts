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
