import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

// Durability tests (#108) run inside workerd against a real local D1 and R2, with
// the repo's migrations applied, because the SQL fakes in test/helpers.ts never
// execute SQL. Only test/durable/ runs here; everything else stays on Node.
export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    test: {
      include: ["test/durable/**/*.test.ts"],
      setupFiles: ["test/durable/apply-migrations.ts"],
      poolOptions: {
        workers: {
          singleWorker: true,
          isolatedStorage: true,
          miniflare: {
            compatibilityDate: "2025-01-01",
            compatibilityFlags: ["nodejs_compat"],
            d1Databases: ["DB"],
            r2Buckets: ["UPLOADS"],
            bindings: { TEST_MIGRATIONS: migrations },
          },
        },
      },
    },
  };
});
