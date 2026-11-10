#!/usr/bin/env node
// node scripts/delivery-capability.mjs → prints DELIVERY_CAPABILITY of this
// checkout (src/shared/contract.ts). The promote workflow writes it to
// meta.delivery_capability once the release is live on stable (#109).
import { pathToFileURL } from "node:url";
import { codeDeliveryCapability } from "./code-capability.mjs";

export * from "./code-capability.mjs";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(codeDeliveryCapability());
