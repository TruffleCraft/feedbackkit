import { build } from "esbuild";
// The core Hono app has no Cloudflare runtime imports. Cloudflare OAuth/MCP is
// attached only by the Worker entry; the standalone server deliberately omits it.
await build({ entryPoints: ["src/worker/app.ts"], outfile: "dist-server/app.mjs", platform: "node", format: "esm", bundle: true, target: "node24" });
await build({ entryPoints: ["src/worker/storage/r2.ts", "src/worker/storage/retention.ts"], outdir: "dist-server", outExtension: { ".js": ".mjs" }, platform: "node", format: "esm", bundle: true, target: "node24" });
