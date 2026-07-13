import { Hono } from "hono";
import { WIRE_VERSION, SCHEMA_VERSION } from "../shared/contract.js";
import { toPublicConfig } from "../shared/projection.js";
import { checkSchema } from "./db.js";
import { loadProject } from "./config.js";
import { originAllowed } from "./security/origin.js";
import { hitRateLimit, hourWindow } from "./security/ratelimit.js";
import { checkRepoAccess } from "./providers/github.js";
import { sniffImage, storeAttachment, deleteAssetsForFeedback, sweepExpiredAssets, publicUrl, MAX_UPLOAD_BYTES } from "./storage/r2.js";
import { ConfigError } from "./errors.js";
import type { Env } from "./env.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  // Reject oversize early on the declared length, then hard-check the real bytes.
  const declared = Number(c.req.header("Content-Length") ?? "0");
  if (declared > MAX_UPLOAD_BYTES) return c.json({ v: WIRE_VERSION, status: "error", error: "file too large" }, 413);
  const buf = new Uint8Array(await c.req.arrayBuffer());
  if (buf.byteLength === 0) return c.json({ v: WIRE_VERSION, status: "error", error: "empty body" }, 400);
  if (buf.byteLength > MAX_UPLOAD_BYTES) return c.json({ v: WIRE_VERSION, status: "error", error: "file too large" }, 413);

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

// Honest stubs — each names the milestone that builds it.
app.post("/api/feedback", notImplemented("P1.9"));
app.post("/api/events", notImplemented("P1.9"));
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
