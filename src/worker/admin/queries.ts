import { EventName, FeedbackConfig } from "../../shared/contract.js";
import { publicUrl } from "../storage/r2.js";
import type { Env } from "../env.js";

// Read queries over D1 shared by the admin API (routes.ts) and the MCP tools
// (mcp/tools.ts). Callers handle auth; these functions only validate their
// input and read. Nothing here returns IP addresses or secret values.

export const DAY_MS = 86_400_000;
const PAGE_DEFAULT = 25;
const PAGE_MAX = 100;
const SEARCH_DEFAULT = 20;
const SEARCH_MAX = 50;
/** Longest search string accepted; longer input is refused, not cut. */
export const SEARCH_QUERY_MAX = 200;
// D1 caps bound parameters per statement at 100; asset lookups go in chunks.
const ASSET_CHUNK = 50;
// Outcomes the gateway writes; zero-filled in counts so a UI can render them all.
export const OUTCOMES = ["created", "accepted_incomplete", "ai-failed", "issue_failed"] as const;

/** A caller mistake (400), a missing row (404) or a broken stored value (500). */
export class QueryError extends Error {
  constructor(
    readonly status: 400 | 404 | 500,
    message: string,
  ) {
    super(message);
  }
}

export interface ProjectRow {
  id: string;
  public_key: string;
  config: string;
  config_version: number;
  updated_at: number;
}

export async function getProject(env: Env, id: string): Promise<ProjectRow | null> {
  return env.DB.prepare("SELECT id, public_key, config, config_version, updated_at FROM projects WHERE id = ?1").bind(id).first<ProjectRow>();
}

async function requireProject(env: Env, id: string): Promise<ProjectRow> {
  const p = await getProject(env, id);
  if (!p) throw new QueryError(404, "unknown project");
  return p;
}

/** The stored blob, validated (defaults applied) — null when it does not parse. */
export function parseConfig(raw: string): FeedbackConfig | null {
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

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
const str = (v: unknown) => (typeof v === "string" ? v : null);

export interface Attachment {
  key: string;
  kind: string;
  url: string | null;
}

/** Live attachments by client feedbackId (assets are indexed by it, not by the row id). */
async function attachmentsFor(env: Env, projectId: string, clientIds: string[], base: string | undefined): Promise<Map<string, Attachment[]>> {
  const out = new Map<string, Attachment[]>();
  const ids = [...new Set(clientIds)];
  for (let i = 0; i < ids.length; i += ASSET_CHUNK) {
    const chunk = ids.slice(i, i + ASSET_CHUNK);
    const res = await env.DB.prepare(
      `SELECT key, feedback_id, kind FROM assets WHERE project_id = ? AND deleted = 0 AND feedback_id IN (${chunk.map(() => "?").join(", ")}) ORDER BY created_at`,
    )
      .bind(projectId, ...chunk)
      .all<{ key: string; feedback_id: string; kind: string }>();
    for (const a of res.results ?? []) {
      const list = out.get(a.feedback_id) ?? [];
      list.push({ key: a.key, kind: a.kind, url: publicUrl(base, a.key) ?? null });
      out.set(a.feedback_id, list);
    }
  }
  return out;
}

// ── Projects ──────────────────────────────────────────────────────────────────

export interface ProjectSummary {
  id: string;
  publicKey: string;
  configVersion: number;
  updatedAt: number;
  feedback7d: { total: number; byOutcome: Record<string, number> };
}

/** Every project with its feedback count of the last 7 days. */
export async function listProjects(env: Env, now = Date.now()): Promise<ProjectSummary[]> {
  const since = now - 7 * DAY_MS;
  const [projects, counts] = await Promise.all([
    env.DB.prepare("SELECT id, public_key, config_version, updated_at FROM projects ORDER BY id").all<Omit<ProjectRow, "config">>(),
    env.DB.prepare("SELECT project_id, outcome, COUNT(*) AS n FROM feedback WHERE created_at >= ?1 GROUP BY project_id, outcome")
      .bind(since)
      .all<{ project_id: string; outcome: string; n: number }>(),
  ]);
  const countRows = counts.results ?? [];
  return (projects.results ?? []).map((p) => {
    const mine = countRows.filter((r) => r.project_id === p.id).map((r) => ({ k: r.outcome, n: r.n }));
    const { total, counts: byOutcome } = countBy(mine, OUTCOMES);
    return {
      id: p.id,
      publicKey: p.public_key,
      configVersion: Number(p.config_version),
      updatedAt: Number(p.updated_at),
      feedback7d: { total, byOutcome },
    };
  });
}

/**
 * The config as stored (no defaults filled in) plus the columns kept outside the
 * blob. Re-importable through POST /api/admin/config/import, which pins
 * publicKey and ignores configVersion.
 */
export async function exportConfig(env: Env, projectId: string): Promise<Record<string, unknown>> {
  const p = await requireProject(env, projectId);
  let stored: unknown;
  try {
    stored = JSON.parse(p.config);
  } catch {
    throw new QueryError(500, "stored config is not valid JSON");
  }
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) throw new QueryError(500, "stored config is not a JSON object");
  return { publicKey: p.public_key, configVersion: Number(p.config_version), ...(stored as Record<string, unknown>) };
}

// ── Feedback ──────────────────────────────────────────────────────────────────

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

export interface FeedbackListItem {
  id: string;
  clientFeedbackId: string | null;
  createdAt: number;
  outcome: string;
  type: string | null;
  title: string | null;
  summary: string | null;
  message: string | null;
  pageUrl: string | null;
  issueUrl: string | null;
  llmModel: string | null;
  attachments: Attachment[];
  retryable: boolean;
}

export interface FeedbackListOptions {
  projectId: string;
  outcome?: string;
  /** Only feedback created at or after this time (ms since epoch). */
  since?: number;
  cursor?: string;
  limit?: number;
}

/** One project's feedback, newest first, keyset-paginated. */
export async function listFeedback(env: Env, opts: FeedbackListOptions): Promise<{ items: FeedbackListItem[]; nextCursor: string | null }> {
  const limit = opts.limit ?? PAGE_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1) throw new QueryError(400, "limit must be a positive integer");
  const pageSize = Math.min(limit, PAGE_MAX);
  const outcome = opts.outcome || undefined;
  if (outcome !== undefined && !/^[a-z_-]{1,32}$/.test(outcome)) throw new QueryError(400, "invalid outcome");
  if (opts.since !== undefined && !Number.isFinite(opts.since)) throw new QueryError(400, "invalid since");
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
  if (opts.cursor && !cursor) throw new QueryError(400, "invalid cursor");

  const p = await requireProject(env, opts.projectId);
  const base = parseConfig(p.config)?.storage.publicBaseUrl;

  const where = ["project_id = ?"];
  const params: unknown[] = [p.id];
  if (outcome) {
    where.push("outcome = ?");
    params.push(outcome);
  }
  if (opts.since !== undefined) {
    where.push("created_at >= ?");
    params.push(Math.floor(opts.since));
  }
  if (cursor) {
    where.push("(created_at, id) < (?, ?)");
    params.push(cursor[0], cursor[1]);
  }
  params.push(pageSize + 1);
  const rows =
    (
      await env.DB.prepare(
        `SELECT id, outcome, payload, issue_url, created_at, type, title, llm_model, issue_draft IS NOT NULL AS has_draft
         FROM feedback WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
        .bind(...params)
        .all<FeedbackListRow>()
    ).results ?? [];
  const page = rows.slice(0, pageSize);
  const payloads = page.map((r) => parsePayload(r.payload));
  const assets = await attachmentsFor(
    env,
    p.id,
    payloads.map((pl) => str(pl["feedbackId"])).filter((x): x is string => !!x),
    base,
  );

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
  return { items, nextCursor };
}

export interface FeedbackDetail {
  id: string;
  projectId: string;
  clientFeedbackId: string | null;
  createdAt: number;
  outcome: string;
  type: string | null;
  title: string | null;
  summary: string | null;
  message: string | null;
  followUpText: string | null;
  extracted: Record<string, string>;
  pageUrl: string | null;
  device: { browser: string | null; os: string | null; viewport: { w: number; h: number } | null; language: string | null } | null;
  issueUrl: string | null;
  llmModel: string | null;
  attachments: Attachment[];
  /** Set by the embedding page (window.FeedbackKitContext). Never verified by the gateway. */
  hostContext: { verified: false; values: Record<string, string | number | boolean> } | null;
}

function pickDevice(v: unknown): FeedbackDetail["device"] {
  if (!v || typeof v !== "object") return null;
  const d = v as Record<string, unknown>;
  const vp = d["viewport"] as Record<string, unknown> | undefined;
  return {
    browser: str(d["browser"]),
    os: str(d["os"]),
    viewport: vp && typeof vp["w"] === "number" && typeof vp["h"] === "number" ? { w: vp["w"], h: vp["h"] } : null,
    language: str(d["language"]),
  };
}

function pickExtracted(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"));
}

function pickContext(v: unknown): FeedbackDetail["hostContext"] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const values = Object.fromEntries(
    Object.entries(v as Record<string, unknown>).filter(
      (e): e is [string, string | number | boolean] => typeof e[1] === "string" || typeof e[1] === "number" || typeof e[1] === "boolean",
    ),
  );
  return Object.keys(values).length ? { verified: false, values } : null;
}

/**
 * One feedback row by its server id. The payload is copied field by field
 * (allowlist): the Turnstile token, the honeypot and anything added to the
 * payload later stay out unless they are named here.
 */
export async function getFeedback(env: Env, id: string): Promise<FeedbackDetail | null> {
  const r = await env.DB.prepare(
    "SELECT id, project_id, outcome, payload, issue_url, created_at, type, title, llm_model FROM feedback WHERE id = ?1",
  )
    .bind(id)
    .first<{ id: string; project_id: string; outcome: string; payload: string; issue_url: string | null; created_at: number; type: string | null; title: string | null; llm_model: string | null }>();
  if (!r) return null;
  const pl = parsePayload(r.payload);
  const clientFeedbackId = str(pl["feedbackId"]);
  let attachments: Attachment[] = [];
  if (clientFeedbackId) {
    const p = await getProject(env, r.project_id);
    const base = p ? parseConfig(p.config)?.storage.publicBaseUrl : undefined;
    attachments = (await attachmentsFor(env, r.project_id, [clientFeedbackId], base)).get(clientFeedbackId) ?? [];
  }
  return {
    id: r.id,
    projectId: r.project_id,
    clientFeedbackId,
    createdAt: Number(r.created_at),
    outcome: r.outcome,
    type: r.type ?? str(pl["type"]),
    title: r.title,
    summary: str(pl["summary"]),
    message: str(pl["message"]),
    followUpText: str(pl["followUpText"]),
    extracted: pickExtracted(pl["extracted"]),
    pageUrl: str(pl["pageUrl"]),
    device: pickDevice(pl["deviceInfo"]),
    issueUrl: r.issue_url,
    llmModel: r.llm_model,
    attachments,
    hostContext: pickContext(pl["context"]),
  };
}

/** Escape LIKE wildcards so user input matches literally (used with ESCAPE '\'). */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export interface SearchHit {
  id: string;
  projectId: string;
  createdAt: number;
  outcome: string;
  type: string | null;
  title: string | null;
  summary: string | null;
  message: string | null;
  issueUrl: string | null;
}

/**
 * Case-insensitive substring search over the message, the summary and the
 * title, newest first. Wildcards in the query match literally.
 */
export async function searchFeedback(env: Env, opts: { projectId?: string; query: string; limit?: number }): Promise<SearchHit[]> {
  const q = opts.query.trim();
  if (!q) throw new QueryError(400, "query must not be empty");
  if (q.length > SEARCH_QUERY_MAX) throw new QueryError(400, `query must be at most ${SEARCH_QUERY_MAX} characters`);
  const limit = opts.limit ?? SEARCH_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1) throw new QueryError(400, "limit must be a positive integer");
  if (opts.projectId !== undefined) await requireProject(env, opts.projectId);

  const pattern = `%${escapeLike(q)}%`;
  const where = [
    `(json_extract(payload, '$.message') LIKE ?1 ESCAPE '\\' OR json_extract(payload, '$.summary') LIKE ?1 ESCAPE '\\' OR title LIKE ?1 ESCAPE '\\')`,
  ];
  const params: unknown[] = [pattern];
  if (opts.projectId !== undefined) {
    where.push("project_id = ?2");
    params.push(opts.projectId);
  }
  params.push(Math.min(limit, SEARCH_MAX));
  const rows =
    (
      await env.DB.prepare(
        `SELECT id, project_id, outcome, payload, issue_url, created_at, type, title FROM feedback
         WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?${params.length}`,
      )
        .bind(...params)
        .all<{ id: string; project_id: string; outcome: string; payload: string; issue_url: string | null; created_at: number; type: string | null; title: string | null }>()
    ).results ?? [];
  return rows.map((r) => {
    const pl = parsePayload(r.payload);
    return {
      id: r.id,
      projectId: r.project_id,
      createdAt: Number(r.created_at),
      outcome: r.outcome,
      type: r.type ?? str(pl["type"]),
      title: r.title,
      summary: str(pl["summary"]),
      message: str(pl["message"]),
      issueUrl: r.issue_url,
    };
  });
}

// ── Funnel ────────────────────────────────────────────────────────────────────

export interface Funnel {
  projectId: string;
  days: number;
  since: number;
  events: Record<string, number>;
  feedback: { total: number; byOutcome: Record<string, number> };
}

/** Widget events by name and feedback outcomes over the last `days` days (1 to 90). */
export async function getFunnel(env: Env, projectId: string, days = 30, now = Date.now()): Promise<Funnel> {
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new QueryError(400, "days must be an integer from 1 to 90");
  const p = await requireProject(env, projectId);
  const since = now - days * DAY_MS;
  const [ev, fb] = await Promise.all([
    env.DB.prepare("SELECT name AS k, COUNT(*) AS n FROM events WHERE project_id = ?1 AND ts >= ?2 GROUP BY name")
      .bind(p.id, since)
      .all<{ k: string; n: number }>(),
    env.DB.prepare("SELECT outcome AS k, COUNT(*) AS n FROM feedback WHERE project_id = ?1 AND created_at >= ?2 GROUP BY outcome")
      .bind(p.id, since)
      .all<{ k: string; n: number }>(),
  ]);
  const events = countBy(ev.results ?? [], EventName.options);
  const feedback = countBy(fb.results ?? [], OUTCOMES);
  return { projectId: p.id, days, since, events: events.counts, feedback: { total: feedback.total, byOutcome: feedback.counts } };
}
