import { Hono } from "hono";
import { WIRE_VERSION, SCHEMA_VERSION } from "../shared/contract.js";
import { toPublicConfig } from "../shared/projection.js";
import { checkSchema } from "./db.js";
import { loadProject } from "./config.js";
import { originAllowed } from "./security/origin.js";
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
app.get("/diag", async (c) => {
  const schema = await checkSchema(c.env);
  const bindings = {
    DB: typeof c.env.DB?.prepare === "function",
    UPLOADS: typeof c.env.UPLOADS?.get === "function",
    ASSETS: typeof c.env.ASSETS?.fetch === "function",
  };
  const ok = schema.ok && bindings.DB && bindings.UPLOADS;
  return c.json(
    {
      service: "feedbackkit",
      version: VERSION,
      wireVersion: WIRE_VERSION,
      schema: { expected: SCHEMA_VERSION, ...schema },
      bindings,
      // Checks wired in later milestones — declared here so /diag enumerates the full set.
      checks: {
        llmPing: "not_implemented (P1.6)",
        patPerProject: "not_implemented (P1.7)",
        r2Roundtrip: "not_implemented (P1.8)",
      },
      ok,
    },
    ok ? 200 : 503,
  );
});

const notImplemented = (milestone: string) => (c: import("hono").Context) =>
  c.json({ v: WIRE_VERSION, status: "error", error: `not implemented yet (${milestone})` }, 501);

// Public config projection (P1.4). CORS is reflected only for allowlisted origins
// (never `*` on APIs); the widget fetches this on open, so it is revalidated (ETag).
app.get("/api/config", async (c) => {
  const key = c.req.query("project");
  if (!key) return c.json({ v: WIRE_VERSION, status: "error", error: "missing ?project" }, 400);

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
