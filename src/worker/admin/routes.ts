import type { Context, Hono } from "hono";
import { WIRE_VERSION, SCHEMA_VERSION, FeedbackConfig, resolveDelivery } from "../../shared/contract.js";
import { checkSchema } from "../db.js";
import { dayWindow, hitRateLimit, hourWindow } from "../security/ratelimit.js";
import { deliverRow } from "../delivery.js";
import { createTestReport } from "../orchestrate.js";
import { checkProject } from "../project-check.js";
import { checkRepoAccess } from "../providers/github.js";
import { retentionNotice } from "../storage/retention.js";
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

  // ── Delivery retry (#110): failed and unknown rows, issue or GitHub Project ──
  // An unknown row is reconciled by its marker first; if nothing is found the
  // operator must confirm with {"createAnyway": true}. Uses the destination
  // stored on the row, not today's config.
  app.post("/api/admin/feedback/:id/retry", async (c) => {
    const denied = await adminGate(c);
    if (denied) return denied;
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as { createAnyway?: unknown };
    const r = await deliverRow(c.env, id, { retry: true, createAnyway: body?.createAnyway === true });
    // Audit: identifiers and result only, never report content.
    console.log("feedbackkit admin retry", { feedbackId: id, result: r.status });
    const fail = (status: 404 | 409 | 502, code: string, error: string, extra: Record<string, unknown> = {}) =>
      c.json({ v: WIRE_VERSION, status: "error", code, error, feedbackId: id, ...extra }, status);
    switch (r.status) {
      case "delivered":
        return c.json({ v: WIRE_VERSION, feedbackId: id, ...r });
      case "missing":
        return fail(404, "FK_NOT_FOUND", "no such report");
      case "not_retryable":
        return fail(409, "FK_NOT_RETRYABLE", r.reason);
      case "busy":
        c.header("Retry-After", String(Math.max(1, Math.ceil((r.claimUntil - Date.now()) / 1000))));
        return fail(409, "FK_RETRY_IN_PROGRESS", "another delivery of this report is running", { claimUntil: r.claimUntil });
      case "unknown_needs_decision":
        return fail(409, "FK_DELIVERY_UNKNOWN", "an earlier attempt may have created the draft, and none with this report's marker was found; check the project, then retry with createAnyway", {
          needsCreateAnyway: true,
        });
      case "unknown":
        return fail(502, "FK_DELIVERY_UNKNOWN", `GitHub may or may not have created it (${r.reason}); retry to reconcile`);
      case "failed":
        return fail(502, "FK_DELIVERY_FAILED", r.reason, { githubStatus: r.httpStatus });
    }
  });

  // ── Test report (#110): one real delivery, LLM off, is_test = 1 ─────────────
  app.post("/api/admin/projects/:id/test-report", async (c) => {
    const denied = await adminGate(c);
    if (denied) return denied;
    const projectId = c.req.param("id");
    const rl = await hitRateLimit(c.env, `testrep:${projectId}`, hourWindow(), 10);
    if (!rl.allowed) return c.json({ v: WIRE_VERSION, status: "error", error: "rate limited" }, 429);
    const row = await c.env.DB.prepare("SELECT config, config_version FROM projects WHERE id = ?1").bind(projectId).first<{ config: string; config_version: number }>();
    if (!row) return err(c, 404, "unknown project");
    let raw: unknown;
    try {
      raw = JSON.parse(row.config);
    } catch {
      return err(c, 400, "stored config is not valid JSON");
    }
    const parsed = FeedbackConfig.safeParse(raw);
    if (!parsed.success) return err(c, 400, "stored config does not validate");
    const config = parsed.data;
    const body = (await c.req.json().catch(() => ({}))) as { type?: unknown };
    // Default: the first type delivered to a Project, else the first type.
    const template =
      typeof body?.type === "string"
        ? config.templates.find((t) => t.type === body.type)
        : (config.templates.find((t) => resolveDelivery(config, t) === "project") ?? config.templates[0]);
    if (!template) return err(c, 400, "unknown type");
    const result = await createTestReport(c.env, { config, version: Number(row.config_version) }, template, { origin: new URL(c.req.url).origin });
    const id = "id" in result.body ? result.body.id : null;
    const stored = id
      ? await c.env.DB.prepare("SELECT delivery, delivery_state, issue_url, project_url, project_item_id, delivery_warnings, last_error FROM feedback WHERE id = ?1")
          .bind(id)
          .first<Record<string, string | null>>()
      : null;
    return c.json(
      {
        v: WIRE_VERSION,
        status: result.http === 200 ? "sent" : "error",
        feedbackId: id,
        type: template.type,
        delivery: stored?.["delivery"] ?? resolveDelivery(config, template),
        deliveryState: stored?.["delivery_state"] ?? null,
        issueUrl: stored?.["issue_url"] ?? null,
        projectUrl: stored?.["project_url"] ?? null,
        itemId: stored?.["project_item_id"] ? Number(stored["project_item_id"]) : null,
        warnings: stored?.["delivery_warnings"] ? (JSON.parse(stored["delivery_warnings"]) as string[]) : [],
        lastError: stored?.["last_error"] ?? null,
      },
      result.http === 200 ? 200 : 503,
    );
  });

  // ── Screenshots of private deliveries (#110): signed-in operators only ──────
  // Drafts in a GitHub Project and local reports link here instead of the public
  // R2 URL, so a forwarded link does not open for anyone without a sign-in.
  app.get("/admin/assets/*", async (c) => {
    const denied = await adminGate(c);
    if (denied) return denied;
    const key = decodeURIComponent(new URL(c.req.url).pathname.slice("/admin/assets/".length));
    const known = await c.env.DB.prepare("SELECT key FROM assets WHERE key = ?1 AND deleted = 0").bind(key).first<{ key: string }>();
    if (!known) return err(c, 404, "no such attachment");
    const obj = await c.env.UPLOADS.get(key);
    if (!obj) return err(c, 404, "no such attachment");
    return new Response(obj.body, {
      headers: {
        "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
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
        // No tracker: every type is stored locally, nothing to check on GitHub.
        const patSecret = cfg.tracker?.patSecret;
        const repo = cfg.tracker?.defaultRepo ?? null;
        const pat = patSecret ? (c.env[patSecret] as string | undefined) : undefined;
        let access: { ok: boolean; status: number; reason: string | null } | null = null;
        let patExpiry: ReturnType<typeof parsePatExpiry> = null;
        if (pat && repo) {
          try {
            const a = await checkRepoAccess(repo, pat);
            access = { ok: a.ok, status: a.status, reason: a.reason ?? null };
            patExpiry = parsePatExpiry(a.patExpiry);
          } catch (e) {
            access = { ok: false, status: 0, reason: `check failed: ${(e as Error).message}` };
          }
        }
        const project = await checkProject(c.env, cfg).catch((e) => {
          console.warn(`[feedbackkit] project check failed for ${p.id}: ${(e as Error).message}`);
          return null;
        });
        const retention = await retentionNotice(c.env, cfg.projectId, cfg.storage.retentionDays).catch((e) => {
          console.warn(`[feedbackkit] retention notice failed for ${p.id}: ${(e as Error).message}`);
          return null;
        });
        return {
          id: p.id,
          configVersion: Number(p.config_version),
          configValid: true as const,
          retention,
          project,
          enabled: cfg.enabled,
          llm: {
            provider: cfg.llm.provider,
            model: cfg.llm.model || null,
            usedToday: usedToday.get(`llm:${cfg.projectId}`) ?? 0,
            dailyBudget: cfg.llm.dailyBudget,
          },
          tracker: patSecret
            ? {
                repo,
                patSecret,
                patPresent: Boolean(pat),
                access,
                patExpiry,
              }
            : null,
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
