import { test, expect } from "@playwright/test";
import { installMocks } from "./helpers";

const desc = /describe it/i;
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

  // Full cycle incl. a submit, then close — must STILL restore (the corrupted
  // save re-captured "hidden" and left the page unscrollable forever).
  await page.getByRole("button", feedbackBtn).click();
  await page.getByPlaceholder(desc).fill("x");
  await page.getByRole("button", send).click();
  await expect(page.getByText("Thanks!")).toBeVisible();
  await page.getByRole("button", closeBtn).click();
  expect(await overflow()).toBe("");
});

test("typing in one completing field survives editing another (no re-render wipe)", async ({ page }) => {
  await installMocks(page, { post1: { v: 1, status: "need_fields", missing: ["repro", "expected"], extracted: {} } });
  await page.goto("/");
  await page.getByRole("button", feedbackBtn).click();
  await page.getByPlaceholder(desc).fill("broken");
  await page.getByRole("button", send).click();
  await expect(page.locator("#fk-completing-hint")).toContainText(/Almost done/i);
  await page.locator("#fk-f-repro").fill("step one");
  await page.locator("#fk-f-expected").fill("expected two");
  await expect(page.locator("#fk-f-repro")).toHaveValue("step one"); // A not wiped while editing B
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
