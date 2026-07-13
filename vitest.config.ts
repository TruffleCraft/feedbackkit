import { defineConfig } from "vitest/config";

// Unit tests live in test/*.test.ts. e2e/*.spec.ts are Playwright specs (run via
// `pnpm e2e`), NOT vitest — exclude them so `vitest run` doesn't try to execute
// Playwright's test() under the wrong runner.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
