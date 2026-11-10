#!/usr/bin/env node
// pnpm gen:settings: writes src/admin/settings-descriptor.json from the config
// schema in src/shared/contract.ts (see settings-descriptor.mjs).
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { build } from "esbuild";
import { describeSchema } from "./settings-descriptor.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundled = await build({ entryPoints: [join(root, "src/shared/contract.ts")], bundle: true, format: "esm", platform: "node", target: "node24", write: false });
const { FeedbackConfig } = await import("data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].text).toString("base64"));
writeFileSync(join(root, "src/admin/settings-descriptor.json"), JSON.stringify(describeSchema(FeedbackConfig), null, 2) + "\n");
console.log("gen:settings: wrote src/admin/settings-descriptor.json");
