import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests live in test/*.test.ts. e2e/*.spec.ts are Playwright specs (run via
// `pnpm e2e`), NOT vitest — exclude them so `vitest run` doesn't try to execute
// Playwright's test() under the wrong runner.
export default defineConfig({
  resolve: {
    // workerd built-in, imported by @cloudflare/workers-oauth-provider (MCP, ADR-015).
    alias: { "cloudflare:workers": fileURLToPath(new URL("./test/stubs/cloudflare-workers.ts", import.meta.url)) },
  },
  test: {
    include: ["test/**/*.test.ts"],
    // The provider is ESM in node_modules: inline it so the alias above applies.
    server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
  },
});
