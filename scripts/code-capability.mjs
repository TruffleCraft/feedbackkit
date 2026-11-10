// What a checkout declares in src/shared/contract.ts: the delivery capability, the
// schema version, and which capability a stored config needs. No command line part,
// so the server bundle can include it without starting anything.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** DELIVERY_CAPABILITY as declared in src/shared/contract.ts. */
export function codeDeliveryCapability() {
  const src = readFileSync(fileURLToPath(new URL("../src/shared/contract.ts", import.meta.url)), "utf8");
  const m = /export const DELIVERY_CAPABILITY = (\d+) as const;/.exec(src);
  if (!m) throw new Error("DELIVERY_CAPABILITY not found in src/shared/contract.ts");
  return Number(m[1]);
}

/** SCHEMA_VERSION as declared in src/shared/contract.ts. */
export function codeSchemaVersion() {
  const src = readFileSync(fileURLToPath(new URL("../src/shared/contract.ts", import.meta.url)), "utf8");
  const m = /export const SCHEMA_VERSION = (\d+) as const;/.exec(src);
  if (!m) throw new Error("SCHEMA_VERSION not found in src/shared/contract.ts");
  return Number(m[1]);
}

/** Mirror of requiredDeliveryCapability in src/shared/contract.ts (test/delivery.test.ts keeps them equal). */
export function requiredDeliveryCapability(raw) {
  if (!raw || typeof raw !== "object") return 0;
  const templates = Array.isArray(raw.templates) ? raw.templates : [];
  if (templates.some((t) => t?.archived)) return 3;
  const deliveries = [raw.delivery, ...templates.map((t) => t?.delivery)].filter((d) => d !== undefined);
  if (deliveries.includes("project") || raw.tracker?.project !== undefined) return 2;
  if (deliveries.length > 0 || !raw.tracker) return 1;
  return 0;
}
