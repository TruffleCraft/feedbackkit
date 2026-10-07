// Workers module entrypoint — ONLY the default handler may be exported here
// (wrangler/miniflare treats every named export of the entry module as a
// WorkerEntrypoint and refuses to start on non-handler values). Routes, the
// version constant, and the test surface live in app.ts.
import { app } from "./app.js";
import { sweepExpiredAssets } from "./storage/r2.js";
import { pruneExpiredRecords } from "./storage/retention.js";
import type { Env } from "./env.js";

// Hono serves fetch; the daily cron sweeps expired R2 attachments and prunes
// D1 rows past the project's retention.
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(Promise.allSettled([sweepExpiredAssets(env), pruneExpiredRecords(env)]));
  },
};
