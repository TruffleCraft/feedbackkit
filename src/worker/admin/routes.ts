import type { Context, Hono } from "hono";
import { WIRE_VERSION, SCHEMA_VERSION, EventName, FeedbackConfig } from "../../shared/contract.js";
import { checkSchema } from "../db.js";
import { publicUrl } from "../storage/r2.js";
import { dayWindow } from "../security/ratelimit.js";
import { checkRepoAccess } from "../providers/github.js";
import { releaseOf, bindingsPresence, secretsPresence } from "../status.js";
import { adminCheck, adminGate } from "./auth.js";
import type { Env } from "../env.js";

// Read-only admin API (P2, step 1). Every route runs through adminGate (a
// Cloudflare Access sign-in or the bearer ADMIN_TOKEN, failed token attempts
// rate-limited per hashed IP). Responses carry
// feedback content and config, but never IP addresses, secret values, device
// info or host context.

type AppT = Hono<{ Bindings: Env }>;
type Ctx = Context<{ Bindings: Env }>;

const DAY_MS = 86_400_000;
const PAGE_DEFAULT = 25;
const PAGE_MAX = 100;
// D1 caps bound parameters per statement at 100; asset lookups go in chunks.
const ASSET_CHUNK = 50;
// Outcomes the gateway writes; zero-filled in counts so a UI can render them all.
const OUTCOMES = ["created", "accepted_incomplete", "ai-failed", "issue_failed"] as const;

const err = (c: Ctx, status: 400 | 404 | 500, error: string) => c.json({ v: WIRE_VERSION, status: "error", error }, status);

interface ProjectRow {
  id: string;
  public_key: string;
  config: string;
  config_version: number;
  updated_at: number;
}

async function getProject(env: Env, id: string): Promise<ProjectRow | null> {
  return env.DB.prepare("SELECT id, public_key, config, config_version, updated_at FROM projects WHERE id = ?1").bind(id).first<ProjectRow>();
}

/** The stored blob, validated (defaults applied) — null when it does not parse. */
function parseConfig(raw: string): FeedbackConfig | null {
  try {
    const r = FeedbackConfig.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

function countBy(rows: Array<{ k: string; n: number }>, keys: readonly string[]): { total: number; counts: Record<string, number> } {
  const counts: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
  let total = 0;
  for (const r of rows) {
    counts[r.k] = (counts[r.k] ?? 0) + Number(r.n);
    total += Number(r.n);
  }
  return { total, counts };
}

// Keyset cursor over (created_at, id), opaque to clients.
function encodeCursor(createdAt: number, id: string): string {
  return btoa(JSON.stringify([createdAt, id])).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decodeCursor(raw: string): [number, string] | null {
  try {
    const v = JSON.parse(atob(raw.replace(/-/g, "+").replace(/_/g, "/"))) as unknown;
    if (Array.isArray(v) && v.length === 2 && Number.isInteger(v[0]) && typeof v[1] === "string") return [v[0] as number, v[1] as string];
  } catch {
    /* fall through */
  }
  return null;
}

/** GitHub's token expiry header ("2026-11-01 00:00:00 UTC") as a structured field. */
export function parsePatExpiry(raw: string | undefined, now = Date.now()): { raw: string; at: string | null; daysLeft: number | null } | null {
  if (!raw) return null;
  const iso = raw.trim().replace(" ", "T").replace(/ UTC$/, "Z").replace(/ ([+-]\d{2})(\d{2})$/, "$1:$2");
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return { raw, at: null, daysLeft: null };
  return { raw, at: new Date(t).toISOString(), daysLeft: Math.floor((t - now) / DAY_MS) };
}

interface FeedbackListRow {
  id: string;
  outcome: string;
  payload: string;
  issue_url: string | null;
  created_at: number;
  type: string | null;
  title: string | null;
  llm_model: string | null;
  has_draft: number;
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
    const since = Date.now() - 7 * DAY_MS;
    const [projects, counts] = await Promise.all([
      c.env.DB.prepare("SELECT id, public_key, config_version, updated_at FROM projects ORDER BY id").all<Omit<ProjectRow, "config">>(),
      c.env.DB.prepare("SELECT project_id, outcome, COUNT(*) AS n FROM feedback WHERE created_at >= ?1 GROUP BY project_id, outcome")
        .bind(since)
        .all<{ project_id: string; outcome: string; n: number }>(),
    ]);
    const countRows = counts.results ?? [];
    return c.json({
      v: WIRE_VERSION,
      projects: (projects.results ?? []).map((p) => {
        const mine = countRows.filter((r) => r.project_id === p.id).map((r) => ({ k: r.outcome, n: r.n }));
        const { total, counts: byOutcome } = countBy(mine, OUTCOMES);
        return {
          id: p.id,
          publicKey: p.public_key,
          configVersion: Number(p.config_version),
          updatedAt: Number(p.updated_at),
          feedback7d: { total, byOutcome },
        };
      }),
    });
  });

  // ── Config export (re-importable through POST /api/admin/config/import) ─────
  app.get("/api/admin/projects/:id/config", async (c) => {
    const denied = await adminGate(c);
    if (denied) return denied;
    const p = await getProject(c.env, c.req.param("id"));
    if (!p) return err(c, 404, "unknown project");
    let stored: unknown;
    try {
      stored = JSON.parse(p.config);
    } catch {
      return err(c, 500, "stored config is not valid JSON");
    }
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return err(c, 500, "stored config is not a JSON object");
    // The raw blob as stored (no defaults filled in), plus the columns kept
    // outside it. The import pins publicKey and ignores configVersion.
    return c.json({ publicKey: p.public_key, configVersion: Number(p.config_version), ...(stored as Record<string, unknown>) });
  });

  // ── Feedback history, newest first, keyset-paginated ────────────────────────
  app.get("/api/admin/projects/:id/feedback", async (c) => {
    const denied = await adminGate(c);
    if (denied) return denied;

    const limitRaw = c.req.query("limit");
    const limit = limitRaw === undefined ? PAGE_DEFAULT : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1) return err(c, 400, "limit must be a positive integer");
    const pageSize = Math.min(limit, PAGE_MAX);
    const outcome = c.req.query("outcome") || undefined;
    if (outcome !== undefined && !/^[a-z_-]{1,32}$/.test(outcome)) return err(c, 400, "invalid outcome");
    const cursorRaw = c.req.query("cursor") || undefined;
    const cursor = cursorRaw === undefined ? null : decodeCursor(cursorRaw);
    if (cursorRaw !== undefined && !cursor) return err(c, 400, "invalid cursor");

    const p = await getProject(c.env, c.req.param("id"));
    if (!p) return err(c, 404, "unknown project");
    const base = parseConfig(p.config)?.storage.publicBaseUrl;

    const where = ["project_id = ?"];
    const params: unknown[] = [p.id];
    if (outcome) {
      where.push("outcome = ?");
      params.push(outcome);
    }
    if (cursor) {
      where.push("(created_at, id) < (?, ?)");
      params.push(cursor[0], cursor[1]);
    }
    params.push(pageSize + 1);
    const rows =
      (
        await c.env.DB.prepare(
          `SELECT id, outcome, payload, issue_url, created_at, type, title, llm_model, issue_draft IS NOT NULL AS has_draft
           FROM feedback WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
          .bind(...params)
          .all<FeedbackListRow>()
      ).results ?? [];
    const page = rows.slice(0, pageSize);

    const payloads = page.map((r) => {
      try {
        return JSON.parse(r.payload) as Record<string, unknown>;
      } catch {
        return {} as Record<string, unknown>;
      }
    });
    const str = (v: unknown) => (typeof v === "string" ? v : null);

    // Attachments are indexed by the client feedbackId (not the server row id).
    const clientIds = [...new Set(payloads.map((pl) => str(pl["feedbackId"])).filter((x): x is string => !!x))];
    const assets = new Map<string, Array<{ key: string; kind: string; url: string | null }>>();
    for (let i = 0; i < clientIds.length; i += ASSET_CHUNK) {
      const chunk = clientIds.slice(i, i + ASSET_CHUNK);
      const res = await c.env.DB.prepare(
        `SELECT key, feedback_id, kind FROM assets WHERE project_id = ? AND deleted = 0 AND feedback_id IN (${chunk.map(() => "?").join(", ")}) ORDER BY created_at`,
      )
        .bind(p.id, ...chunk)
        .all<{ key: string; feedback_id: string; kind: string }>();
      for (const a of res.results ?? []) {
        const list = assets.get(a.feedback_id) ?? [];
        list.push({ key: a.key, kind: a.kind, url: publicUrl(base, a.key) ?? null });
        assets.set(a.feedback_id, list);
      }
    }

    const items = page.map((r, i) => {
      const pl = payloads[i]!;
      const clientFeedbackId = str(pl["feedbackId"]);
      return {
        id: r.id,
        clientFeedbackId,
        createdAt: Number(r.created_at),
        outcome: r.outcome,
        type: r.type ?? str(pl["type"]),
        title: r.title,
        summary: str(pl["summary"]),
        message: str(pl["message"]),
        pageUrl: str(pl["pageUrl"]),
        issueUrl: r.issue_url,
        llmModel: r.llm_model,
        attachments: (clientFeedbackId && assets.get(clientFeedbackId)) || [],
        retryable: r.outcome === "issue_failed" && Boolean(r.has_draft),
      };
    });
    const last = page[page.length - 1];
    const nextCursor = rows.length > pageSize && last ? encodeCursor(Number(last.created_at), last.id) : null;
    return c.json({ v: WIRE_VERSION, items, nextCursor });
  });

  // ── Funnel: widget events by name + feedback outcomes in the window ─────────
  app.get("/api/admin/projects/:id/funnel", async (c) => {
    const denied = await adminGate(c);
    if (denied) return denied;
    const daysRaw = c.req.query("days");
    const days = daysRaw === undefined ? 30 : Number(daysRaw);
    if (!Number.isInteger(days) || days < 1 || days > 90) return err(c, 400, "days must be an integer from 1 to 90");
    const p = await getProject(c.env, c.req.param("id"));
    if (!p) return err(c, 404, "unknown project");
    const since = Date.now() - days * DAY_MS;
    const [ev, fb] = await Promise.all([
      c.env.DB.prepare("SELECT name AS k, COUNT(*) AS n FROM events WHERE project_id = ?1 AND ts >= ?2 GROUP BY name")
        .bind(p.id, since)
        .all<{ k: string; n: number }>(),
      c.env.DB.prepare("SELECT outcome AS k, COUNT(*) AS n FROM feedback WHERE project_id = ?1 AND created_at >= ?2 GROUP BY outcome")
        .bind(p.id, since)
        .all<{ k: string; n: number }>(),
    ]);
    const events = countBy(ev.results ?? [], EventName.options);
    const feedback = countBy(fb.results ?? [], OUTCOMES);
    return c.json({
      v: WIRE_VERSION,
      projectId: p.id,
      days,
      since,
      events: events.counts,
      feedback: { total: feedback.total, byOutcome: feedback.counts },
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
