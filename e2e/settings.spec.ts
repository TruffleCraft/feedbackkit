import { test, expect } from "@playwright/test";
import { installAdminMocks, signedIn, harborConfig } from "./admin-fixtures.js";

test("form edits preserve the full config and require review before each publication", async ({ page }) => {
  const { writes } = await installAdminMocks(page);
  await signedIn(page);
  await page.goto("/admin/projects/harborline#config");
  const settings = page.locator("#cfg-form");
  await expect(settings.getByLabel("Project ID")).toHaveValue("harborline");
  await expect(settings.getByLabel("Project ID")).toHaveAttribute("readonly", "");
  await settings.getByRole("button", { name: "AI & follow-ups", exact: true }).click();
  await settings.getByLabel("Model ID", { exact: true }).fill("local-test-model");
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeEnabled();
  expect(writes.at(-1)).toMatchObject({ method: "POST", body: { config: { ...harborConfig, publicKey: undefined, configVersion: undefined, llm: { ...harborConfig.llm, model: "local-test-model" } } } });
  await settings.getByLabel("Maximum AI calls per day", { exact: true }).fill("20");
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Review changes", exact: true }).click();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  expect(writes.at(-1)).toMatchObject({ method: "PUT", body: { expectedVersion: 12, config: { llm: { model: "local-test-model", dailyBudget: 20 }, templates: harborConfig.templates, tracker: harborConfig.tracker, auth: harborConfig.auth } } });
});

test("type and field IDs stay fixed; types can be reordered without losing labels", async ({ page }) => {
  await installAdminMocks(page); await signedIn(page);
  await page.goto("/admin/projects/harborline#config");
  const settings = page.locator("#cfg-form");
  await settings.getByRole("button", { name: "Types & delivery", exact: true }).click();
  await expect(settings.getByLabel("Type ID", { exact: true }).first()).toHaveAttribute("readonly", "");
  await expect(settings.getByLabel("Field ID", { exact: true }).first()).toHaveAttribute("readonly", "");
  const items = settings.locator(".settings-content > .settings-field").first().locator(":scope > .settings-item");
  await items.first().getByRole("button", { name: "Move down", exact: true }).last().click();
  await page.locator("#cfg-advanced > summary").click();
  const draft = JSON.parse(await page.getByLabel("Config JSON").inputValue());
  expect(draft.templates.map((t: {type: string}) => t.type)).toEqual(["idea", "bug", "improvement", "praise"]);
  expect(draft.templates[1].fields).toEqual(harborConfig.templates[0].fields);
});
