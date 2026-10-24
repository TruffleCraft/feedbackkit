#!/usr/bin/env node
// node scripts/delivery-capability.mjs → prints DELIVERY_CAPABILITY of this
// checkout (src/shared/contract.ts). The promote workflow writes it to
// meta.delivery_capability once the release is live on stable (#109).
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/** DELIVERY_CAPABILITY as declared in src/shared/contract.ts. */
export function codeDeliveryCapability() {
  const src = readFileSync(fileURLToPath(new URL("../src/shared/contract.ts", import.meta.url)), "utf8");
  const m = /export const DELIVERY_CAPABILITY = (\d+) as const;/.exec(src);
  if (!m) throw new Error("DELIVERY_CAPABILITY not found in src/shared/contract.ts");
  return Number(m[1]);
}

/** Mirror of requiredDeliveryCapability in src/shared/contract.ts (test/delivery.test.ts keeps them equal). */
export function requiredDeliveryCapability(raw) {
  if (!raw || typeof raw !== "object") return 0;
  const templates = Array.isArray(raw.templates) ? raw.templates : [];
  const deliveries = [raw.delivery, ...templates.map((t) => t?.delivery)].filter((d) => d !== undefined);
  if (deliveries.includes("project") || raw.tracker?.project !== undefined) return 2;
  if (deliveries.length > 0 || !raw.tracker) return 1;
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(codeDeliveryCapability());
