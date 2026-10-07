import type { Env } from "../env.js";

// Daily cron, next to the R2 sweep: D1 rows follow the same app-level retention
// as attachments (storage.retentionDays, ADR-006). The `feedback` table holds the
// full submission (text, page URL, host context) for retry, so it must not
// outlive the project's retention promise. Projects without retentionDays keep
// their rows, as before.

const DAY_MS = 86_400_000;
// dedup rows only guard client retries of one submission; a week is ample.
export const DEDUP_TTL_MS = 7 * DAY_MS;

export async function pruneExpiredRecords(env: Env, now = Date.now()): Promise<{ feedback: number; events: number }> {
  let feedback = 0;
  let events = 0;
  const projects = await env.DB.prepare("SELECT id, config FROM projects").all<{ id: string; config: string }>();
  for (const p of projects.results ?? []) {
    const days = retentionDays(p.config);
    if (!days) continue;
    const cutoff = now - days * DAY_MS;
    try {
      const f = await env.DB.prepare("DELETE FROM feedback WHERE project_id = ?1 AND created_at < ?2").bind(p.id, cutoff).run();
      const e = await env.DB.prepare("DELETE FROM events WHERE project_id = ?1 AND ts < ?2").bind(p.id, cutoff).run();
      feedback += f.meta?.changes ?? 0;
      events += e.meta?.changes ?? 0;
    } catch (err) {
      // One project's failure must not stop the others; the next run retries.
      console.warn(`[feedbackkit] retention prune failed for ${p.id}: ${(err as Error).message}`);
    }
  }
  await env.DB.prepare("DELETE FROM dedup WHERE created_at < ?1").bind(now - DEDUP_TTL_MS).run();
  return { feedback, events };
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
