import { build } from "esbuild";
import { fileURLToPath } from "node:url";
// The standalone entry is the Hono app plus the MCP side of ADR-015 (src/worker/standalone.ts). The OAuth
// provider imports the workerd module "cloudflare:workers", which Node does not have: the alias points it
// at a small stand-in (src/worker/standalone/cloudflare-workers.ts). The same alias is in scripts/build-bundle.mjs.
export const CLOUDFLARE_WORKERS_ALIAS = { "cloudflare:workers": fileURLToPath(new URL("../src/worker/standalone/cloudflare-workers.ts", import.meta.url)) };
await build({ entryPoints: ["src/worker/standalone.ts"], outfile: "dist-server/app.mjs", platform: "node", format: "esm", bundle: true, target: "node24", alias: CLOUDFLARE_WORKERS_ALIAS });
await build({ entryPoints: ["src/worker/storage/r2.ts", "src/worker/storage/retention.ts"], outdir: "dist-server", outExtension: { ".js": ".mjs" }, platform: "node", format: "esm", bundle: true, target: "node24" });
await build({ entryPoints: { auth: "src/worker/auth/host.ts" }, outdir: "dist-server", outExtension: { ".js": ".mjs" }, platform: "node", format: "esm", bundle: true, target: "node24" });
