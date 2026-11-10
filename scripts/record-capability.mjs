#!/usr/bin/env node
// Records this release's DELIVERY_CAPABILITY in the remote D1 after `wrangler deploy`
// (pnpm deploy). Config writers accept new delivery shapes only up to the recorded
// level, so a fresh Cloudflare install needs it before it can create a local project.
// The value only rises: a rollback never lowers what the stored settings may need.
// The dev and stable channels of the TruffleCraft deployment record it in the
// promote workflow instead.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { codeDeliveryCapability } from "./delivery-capability.mjs";

export const recordCapabilitySql = (level) =>
  `INSERT INTO meta (key, value) VALUES ('delivery_capability', '${Number(level)}') ON CONFLICT(key) DO UPDATE SET value = CAST(MAX(CAST(meta.value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const level = codeDeliveryCapability();
  execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "feedbackkit", "--remote", "--command", recordCapabilitySql(level)], { stdio: "inherit" });
  console.log(`record-capability: delivery capability ${level} recorded`);
}
