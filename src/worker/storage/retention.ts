import type { Env } from "../env.js";
import { hourWindow } from "../security/ratelimit.js";
import { deleteAssets } from "./r2.js";

// Daily cron, next to the R2 sweep: D1 rows follow the same app-level retention
// as attachments (storage.retentionDays, ADR-006). The `feedback` table holds the
// full submission (text, page URL, host context) for retry, so it must not
// outlive the project's retention promise. Retention is strict: a row is deleted
// at retentionDays after submission whether or not anyone handled it, together
// with its R2 assets. Unhandled rows (no issue) show up on the System page and in
// /diag NOTICE_DAYS before that. Projects without retentionDays keep their rows.

const DAY_MS = 86_400_000;
// dedup rows only guard client retries of one submission; a week is ample.
export const DEDUP_TTL_MS = 7 * DAY_MS;
/** Unhandled reports are listed this many days before retention deletes them. */
export const NOTICE_DAYS = 7;
// Rows per project per run; a backlog drains over the following days.
const PRUNE_BATCH = 500;
const NOTICE_LIMIT = 20;

export async function pruneExpiredRecords(env: Env, now = Date.now()): Promise<{ feedback: number; events: number; assets: number }> {
  let feedback = 0;
  let events = 0;
  let assets = 0;
  const projects = await env.DB.prepare("SELECT id, config FROM projects").all<{ id: string; config: string }>();
  for (const p of projects.results ?? []) {
    const days = retentionDays(p.config);
    if (!days) continue;
    const cutoff = now - days * DAY_MS;
    try {
      const rows = await env.DB.prepare("SELECT id, client_feedback_id FROM feedback WHERE project_id = ?1 AND created_at < ?2 ORDER BY created_at LIMIT ?3")
        .bind(p.id, cutoff, PRUNE_BATCH)
        .all<{ id: string; client_feedback_id: string | null }>();
      for (const row of rows.results ?? []) {
        // Assets first: a row whose assets could not all be deleted stays, so the
        // next run still knows which objects belong to it.
        if (row.client_feedback_id) {
          // Screenshots of a late delivery may outlive the row by up to 7 days
          // (expires_at); the asset sweep takes them then.
          const a = await deleteAssets(env, row.client_feedback_id, p.id, now);
          assets += a.deleted;
          if (a.failed.length) continue;
        }
        const f = await env.DB.prepare("DELETE FROM feedback WHERE id = ?1").bind(row.id).run();
        feedback += f.meta?.changes ?? 0;
      }
      const e = await env.DB.prepare("DELETE FROM events WHERE project_id = ?1 AND ts < ?2").bind(p.id, cutoff).run();
      events += e.meta?.changes ?? 0;
    } catch (err) {
      // One project's failure must not stop the others; the next run retries.
      console.warn(`[feedbackkit] retention prune failed for ${p.id}: ${(err as Error).message}`);
    }
  }
  await env.DB.prepare("DELETE FROM dedup WHERE created_at < ?1").bind(now - DEDUP_TTL_MS).run();
  await pruneIdleCounters(env, now);
  return { feedback, events, assets };
}

export interface RetentionNotice {
  retentionDays: number;
  /** Unhandled rows that retention deletes within NOTICE_DAYS. */
  dueSoon: number;
  /** The first NOTICE_LIMIT of them, oldest first. No report content. */
  items: Array<{ id: string; type: string | null; outcome: string; createdAt: number; deletesAt: number }>;
}

/** Unhandled reports (no issue was created: noIssue types and failed deliveries)
 * that retention deletes within NOTICE_DAYS. null when the project keeps rows. */
export async function retentionNotice(env: Env, projectId: string, days: number | undefined, now = Date.now()): Promise<RetentionNotice | null> {
  if (!days) return null;
  const threshold = now - Math.max(0, days - NOTICE_DAYS) * DAY_MS;
  const [count, rows] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM feedback WHERE project_id = ?1 AND issue_url IS NULL AND project_item_id IS NULL AND created_at < ?2").bind(projectId, threshold).first<{ n: number }>(),
    env.DB.prepare("SELECT id, type, outcome, created_at FROM feedback WHERE project_id = ?1 AND issue_url IS NULL AND project_item_id IS NULL AND created_at < ?2 ORDER BY created_at LIMIT ?3")
      .bind(projectId, threshold, NOTICE_LIMIT)
      .all<{ id: string; type: string | null; outcome: string; created_at: number }>(),
  ]);
  return {
    retentionDays: days,
    dueSoon: Number(count?.n ?? 0),
    items: (rows.results ?? []).map((r) => ({ id: r.id, type: r.type, outcome: r.outcome, createdAt: Number(r.created_at), deletesAt: Number(r.created_at) + days * DAY_MS })),
  };
}

/** storage.retentionDays from the raw config blob (a broken blob = keep). */
function retentionDays(raw: string): number | null {
  try {
    const days = (JSON.parse(raw) as { storage?: { retentionDays?: unknown } }).storage?.retentionDays;
    return typeof days === "number" && Number.isInteger(days) && days > 0 ? days : null;
  } catch {
    return null;
  }
}

/** Rate-limit rows are hourly buckets keyed by a hashed IP; once their hour is
 * over they are of no use, so the daily cron removes them (a row survives at
 * most one day after its last request). `llm:` rows are daily budget counters
 * with a day number as window and stay. */
export async function pruneIdleCounters(env: Env, now = Date.now()): Promise<void> {
  await env.DB.prepare("DELETE FROM counters WHERE key NOT LIKE 'llm:%' AND window_start < ?1").bind(hourWindow(now)).run();
}
