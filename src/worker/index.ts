import { Hono } from "hono";
import { WIRE_VERSION, SCHEMA_VERSION } from "../shared/contract.js";
import { toPublicConfig } from "../shared/projection.js";
import { checkSchema } from "./db.js";
import { loadProject } from "./config.js";
import { originAllowed } from "./security/origin.js";
import { hitRateLimit, hourWindow } from "./security/ratelimit.js";
import { checkRepoAccess } from "./providers/github.js";
import { ConfigError } from "./errors.js";
import type { Env } from "./env.js";

export const VERSION = "0.0.0";

const app = new Hono<{ Bindings: Env }>();

// Widget loader stub (real bundle lands in P1.10; served from ASSETS / built to dist).
app.get("/widget.js", (c) => {
  c.header("Content-Type", "application/javascript; charset=utf-8");
  c.header("Cache-Control", "public, max-age=300, stale-while-revalidate=86400");
  return c.body(`// FeedbackKit widget ${VERSION} — loader stub (P1.10). See docs/ROADMAP.md\n`);
});

// Self-check (ADR-004 / DX): converts several first-request failures into one command.
// Pass ?project=<key> to also check that project's PAT repo access + LLM config.
app.get("/diag", async (c) => {
  const schema = await checkSchema(c.env);
  const bindings = {
    DB: typeof c.env.DB?.prepare === "function",
    UPLOADS: typeof c.env.UPLOADS?.get === "function",
    ASSETS: typeof c.env.ASSETS?.fetch === "function",
  };

  let tracker = "skipped — pass ?project=<key>";
  let llm = "skipped — pass ?project=<key>";
  const project = c.req.query("project");
  if (project) {
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
    }
  }

  const ok = schema.ok && bindings.DB && bindings.UPLOADS && !tracker.startsWith("FAIL");
  return c.json(
    {
      service: "feedbackkit",
      version: VERSION,
      wireVersion: WIRE_VERSION,
      schema: { expected: SCHEMA_VERSION, ...schema },
      bindings,
      checks: { tracker, llm, r2Roundtrip: "not_implemented (P1.8)" },
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

// Honest stubs — each names the milestone that builds it.
app.post("/api/feedback", notImplemented("P1.9"));
app.post("/api/upload", notImplemented("P1.8"));
app.post("/api/events", notImplemented("P1.9"));
app.get("/t/:key", notImplemented("P1.11"));
app.all("/api/admin/*", notImplemented("P2"));

app.get("/", (c) => c.text(`FeedbackKit ${VERSION} — see /diag`));

export default app;
