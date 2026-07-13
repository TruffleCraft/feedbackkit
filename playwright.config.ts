import { defineConfig, devices } from "@playwright/test";

// E2E runs the BUILT widget on a static demo page; gateway responses are mocked
// per-test with page.route (secret-free, no live keys — CI-safe). Run via
// `pnpm e2e` (builds the widget first).
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  timeout: 20_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: "line",
  use: { baseURL: "http://localhost:8788", trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node e2e/serve.mjs",
    port: 8788,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
