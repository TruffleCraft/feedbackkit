import type { Context, Hono } from "hono";
import { WIRE_VERSION, SCHEMA_VERSION } from "../../shared/contract.js";
import { checkSchema } from "../db.js";
import { dayWindow } from "../security/ratelimit.js";
import { checkRepoAccess } from "../providers/github.js";
import { releaseOf, bindingsPresence, secretsPresence } from "../status.js";
import { adminCheck, adminGate } from "./auth.js";
import { DAY_MS, QueryError, exportConfig, getFunnel, listFeedback, listProjects, parseConfig, type ProjectRow } from "./queries.js";
import type { Env } from "../env.js";

// Read-only admin API (P2, step 1). Every route runs through adminGate (a
// Cloudflare Access sign-in or the bearer ADMIN_TOKEN, failed token attempts
// rate-limited per hashed IP). Responses carry
// feedback content and config, but never IP addresses, secret values, device
// info or host context. The queries live in queries.ts, shared with the MCP
// tools (mcp/tools.ts).

type AppT = Hono<{ Bindings: Env }>;
type Ctx = Context<{ Bindings: Env }>;

const err = (c: Ctx, status: 400 | 404 | 500, error: string) => c.json({ v: WIRE_VERSION, status: "error", error }, status);

/** Runs a shared query and maps its QueryError to the admin API's error shape. */
async function answer(c: Ctx, run: () => Promise<Record<string, unknown>>): Promise<Response> {
  try {
    return c.json(await run());
  } catch (e) {
    if (e instanceof QueryError) return err(c, e.status, e.message);
    throw e;
  }
}

/** GitHub's token expiry header ("2026-11-01 00:00:00 UTC") as a structured field. */
export function parsePatExpiry(raw: string | undefined, now = Date.now()): { raw: string; at: string | null; daysLeft: number | null } | null {
  if (!raw) return null;
  const iso = raw.trim().replace(" ", "T").replace(/ UTC$/, "Z").replace(/ ([+-]\d{2})(\d{2})$/, "$1:$2");
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return { raw, at: null, daysLeft: null };
  return { raw, at: new Date(t).toISOString(), daysLeft: Math.floor((t - now) / DAY_MS) };
}

export function registerAdminRoutes(app: AppT): void {
  // ── Who is signed in: an Access user (with email) or the token holder ───────
  // Probed by the admin UI on every load without a token, so a request with no
  // credentials at all gets a 401 that does not count toward the lockout.
  app.get("/api/admin/me", async (c) => {
    const r = await adminCheck(c, { countAnonymous: false });
    if (!r.ok) return r.res;
    const id = r.identity;
    return c.json(id.via === "access" ? { v: WIRE_VERSION, via: "access", email: id.email } : { v: WIRE_VERSION, via: "token" });
  });

  // ── Project list with a 7-day feedback count ────────────────────────────────
  app.get("/api/admin/projects", async (c) => {
    const denied = await adminGate(c);
    if (denied) return denied;
    return c.json({ v: WIRE_VERSION, projects: await listProjects(c.env) });
  });

  // ── Config export (re-importable through POST /api/admin/config/import) ─────
  app.get("/api/admin/projects/:id/config", async (c) => {
    const denied = await adminGate(c);
    if (denied) return denied;
    // The raw blob as stored (no defaults filled in), plus the columns kept
    // outside it. The import pins publicKey and ignores configVersion.
    return answer(c, () => exportConfig(c.env, c.req.param("id")));
  });

  // ── Feedback history, newest first, keyset-paginated ────────────────────────
  app.get("/api/admin/projects/:id/feedback", async (c) => {
    const denied = await adminGate(c);
    if (denied) return denied;
    const limitRaw = c.req.query("limit");
    return answer(c, async () => ({
      v: WIRE_VERSION,
      ...(await listFeedback(c.env, {
        projectId: c.req.param("id"),
        limit: limitRaw === undefined ? undefined : Number(limitRaw),
        outcome: c.req.query("outcome") || undefined,
        cursor: c.req.query("cursor") || undefined,
      })),
    }));
  });

  // ── Funnel: widget events by name + feedback outcomes in the window ─────────
  app.get("/api/admin/projects/:id/funnel", async (c) => {
    const denied = await adminGate(c);
    if (denied) return denied;
    const daysRaw = c.req.query("days");
    return answer(c, async () => ({ v: WIRE_VERSION, ...(await getFunnel(c.env, c.req.param("id"), daysRaw === undefined ? undefined : Number(daysRaw))) }));
  });

  // ── System: release, schema, bindings, secret presence, per-project budget + PAT ──
  app.get("/api/admin/system", async (c) => {
    const denied = await adminGate(c);
    if (denied) return denied;
    const today = dayWindow();
    const [schema, projects, usage] = await Promise.all([
      checkSchema(c.env),
      c.env.DB.prepare("SELECT id, public_key, config, config_version, updated_at FROM projects ORDER BY id").all<ProjectRow>(),
      c.env.DB.prepare("SELECT key, count FROM counters WHERE key LIKE 'llm:%' AND window_start = ?1").bind(today).all<{ key: string; count: number }>(),
    ]);
    const usedToday = new Map((usage.results ?? []).map((r) => [r.key, Number(r.count)]));

    const perProject = await Promise.all(
      (projects.results ?? []).map(async (p) => {
        const cfg = parseConfig(p.config);
        if (!cfg) return { id: p.id, configVersion: Number(p.config_version), configValid: false as const };
        const patSecret = cfg.tracker.patSecret;
        const pat = c.env[patSecret] as string | undefined;
        let access: { ok: boolean; status: number; reason: string | null } | null = null;
        let patExpiry: ReturnType<typeof parsePatExpiry> = null;
        if (pat) {
          try {
            const a = await checkRepoAccess(cfg.tracker.defaultRepo, pat);
            access = { ok: a.ok, status: a.status, reason: a.reason ?? null };
            patExpiry = parsePatExpiry(a.patExpiry);
          } catch (e) {
            access = { ok: false, status: 0, reason: `check failed: ${(e as Error).message}` };
          }
        }
        return {
          id: p.id,
          configVersion: Number(p.config_version),
          configValid: true as const,
          enabled: cfg.enabled,
          llm: {
            provider: cfg.llm.provider,
            model: cfg.llm.model || null,
            usedToday: usedToday.get(`llm:${cfg.projectId}`) ?? 0,
            dailyBudget: cfg.llm.dailyBudget,
          },
          tracker: {
            repo: cfg.tracker.defaultRepo,
            patSecret,
            patPresent: Boolean(pat),
            access,
            patExpiry,
          },
          ...(cfg.turnstile ? { turnstile: { secret: cfg.turnstile.secret, secretPresent: Boolean(c.env[cfg.turnstile.secret]) } } : {}),
        };
      }),
    );

    return c.json({
      v: WIRE_VERSION,
      service: "feedbackkit",
      ...releaseOf(c.env),
      wireVersion: WIRE_VERSION,
      schema: { expected: SCHEMA_VERSION, ...schema },
      bindings: bindingsPresence(c.env),
      secrets: secretsPresence(c.env),
      projects: perProject,
    });
  });
}
