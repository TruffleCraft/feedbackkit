import { DELIVERY_CAPABILITY, FeedbackConfig, WIRE_VERSION, requiredDeliveryCapability, resolveDelivery, type Delivery } from "../../shared/contract.js";
import { storedDeliveryCapability } from "../db.js";
import type { Env } from "../env.js";

// Shared by every config writer in the worker: the import route and the admin
// config editor (validate, publish). pnpm seed mirrors the gate in its own copy.

export type ConfigCheck =
  | { ok: true; config: FeedbackConfig; deliveries: Array<{ type: string; delivery: Delivery }> }
  | { ok: false; status: 400 | 422 | 503; body: Record<string, unknown> };

/** Zod validation plus the delivery shape gate (#109). */
export async function checkConfigForWrite(env: Env, raw: unknown): Promise<ConfigCheck> {
  const validated = FeedbackConfig.safeParse(raw);
  if (!validated.success) {
    // Admin-authed, so detailed Zod paths are safe — and save a debugging loop.
    const issues = validated.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    return { ok: false, status: 400, body: { v: WIRE_VERSION, status: "error", code: "FK_CONFIG_INVALID", error: "config failed validation", issues } };
  }
  // Compatibility gate: stable reads the same D1, so a shape it cannot handle yet
  // would break the project there. Accepted only once the promote workflow
  // recorded a stable release that handles it.
  const needed = requiredDeliveryCapability(raw);
  if (needed > 0) {
    let stored: number;
    try {
      stored = Math.min(await storedDeliveryCapability(env), DELIVERY_CAPABILITY);
    } catch (e) {
      console.error(`[feedbackkit] delivery capability read failed: ${(e as Error).message}`);
      return { ok: false, status: 503, body: { v: WIRE_VERSION, status: "error", error: "config check failed — are migrations applied? see /diag" } };
    }
    if (needed > stored) {
      return {
        ok: false,
        status: 422,
        body: {
          v: WIRE_VERSION,
          status: "error",
          code: "FK_CONFIG_SHAPE_UNSUPPORTED",
          error: `this config uses delivery settings (delivery, tracker.project or no tracker) that need delivery capability ${needed}; the live stable release provides ${stored}. Promote a release that supports them first, or keep tracker and noIssue.`,
          required: needed,
          available: stored,
        },
      };
    }
  }
  const config = validated.data;
  return { ok: true, config, deliveries: config.templates.map((t) => ({ type: t.type, delivery: resolveDelivery(config, t) })) };
}
