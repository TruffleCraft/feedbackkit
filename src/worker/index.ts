import { Hono } from "hono";
import { WIRE_VERSION, SCHEMA_VERSION, FeedbackPayload, EventPayload } from "../shared/contract.js";
import { toPublicConfig } from "../shared/projection.js";
import { orchestrateFeedback, realChat } from "./orchestrate.js";
import { checkSchema } from "./db.js";
import { loadProject } from "./config.js";
import { originAllowed } from "./security/origin.js";
import { hitRateLimit, hourWindow } from "./security/ratelimit.js";
import { checkRepoAccess } from "./providers/github.js";
import { sniffImage, storeAttachment, deleteAssetsForFeedback, sweepExpiredAssets, publicUrl, MAX_UPLOAD_BYTES } from "./storage/r2.js";
import { ConfigError } from "./errors.js";
import type { Env } from "./env.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Read a request body with a hard byte ceiling enforced DURING the read, so a
// client that lies about (or omits) Content-Length can't buffer an oversized
// body into isolate memory before we reject it. Aborts the stream once the cap
// is passed → memory is bounded to max + one chunk.
async function readBounded(stream: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | "too_large"> {
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        return "too_large";
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const chunk of chunks) {
    out.set(chunk, off);
    off += chunk.byteLength;
  }
  return out;
}

// Sane body ceilings for the JSON endpoints (schema field-caps bound the useful
// size; this stops a huge body being parsed into memory before Zod runs).
const MAX_FEEDBACK_BYTES = 512 * 1024;
const MAX_EVENT_BYTES = 4 * 1024;

async function readJsonBounded(c: import("hono").Context, max: number): Promise<{ ok: true; value: unknown } | { ok: false; tooLarge: boolean }> {
  const read = await readBounded(c.req.raw.body, max);
  if (read === "too_large") return { ok: false, tooLarge: true };
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(read)) };
  } catch {
    return { ok: false, tooLarge: false };
  }
}

export const VERSION = "0.0.0";

// Length-independent compare for the admin token (avoids leaking a match via
// early-return timing). Length itself is not treated as secret. Full admin-auth
// hardening (401 rate-limit, CSP) lands with the admin surface in P2.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function adminAuthed(c: import("hono").Context): boolean {
  const token = c.env["ADMIN_TOKEN"] as string | undefined;
  if (!token) return false;
  const header = c.req.header("Authorization") ?? "";
  const m = header.match(/^Bearer\s+(.+)$/);
  return m ? safeEqual(m[1]!, token) : false;
}

const app = new Hono<{ Bindings: Env }>();

// Widget loader stub (real bundle lands in P1.10; served from ASSETS / built to dist).
app.get("/widget.js", (c) => {
  c.header("Content-Type", "application/javascript; charset=utf-8");
  c.header("Cache-Control", "public, max-age=300, stale-while-revalidate=86400");
  return c.body(`// FeedbackKit widget ${VERSION} — loader stub (P1.10). See docs/ROADMAP.md\n`);
});

// Self-check (ADR-004 / DX): converts several first-request failures into one command.
// The base health (bindings + schema) is public. The ?project=<key> deep check
// drives the maintainer's PAT against GitHub and discloses config/secret metadata,
// so it is gated behind ADMIN_TOKEN and rate-limited (an open endpoint would let
// anyone burn the shared PAT budget → DoS of issue creation).
app.get("/diag", async (c) => {
  const schema = await checkSchema(c.env);
  const bindings = {
    DB: typeof c.env.DB?.prepare === "function",
    UPLOADS: typeof c.env.UPLOADS?.get === "function",
    ASSETS: typeof c.env.ASSETS?.fetch === "function",
  };

  let tracker = "skipped — pass ?project=<key>";
  let llm = "skipped — pass ?project=<key>";
  let r2 = "skipped — pass ?project=<key> (admin)";
  const project = c.req.query("project");
  if (project && !adminAuthed(c)) {
    tracker = llm = "unauthorized — deep check requires Authorization: Bearer <ADMIN_TOKEN>";
  } else if (project) {
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    const rl = await hitRateLimit(c.env, `diag:${ip}`, hourWindow(), 60);
    if (!rl.allowed) {
      return c.json({ service: "feedbackkit", version: VERSION, error: "rate limited" }, 429);
    }
    const loaded = await loadProject(c.env, project).catch((e) => {
      tracker = llm = `config error: ${(e as Error).message}`;
      return null;
    });
    if (loaded === null && tracker.startsWith("skipped")) {
      tracker = llm = "unknown project";
    } else if (loaded) {
      const pat = c.env[loaded.config.tracker.patSecret] as string | undefined;
      if (!pat) {
        tracker = `secret ${loaded.config.tracker.patSecret} not set`;
      } else {
        const a = await checkRepoAccess(loaded.config.tracker.defaultRepo, pat);
        tracker = a.ok ? `ok${a.patExpiry ? ` (PAT expires ${a.patExpiry})` : ""}` : `FAIL: ${a.reason}`;
      }
      const key = c.env["LLM_API_KEY"] as string | undefined;
      llm =
        loaded.config.llm.provider === "off"
          ? "disabled for this project"
          : !key
            ? "LLM_API_KEY not set (runs in required-field mode)"
            : `configured (${loaded.config.llm.model || "no model!"}) — live ping via \`pnpm test-issue\``;

      // R2 write/read/delete roundtrip (the object is removed immediately).
      try {
        const probe = `_diag/${crypto.randomUUID()}`;
        await c.env.UPLOADS.put(probe, "ok");
        const got = await c.env.UPLOADS.get(probe);
        await c.env.UPLOADS.delete(probe);
        r2 = got ? "ok (write/read/delete)" : "FAIL: read-after-write empty";
      } catch (e) {
        r2 = `FAIL: ${(e as Error).message}`;
      }
    }
  }

  const ok = schema.ok && bindings.DB && bindings.UPLOADS && !tracker.startsWith("FAIL") && !r2.startsWith("FAIL");
  return c.json(
    {
      service: "feedbackkit",
      version: VERSION,
      wireVersion: WIRE_VERSION,
      schema: { expected: SCHEMA_VERSION, ...schema },
      bindings,
      checks: { tracker, llm, r2 },
      ok,
    },
    ok ? 200 : 503,
  );
});

const notImplemented = (milestone: string) => (c: import("hono").Context) =>
  c.json({ v: WIRE_VERSION, status: "error", error: `not implemented yet (${milestone})` }, 501);

// CORS preflight: the widget is always cross-origin, and If-None-Match is not a
// safelisted header, so a conditional GET triggers OPTIONS. Reflect the requesting
// origin here (the actual GET still gates data access via its own ACAO check) and
// cache the preflight so it isn't re-sent on every open.
app.options("/api/config", (c) => {
  const origin = c.req.header("Origin");
  if (origin) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Vary", "Origin");
    c.header("Access-Control-Allow-Methods", "GET, OPTIONS");
    c.header("Access-Control-Allow-Headers", "If-None-Match, Content-Type");
    c.header("Access-Control-Max-Age", "3600");
  }
  return c.body(null, 204);
});

// Public config projection (P1.4). CORS is reflected only for allowlisted origins
// (never `*` on APIs); the widget fetches this on open, so it is revalidated (ETag).
app.get("/api/config", async (c) => {
  const key = c.req.query("project");
  if (!key) return c.json({ v: WIRE_VERSION, status: "error", error: "missing ?project" }, 400);

  // Per-IP throttle (defense-in-depth; misses are also negative-cached in loadProject).
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const rl = await hitRateLimit(c.env, `cfg:${ip}`, hourWindow(), 600);
  if (!rl.allowed) return c.json({ v: WIRE_VERSION, status: "error", error: "rate limited" }, 429);

  let loaded;
  try {
    loaded = await loadProject(c.env, key);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.warn(`[feedbackkit] ${e.message}`);
      return c.json({ v: WIRE_VERSION, status: "error", error: "project misconfigured" }, 500);
    }
    throw e;
  }
  if (!loaded) return c.json({ v: WIRE_VERSION, status: "error", error: "unknown project" }, 404);

  const origin = c.req.header("Origin");
  if (origin && originAllowed(origin, loaded.config.auth.origins)) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Vary", "Origin");
  }

  const etag = `"cfg-${loaded.version}"`;
  c.header("ETag", etag);
  c.header("Cache-Control", "no-cache");
  if (c.req.header("If-None-Match") === etag) return c.body(null, 304);

  return c.json(toPublicConfig(loaded.config, loaded.version));
});

// Attachment upload (P1.8). Cross-origin from the widget → preflight + ACAO gate.
app.options("/api/upload", (c) => {
  const origin = c.req.header("Origin");
  if (origin) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Vary", "Origin");
    c.header("Access-Control-Allow-Methods", "POST, OPTIONS");
    c.header("Access-Control-Allow-Headers", "Content-Type");
    c.header("Access-Control-Max-Age", "3600");
  }
  return c.body(null, 204);
});

app.post("/api/upload", async (c) => {
  const key = c.req.query("project");
  if (!key) return c.json({ v: WIRE_VERSION, status: "error", error: "missing ?project" }, 400);

  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const rl = await hitRateLimit(c.env, `up:${ip}`, hourWindow(), 60);
  if (!rl.allowed) return c.json({ v: WIRE_VERSION, status: "error", error: "rate limited" }, 429);

  let loaded;
  try {
    loaded = await loadProject(c.env, key);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.warn(`[feedbackkit] ${e.message}`);
      return c.json({ v: WIRE_VERSION, status: "error", error: "project misconfigured" }, 500);
    }
    throw e;
  }
  if (!loaded) return c.json({ v: WIRE_VERSION, status: "error", error: "unknown project" }, 404);
  const config = loaded.config;

  const origin = c.req.header("Origin");
  if (origin && !originAllowed(origin, config.auth.origins)) {
    return c.json({ v: WIRE_VERSION, status: "error", error: "origin not allowed" }, 403);
  }
  if (origin) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Vary", "Origin");
  }

  if (config.storage.kind !== "r2") {
    return c.json({ v: WIRE_VERSION, status: "error", error: "uploads disabled for this project" }, 409);
  }

  const feedbackId = c.req.query("feedbackId") ?? "";
  if (!UUID_RE.test(feedbackId)) {
    return c.json({ v: WIRE_VERSION, status: "error", error: "missing or invalid feedbackId" }, 400);
  }
  const kind = c.req.query("kind") === "screenshot" ? "screenshot" : "upload";

  // Courtesy early-out for honest clients; the real ceiling is enforced during
  // the streaming read below (a lying/absent Content-Length can't get past it).
  const declared = Number(c.req.header("Content-Length") ?? "0");
  if (declared > MAX_UPLOAD_BYTES) return c.json({ v: WIRE_VERSION, status: "error", error: "file too large" }, 413);
  const read = await readBounded(c.req.raw.body, MAX_UPLOAD_BYTES);
  if (read === "too_large") return c.json({ v: WIRE_VERSION, status: "error", error: "file too large" }, 413);
  const buf = read;
  if (buf.byteLength === 0) return c.json({ v: WIRE_VERSION, status: "error", error: "empty body" }, 400);

  // Sniff the actual bytes; the Content-Type header is never trusted.
  const sniff = sniffImage(buf);
  if (!sniff) return c.json({ v: WIRE_VERSION, status: "error", error: "unsupported file type (png/jpeg/webp/gif only)" }, 415);

  try {
    const stored = await storeAttachment(c.env, {
      projectId: config.projectId,
      feedbackId,
      kind,
      bytes: buf,
      sniff,
      retentionDays: config.storage.retentionDays,
      now: Date.now(),
      keyId: crypto.randomUUID(),
    });
    return c.json({ v: WIRE_VERSION, key: stored.key, url: publicUrl(config.storage.publicBaseUrl, stored.key) });
  } catch (e) {
    console.warn(`[feedbackkit] upload store failed: ${(e as Error).message}`);
    return c.json({ v: WIRE_VERSION, status: "error", error: "upload failed" }, 502);
  }
});

// GDPR delete (P1.8): remove all attachments for a feedback id. Admin-authed.
// Registered before the /api/admin/* catch-all so it isn't shadowed by the stub.
app.delete("/api/admin/assets", async (c) => {
  if (!adminAuthed(c)) return c.json({ v: WIRE_VERSION, status: "error", error: "unauthorized" }, 401);
  const feedbackId = c.req.query("feedbackId") ?? "";
  if (!UUID_RE.test(feedbackId)) return c.json({ v: WIRE_VERSION, status: "error", error: "missing or invalid feedbackId" }, 400);
  const deleted = await deleteAssetsForFeedback(c.env, feedbackId);
  return c.json({ v: WIRE_VERSION, deleted });
});

// Feedback orchestration (P1.9) — the core 2-POST loop. Cross-origin (JSON body
// triggers preflight); gate + reflect like the other public endpoints.
app.options("/api/feedback", (c) => {
  const origin = c.req.header("Origin");
  if (origin) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Vary", "Origin");
    c.header("Access-Control-Allow-Methods", "POST, OPTIONS");
    c.header("Access-Control-Allow-Headers", "Content-Type");
    c.header("Access-Control-Max-Age", "3600");
  }
  return c.body(null, 204);
});

app.post("/api/feedback", async (c) => {
  const key = c.req.query("project");
  if (!key) return c.json({ v: WIRE_VERSION, status: "error", error: "missing ?project" }, 400);

  const body = await readJsonBounded(c, MAX_FEEDBACK_BYTES);
  if (!body.ok) return c.json({ v: WIRE_VERSION, status: "error", error: body.tooLarge ? "payload too large" : "invalid json" }, body.tooLarge ? 413 : 400);
  const raw = body.value;
  // Honeypot: a filled trap field gets a plausible fake success — never reveal it.
  if (raw && typeof raw === "object" && typeof (raw as { hpField?: unknown }).hpField === "string" && (raw as { hpField: string }).hpField.length > 0) {
    return c.json({ v: WIRE_VERSION, status: "created", id: crypto.randomUUID() });
  }
  const parsed = FeedbackPayload.safeParse(raw);
  if (!parsed.success) return c.json({ v: WIRE_VERSION, status: "error", error: "invalid payload" }, 400);

  let loaded;
  try {
    loaded = await loadProject(c.env, key);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.warn(`[feedbackkit] ${e.message}`);
      return c.json({ v: WIRE_VERSION, status: "error", error: "project misconfigured" }, 500);
    }
    // D1 read failed (not a config problem) → retryable; the client keeps the
    // unsent feedback, so nothing is lost — 503 tells it to retry.
    console.error(`[feedbackkit] loadProject failed: ${(e as Error).message}`);
    return c.json({ v: WIRE_VERSION, status: "error", error: "temporarily unavailable" }, 503);
  }
  if (!loaded) return c.json({ v: WIRE_VERSION, status: "error", error: "unknown project" }, 404);

  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const rl = await hitRateLimit(c.env, `fb:${ip}`, hourWindow(), loaded.config.rateLimit.perHour);
  if (!rl.allowed) return c.json({ v: WIRE_VERSION, status: "error", error: "rate limited" }, 429);

  const origin = c.req.header("Origin");
  if (origin && !originAllowed(origin, loaded.config.auth.origins)) {
    return c.json({ v: WIRE_VERSION, status: "error", error: "origin not allowed" }, 403);
  }
  if (origin) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Vary", "Origin");
  }

  if (!loaded.config.enabled) return c.json({ v: WIRE_VERSION, status: "error", error: "feedback disabled" }, 403);

  const apiKey = c.env["LLM_API_KEY"] as string | undefined;
  try {
    const result = await orchestrateFeedback(c.env, loaded, parsed.data, { apiKey, chat: realChat });
    return c.json(result.body, result.http as 200 | 400);
  } catch (e) {
    // orchestrate is built never to throw; if it ever does, return a terminal
    // issue_failed (client keeps the feedback) — never a bare 500.
    console.error(`[feedbackkit] orchestrate crashed: ${(e as Error).message}`);
    return c.json({ v: WIRE_VERSION, status: "issue_failed", id: parsed.data.feedbackId, reason: "internal error" });
  }
});

app.options("/api/events", (c) => {
  const origin = c.req.header("Origin");
  if (origin) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Vary", "Origin");
    c.header("Access-Control-Allow-Methods", "POST, OPTIONS");
    c.header("Access-Control-Allow-Headers", "Content-Type");
    c.header("Access-Control-Max-Age", "3600");
  }
  return c.body(null, 204);
});

// Funnel events (P1.9): enum-only, fire-and-forget beacon. Never content, never
// IP; always 204 so a bad beacon can't surface an error to the page. Per-IP
// throttled and bounded (an anonymous endpoint that writes D1 + resolves an
// arbitrary project key is otherwise a flood + cache-amplification surface).
app.post("/api/events", async (c) => {
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const rl = await hitRateLimit(c.env, `ev:${ip}`, hourWindow(), 600);
  if (!rl.allowed) return c.body(null, 204); // silently drop
  const body = await readJsonBounded(c, MAX_EVENT_BYTES);
  if (!body.ok) return c.body(null, 204);
  const parsed = EventPayload.safeParse(body.value);
  if (parsed.success) {
    try {
      const loaded = await loadProject(c.env, parsed.data.project);
      if (loaded) {
        await c.env.DB.prepare("INSERT INTO events (project_id, name, ts) VALUES (?1, ?2, ?3)")
          .bind(loaded.config.projectId, parsed.data.name, Date.now())
          .run();
      }
    } catch {
      /* fire-and-forget: never block or error the page */
    }
  }
  return c.body(null, 204);
});

// Honest stubs — each names the milestone that builds it.
app.get("/t/:key", notImplemented("P1.11"));
app.all("/api/admin/*", notImplemented("P2"));

app.get("/", (c) => c.text(`FeedbackKit ${VERSION} — see /diag`));

// Test entrypoint: route tests call app.request().
export { app };

// Workers module entrypoint: Hono serves fetch; the daily cron sweeps expired R2
// attachments (events rollup joins this handler in P1.9).
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(sweepExpiredAssets(env));
  },
};
