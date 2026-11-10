import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// One suite, two runtimes. test/durable/ runs in workerd against the real D1 and
// R2 (vitest.workers.config.ts). Here the same files run on Node against the
// SQLite storage of the standalone server. A difference between the runtimes
// fails one of the two runs.
export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:test": fileURLToPath(new URL("./test/conformance/node-env.mjs", import.meta.url)),
      "cloudflare:workers": fileURLToPath(new URL("./test/stubs/cloudflare-workers.ts", import.meta.url)),
    },
  },
  test: {
    include: ["test/durable/**/*.test.ts"],
    server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
  },
});
