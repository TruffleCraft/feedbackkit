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
  // The editor sends the stored settings without the two fields the gateway adds itself.
  const { publicKey, configVersion, ...stored } = harborConfig;
  expect(writes.at(-1)).toMatchObject({ method: "POST", body: { config: { ...stored, llm: { ...harborConfig.llm, model: "local-test-model" } } } });
  const sent = (writes.at(-1)?.body as { config: Record<string, unknown> }).config;
  expect(sent).not.toHaveProperty("publicKey");
  expect(sent).not.toHaveProperty("configVersion");
  void publicKey; void configVersion;
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

test("a setting without a default starts empty, and emptying an optional setting removes it", async ({ page }) => {
  await installAdminMocks(page); await signedIn(page);
  await page.goto("/admin/projects/harborline#config");
  const settings = page.locator("#cfg-form");
  const draft = async () => JSON.parse(await page.getByLabel("Config JSON").inputValue()) as Record<string, Record<string, unknown>>;

  // Adding the retention starts with an empty field, not with 1 day, which would delete reports.
  await settings.getByLabel("Add Attachments & retention setting").selectOption({ label: "Delete after (days)" });
  const days = settings.getByLabel("Delete after (days)");
  await expect(days).toHaveValue("");
  expect((await draft())["storage"]).not.toHaveProperty("retentionDays");
  await days.fill("30");
  expect((await draft())["storage"]!["retentionDays"]).toBe(30);
  // Clearing it again removes the setting instead of saving null or 0.
  await days.fill("");
  expect((await draft())["storage"]).not.toHaveProperty("retentionDays");

  // A text setting that is emptied is removed too, and typing again brings it back without losing the field.
  const url = settings.getByLabel("Public attachment URL");
  await url.fill("");
  expect((await draft())["storage"]).not.toHaveProperty("publicBaseUrl");
  await url.fill("https://r2.harborline.test/");
  expect((await draft())["storage"]!["publicBaseUrl"]).toBe("https://r2.harborline.test/");

  // A choice without a default is not preselected either.
  await settings.getByRole("button", { name: "Types & delivery", exact: true }).click();
  await settings.getByRole("button", { name: "Configure Delivery" }).click();
  const delivery = settings.getByLabel("Delivery", { exact: true });
  await expect(delivery).toHaveValue("");
  expect(await draft()).not.toHaveProperty("delivery");
  await delivery.selectOption("local");
  expect((await draft())["delivery"]).toBe("local");
});

test("the JSON and the form are one draft: valid JSON reaches the form, invalid JSON pauses it", async ({ page }) => {
  await installAdminMocks(page); await signedIn(page);
  await page.goto("/admin/projects/harborline#config");
  const settings = page.locator("#cfg-form");
  await page.locator("#cfg-advanced > summary").click();
  const json = page.getByLabel("Config JSON");
  const current = JSON.parse(await json.inputValue()) as { llm: Record<string, unknown> };
  await json.fill(JSON.stringify({ ...current, llm: { ...current.llm, model: "from-json" } }, null, 2));
  await settings.getByRole("button", { name: "AI & follow-ups", exact: true }).click();
  await expect(settings.getByLabel("Model ID", { exact: true })).toHaveValue("from-json");

  await json.fill("{ not json");
  await expect(settings).toHaveAttribute("inert", "");
  await expect(page.locator("#cfg-msg")).toContainText("Not valid JSON");
  await json.fill(JSON.stringify({ ...current, llm: { ...current.llm, model: "fixed" } }, null, 2));
  await expect(settings).not.toHaveAttribute("inert", "");
  await expect(settings.getByLabel("Model ID", { exact: true })).toHaveValue("fixed");
});

test("a review covers exactly the text that was checked: a change while checking needs another review", async ({ page }) => {
  await installAdminMocks(page); await signedIn(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/config/validate", async (route) => { await gate; await route.fallback(); });
  await page.goto("/admin/projects/harborline#config");
  const settings = page.locator("#cfg-form");
  await settings.getByRole("button", { name: "AI & follow-ups", exact: true }).click();
  const model = settings.getByLabel("Model ID", { exact: true });
  await model.fill("first");
  await page.getByRole("button", { name: "Review changes", exact: true }).click();
  await model.fill("second"); // typed while the gateway is still checking "first"
  release();
  await expect(page.locator("#cfg-msg")).toContainText("changed while they were being checked");
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeEnabled();
});

test("IDs lock once they are published", async ({ page }) => {
  const { writes } = await installAdminMocks(page); await signedIn(page);
  await page.goto("/admin/projects/harborline#config");
  const settings = page.locator("#cfg-form");
  await settings.getByRole("button", { name: "Types & delivery", exact: true }).click();
  await settings.getByRole("button", { name: "Add feedback type", exact: true }).click();
  await settings.locator("summary", { hasText: "Feedback types 5" }).click(); // the new type opens collapsed
  const typeId = settings.getByLabel("Type ID", { exact: true }).last();
  await typeId.fill("newtype");
  await settings.getByLabel("Label", { exact: true }).last().fill("New type");
  await expect(typeId).not.toHaveAttribute("readonly", "");
  await page.getByRole("button", { name: "Review changes", exact: true }).click();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect.poll(() => writes.at(-1)?.method).toBe("PUT");
  await expect(settings.getByLabel("Type ID", { exact: true }).last()).toHaveAttribute("readonly", "");
});

test("the review says what a retention change deletes", async ({ page }) => {
  await installAdminMocks(page); await signedIn(page);
  await page.goto("/admin/projects/harborline#config");
  const settings = page.locator("#cfg-form");
  await settings.getByLabel("Add Attachments & retention setting").selectOption({ label: "Delete after (days)" });
  await settings.getByLabel("Delete after (days)").fill("30");
  await page.getByRole("button", { name: "Review changes", exact: true }).click();
  const note = page.locator("#cfg-out").getByText("At the next daily cleanup");
  await expect(note).toContainText("3 reports and 2 attachments older than 30 days are deleted, handled or not. This cannot be undone.");
  await expect(page.locator("#cfg-out")).toContainText("Retention changes from no limit to 30 days.");
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeEnabled();
});

test("a change that touches no retention shows no retention note", async ({ page }) => {
  await installAdminMocks(page); await signedIn(page);
  await page.goto("/admin/projects/harborline#config");
  const settings = page.locator("#cfg-form");
  await settings.getByRole("button", { name: "AI & follow-ups", exact: true }).click();
  await settings.getByLabel("Model ID", { exact: true }).fill("other-model");
  await page.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeEnabled();
  await expect(page.locator("#cfg-out")).not.toContainText("Retention");
});

test("removing a published type archives it, removing a new type deletes it", async ({ page }) => {
  await installAdminMocks(page); await signedIn(page);
  await page.goto("/admin/projects/harborline#config");
  const settings = page.locator("#cfg-form");
  const types = async () => (JSON.parse(await page.getByLabel("Config JSON").inputValue()) as { templates: Array<{ type: string; archived?: boolean }> }).templates;
  await settings.getByRole("button", { name: "Types & delivery", exact: true }).click();
  const items = settings.locator(".settings-content > .settings-field").first().locator(":scope > .settings-item");
  const before = await types();

  // A published type offers Archive. The type stays in the settings, flagged.
  page.once("dialog", (dialog) => void dialog.accept());
  await items.first().getByRole("button", { name: "Archive", exact: true }).click();
  const archived = await types();
  expect(archived).toHaveLength(before.length);
  expect(archived[0]).toMatchObject({ type: before[0]!.type, archived: true });
  await expect(items.first().getByRole("button", { name: "Unarchive", exact: true })).toBeVisible();
  await items.first().getByRole("button", { name: "Unarchive", exact: true }).click();
  expect((await types())[0]).not.toHaveProperty("archived");

  // A type that was never published is removed for real.
  await settings.getByRole("button", { name: "Add feedback type", exact: true }).click();
  expect(await types()).toHaveLength(before.length + 1);
  page.once("dialog", (dialog) => void dialog.accept());
  await items.last().getByRole("button", { name: "Remove", exact: true }).click();
  expect(await types()).toHaveLength(before.length);
});
