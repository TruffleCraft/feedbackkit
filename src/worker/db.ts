import { SCHEMA_VERSION } from "../shared/contract.js";
import type { Env } from "./env.js";

export type SchemaState =
  | { ok: true; version: number }
  | { ok: false; version: number | null; expected: number; reason: string };

// Boot-time schema check (ADR-004 invariant 2): if the DB schema is behind the
// code, /diag goes red and write endpoints refuse rather than failing cryptically.
// Cheap readiness signal for /diag and the landing page. null = the query
// failed (migrations not applied yet, or D1 unreachable) — callers treat that
// the same as "no projects": the install is not usable yet.
export async function countProjects(env: Env): Promise<number | null> {
  try {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM projects").first<{ n: number }>();
    return row ? Number(row.n) : 0;
  } catch {
    return null;
  }
}

export async function checkSchema(env: Env): Promise<SchemaState> {
  try {
    const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'schema_version'").first<{
      value: string;
    }>();
    if (!row) {
      return { ok: false, version: null, expected: SCHEMA_VERSION, reason: "meta.schema_version missing — run `pnpm deploy` to apply migrations" };
    }
    const version = Number(row.value);
    if (version !== SCHEMA_VERSION) {
      return {
        ok: false,
        version,
        expected: SCHEMA_VERSION,
        reason: `schema out of date: found ${version}, expected ${SCHEMA_VERSION} — run \`pnpm deploy\` so D1 migrations apply`,
      };
    }
    return { ok: true, version };
  } catch (e) {
    return { ok: false, version: null, expected: SCHEMA_VERSION, reason: `D1 read failed: ${(e as Error).message}` };
  }
}
