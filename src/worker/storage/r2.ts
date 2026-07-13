import type { Env } from "../env.js";

// R2 attachment store (P1.8, ADR-006). Screenshots + basic image uploads only in
// v1 (PDF/log/text are P3). The public bucket serves objects with a short max-age
// so a later delete propagates past GitHub's camo image cache reasonably fast
// (residual risk documented in SECURITY.md — camo may retain a copy).

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 2 MB — widget resizes screenshots first
const CACHE_CONTROL = "public, max-age=300";

// Content-Type headers are attacker-controlled, so the ACTUAL bytes decide the
// type and the stored extension. Only these four image signatures are accepted.
const SIGNATURES: Array<{ ext: string; mime: string; match: (b: Uint8Array) => boolean }> = [
  { ext: "png", mime: "image/png", match: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: "jpg", mime: "image/jpeg", match: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "gif", mime: "image/gif", match: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
  {
    ext: "webp",
    mime: "image/webp",
    // "RIFF" .... "WEBP"
    match: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
];

export interface SniffResult {
  ext: string;
  mime: string;
}

/** Identify an accepted image by its magic bytes, or null if unrecognized. */
export function sniffImage(bytes: Uint8Array): SniffResult | null {
  if (bytes.length < 12) return null; // WebP needs bytes 8–11
  for (const s of SIGNATURES) if (s.match(bytes)) return { ext: s.ext, mime: s.mime };
  return null;
}

export interface StoreOpts {
  projectId: string;
  feedbackId: string;
  kind: string; // screenshot | upload
  bytes: Uint8Array;
  sniff: SniffResult;
  retentionDays?: number;
  now: number;
  keyId: string; // caller-supplied random id (injectable for tests)
}

export interface StoredAsset {
  key: string;
  mime: string;
}

/** Put the object in R2 and index it in `assets`. On DB failure the orphaned R2
 * object is removed so the retention table stays authoritative. */
export async function storeAttachment(env: Env, opts: StoreOpts): Promise<StoredAsset> {
  const key = `${opts.projectId}/${opts.keyId}.${opts.sniff.ext}`;
  const expiresAt = opts.retentionDays ? opts.now + opts.retentionDays * 86_400_000 : null;

  await env.UPLOADS.put(key, opts.bytes, {
    httpMetadata: { contentType: opts.sniff.mime, cacheControl: CACHE_CONTROL },
  });
  try {
    await env.DB.prepare(
      `INSERT INTO assets (key, project_id, feedback_id, kind, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
      .bind(key, opts.projectId, opts.feedbackId, opts.kind, expiresAt, opts.now)
      .run();
  } catch (e) {
    // Compensate: remove the object so there's no orphan without an index row.
    // If the cleanup ALSO fails, the object is unreachable by sweep/GDPR-delete
    // (both iterate `assets`) — log the key loudly so an operator can reconcile.
    await env.UPLOADS.delete(key).catch((delErr) =>
      console.warn(`[feedbackkit] ORPHANED R2 object ${key} — index insert and cleanup both failed, reconcile the bucket manually: ${(delErr as Error).message}`),
    );
    throw e;
  }
  return { key, mime: opts.sniff.mime };
}

/** Resolve a stored key to its public URL, if the project set a public base. */
export function publicUrl(publicBaseUrl: string | undefined, key: string): string | undefined {
  if (!publicBaseUrl) return undefined;
  return `${publicBaseUrl.replace(/\/$/, "")}/${key}`;
}

/** Daily cron: delete R2 objects past their expiry and mark the rows deleted. */
export async function sweepExpiredAssets(env: Env, now = Date.now(), batch = 500): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT key FROM assets WHERE deleted = 0 AND expires_at IS NOT NULL AND expires_at < ?1 LIMIT ?2`,
  )
    .bind(now, batch)
    .all<{ key: string }>();
  let n = 0;
  for (const r of rows.results ?? []) {
    try {
      await env.UPLOADS.delete(r.key);
      await env.DB.prepare(`UPDATE assets SET deleted = 1 WHERE key = ?1`).bind(r.key).run();
      n++;
    } catch (e) {
      console.warn(`[feedbackkit] asset sweep failed for ${r.key}: ${(e as Error).message}`);
    }
  }
  return n;
}

/** GDPR Art. 17: delete every attachment tied to a feedback id (admin-authed). */
export async function deleteAssetsForFeedback(env: Env, feedbackId: string): Promise<number> {
  const rows = await env.DB.prepare(`SELECT key FROM assets WHERE feedback_id = ?1 AND deleted = 0`)
    .bind(feedbackId)
    .all<{ key: string }>();
  let n = 0;
  for (const r of rows.results ?? []) {
    // Per-row like the sweep: one bad key must not abort a compliance erasure.
    // Retry is safe (idempotent: WHERE deleted = 0 + idempotent R2 delete).
    try {
      await env.UPLOADS.delete(r.key);
      await env.DB.prepare(`UPDATE assets SET deleted = 1 WHERE key = ?1`).bind(r.key).run();
      n++;
    } catch (e) {
      console.warn(`[feedbackkit] GDPR delete failed for ${r.key}: ${(e as Error).message}`);
    }
  }
  return n;
}
