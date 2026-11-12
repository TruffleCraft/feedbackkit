import { DELIVERY_CAPABILITY, WIRE_VERSION, requiredDeliveryCapability, type Delivery } from "../../shared/contract.js";
import { storedDeliveryCapability } from "../db.js";
import type { Env } from "../env.js";
import { checkConfigForWrite, parseStoredConfig } from "./config-write.js";

// One project import, shared by POST /api/admin/config/import and the host command
// `feedbackkit-admin import` (scripts/server-admin.mjs). Both take the JSON shape of
// `pnpm seed` and of an admin export: an optional top-level publicKey pins the snippet
// key (stored in its own column, never in the config blob), and configVersion from an
// export is informational and dropped. Re-importing a projectId updates the config
// and bumps config_version; the public key never rotates on update.

/** The largest config the route and the host command accept, in bytes. */
export const CONFIG_IMPORT_MAX_BYTES = 512 * 1024;

const PUBLIC_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;

export type ImportFailure = { ok: false; status: 400 | 409 | 422 | 503; body: Record<string, unknown> };
export type ImportSuccess = {
  ok: true;
  dryRun: boolean;
  created: boolean;
  projectId: string;
  /** The key the snippet uses. Null only in a dry run that would generate a new one. */
  publicKey: string | null;
  configVersion: number;
  deliveries: Array<{ type: string; delivery: Delivery }>;
  /** Dry run only: the delivery capability the config needs, and the one this database records. */
  capability?: { required: number; available: number };
};

const fail = (status: ImportFailure["status"], error: string): ImportFailure => ({ ok: false, status, body: { v: WIRE_VERSION, status: "error", error } });

/** Validates a parsed config and, unless `dryRun`, stores it. Never throws for bad input. */
export async function importProjectConfig(env: Env, value: unknown, opts: { dryRun?: boolean } = {}): Promise<ImportSuccess | ImportFailure> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail(400, "config must be a JSON object");

  const { publicKey: pinnedRaw, configVersion: _exportedVersion, ...cfg } = value as Record<string, unknown>;
  if (pinnedRaw !== undefined && (typeof pinnedRaw !== "string" || !PUBLIC_KEY_RE.test(pinnedRaw))) {
    return fail(400, "publicKey must be 8-64 chars of [A-Za-z0-9_-]");
  }
  const pinned = pinnedRaw as string | undefined;

  // Importing over an existing project is a settings write too: its published types stay.
  const existing =
    typeof cfg["projectId"] === "string"
      ? await env.DB.prepare("SELECT config FROM projects WHERE id = ?1").bind(cfg["projectId"]).first<{ config: string }>().catch(() => null)
      : null;
  const check = await checkConfigForWrite(env, cfg, parseStoredConfig(existing?.config));
  if (!check.ok) return check;
  const id = check.config.projectId;

  if (opts.dryRun) {
    // What the write below would do, without it. A pinned key held by another project is the one write error a read can predict.
    const row = await env.DB.prepare("SELECT public_key, config_version FROM projects WHERE id = ?1").bind(id).first<{ public_key: string; config_version: number }>().catch(() => null);
    if (pinned && !row) {
      const holder = await env.DB.prepare("SELECT id FROM projects WHERE public_key = ?1").bind(pinned).first<{ id: string }>().catch(() => null);
      if (holder) return fail(409, "publicKey already in use by another project");
    }
    let available = 0;
    try { available = Math.min(await storedDeliveryCapability(env), DELIVERY_CAPABILITY); } catch { /* checkConfigForWrite already refused a shape that needs it */ }
    return {
      ok: true,
      dryRun: true,
      created: !row,
      projectId: id,
      publicKey: row?.public_key ?? pinned ?? null,
      configVersion: row ? Number(row.config_version) + 1 : 1,
      deliveries: check.deliveries,
      capability: { required: requiredDeliveryCapability(cfg), available },
    };
  }

  // Store the raw blob (minus publicKey), like `pnpm seed`: loadProject re-runs
  // Zod on every read, so future schema defaults apply without a re-import.
  const publicKey = pinned || `fk_pub_${[...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  try {
    await env.DB.prepare(
      `INSERT INTO projects (id, public_key, config, config_version, updated_at)
       VALUES (?1, ?2, ?3, 1, ?4)
       ON CONFLICT(id) DO UPDATE SET config = excluded.config, config_version = projects.config_version + 1, updated_at = excluded.updated_at`,
    )
      .bind(id, publicKey, JSON.stringify(cfg), Date.now())
      .run();
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (msg.includes("UNIQUE")) return fail(409, "publicKey already in use by another project");
    console.error(`[feedbackkit] config import failed: ${msg}`);
    return fail(503, "import failed — are migrations applied? see /diag");
  }

  // Read the row back: on update the STORED key and bumped version win, not the
  // request's — so the result always reflects what the snippet must use.
  const row = await env.DB.prepare("SELECT public_key, config_version FROM projects WHERE id = ?1")
    .bind(id)
    .first<{ public_key: string; config_version: number }>();
  return {
    ok: true,
    dryRun: false,
    created: !existing,
    projectId: id,
    publicKey: row?.public_key ?? publicKey,
    configVersion: Number(row?.config_version ?? 1),
    deliveries: check.deliveries,
  };
}
