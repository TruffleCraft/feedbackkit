import { env } from "cloudflare:test";
import type { Env } from "../../src/worker/env.js";

/** Empty the tables and the bucket the durability tests write to. */
export async function resetStorage(): Promise<void> {
  await env.DB.batch(["feedback", "assets", "projects", "dedup", "events", "counters"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  const listed = await env.UPLOADS.list();
  if (listed.objects.length) await env.UPLOADS.delete(listed.objects.map((o) => o.key));
}

/** The real D1, except that writes to the feedback table fail (D1 outage). */
export function failingFeedbackWrites(base: Env): Env {
  const DB = new Proxy(base.DB, {
    get(target, prop, receiver) {
      if (prop !== "prepare") return Reflect.get(target, prop, receiver);
      return (sql: string) => {
        if (/^\s*INSERT INTO feedback\b/.test(sql)) throw new Error("D1_ERROR: simulated outage");
        return target.prepare(sql);
      };
    },
  });
  return { ...base, DB };
}
