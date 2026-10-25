import { createIssue, TrackerError, type FetchFn } from "./providers/github.js";
import { createDraft, findDraftByMarker, listFields, projectHtmlUrl, updateItemFields, UncertainError, type ProjectRef } from "./providers/github-projects.js";
import type { IssueDraft } from "./orchestrate.js";
import type { Env } from "./env.js";

// Delivery state machine (#110). A row is stored first (state pending), then:
//   claim   UPDATE … SET claim_token WHERE the claim is free (one runner per row)
//   call    GitHub, with the row id as a marker in the body
//   finish  UPDATE … WHERE claim_token = ours: delivered | failed | unknown
// failed = GitHub definitely refused (4xx), unknown = it may have acted (timeout,
// lost response, 5xx). An unknown row is reconciled by its marker before anything
// is created again; only the operator can say "create anyway".

const DAY_MS = 86_400_000;
export const CLAIM_MS = 2 * 60_000;
/** A delivered report's screenshots stay reachable at least this long. */
const LATE_DELIVERY_ASSET_MS = 7 * DAY_MS;

/** Where a project draft goes, pinned on the row when it was processed. */
export interface ProjectDestination extends ProjectRef {
  patSecret: string;
  typeOption: string;
  fieldNames: { type: string; page: string; source: string };
}

export type DeliveryResult =
  | { status: "delivered"; issueUrl?: string; itemId?: number; projectUrl?: string; warnings: string[]; reconciled?: boolean }
  | { status: "failed"; reason: string; httpStatus: number }
  | { status: "unknown"; reason: string }
  | { status: "unknown_needs_decision" } // reconciliation found nothing; creating again needs the operator
  | { status: "busy"; claimUntil: number }
  | { status: "not_retryable"; reason: string }
  | { status: "missing" };

interface Row {
  id: string;
  project_id: string;
  client_feedback_id: string | null;
  delivery: string | null;
  delivery_state: string | null;
  outcome: string;
  issue_draft: string | null;
  payload: string;
  issue_url: string | null;
  project_item_id: string | null;
  project_url: string | null;
  delivery_warnings: string | null;
  claim_until: number | null;
  attempt_id: string | null;
}

export interface DeliverOpts {
  now?: number;
  fetchImpl?: FetchFn;
  /** Operator decision after FK_DELIVERY_UNKNOWN: create even though no marker was found. */
  createAnyway?: boolean;
  /** Counts as an admin retry (retry_count + 1). */
  retry?: boolean;
  newToken?: () => string;
}

export const deliveryMarker = (rowId: string) => `<!-- feedbackkit:${rowId} -->`;

export async function deliverRow(env: Env, rowId: string, opts: DeliverOpts = {}): Promise<DeliveryResult> {
  const now = opts.now ?? Date.now();
  const row = await readRow(env, rowId);
  if (!row) return { status: "missing" };
  if (row.delivery_state === "delivered") return delivered(row);
  if (row.delivery !== "project" && row.delivery !== "issue" && !(row.delivery === null && row.outcome === "issue_failed")) {
    return { status: "not_retryable", reason: "this report is stored locally and has no delivery" };
  }
  const draft = parseDraft(row.issue_draft);
  if (!draft) return { status: "not_retryable", reason: "no stored draft (report from before admin retry existed)" };

  const token = (opts.newToken ?? (() => crypto.randomUUID()))();
  const claimed = await env.DB.prepare(
    `UPDATE feedback SET claim_token = ?1, claim_until = ?2, attempt_id = ?1, updated_at = ?3
     WHERE id = ?4 AND (claim_until IS NULL OR claim_until < ?3) AND COALESCE(delivery_state, '') <> 'delivered'`,
  )
    .bind(token, now + CLAIM_MS, now, rowId)
    .run();
  if (!claimed.meta?.changes) {
    const again = await readRow(env, rowId);
    if (again?.delivery_state === "delivered") return delivered(again);
    return { status: "busy", claimUntil: Number(again?.claim_until ?? now + CLAIM_MS) };
  }

  const finish = async (fields: Record<string, unknown>) => {
    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => `${k} = ?${i + 1}`).join(", ");
    const n = keys.length;
    await env.DB.prepare(
      `UPDATE feedback SET ${sets}, claim_token = NULL, claim_until = NULL, updated_at = ?${n + 1}${opts.retry ? ", retry_count = retry_count + 1" : ""}
       WHERE id = ?${n + 2} AND claim_token = ?${n + 3}`,
    )
      .bind(...keys.map((k) => fields[k]), now, rowId, token)
      .run();
  };
  const release = () => env.DB.prepare("UPDATE feedback SET claim_token = NULL, claim_until = NULL WHERE id = ?1 AND claim_token = ?2").bind(rowId, token).run();

  try {
    if (draft.project) return await deliverProject(env, row, draft, draft.project, { ...opts, now }, finish, release);
    return await deliverIssue(env, row, draft, { ...opts, now }, finish);
  } catch (e) {
    // Our own D1 write failed after the claim: the claim expires on its own.
    console.error(`[feedbackkit] delivery bookkeeping failed for ${rowId}: ${(e as Error).message}`);
    return { status: "unknown", reason: "delivery bookkeeping failed" };
  }
}

type Finish = (fields: Record<string, unknown>) => Promise<void>;

async function deliverProject(
  env: Env,
  row: Row,
  draft: IssueDraft,
  dest: ProjectDestination,
  opts: DeliverOpts & { now: number },
  finish: Finish,
  release: () => Promise<unknown>,
): Promise<DeliveryResult> {
  const pat = env[dest.patSecret] as string | undefined;
  const projectUrl = projectHtmlUrl(dest);
  const doneOutcome = draft.outcome ?? "created";
  if (!pat) {
    const reason = "project credential not configured";
    await finish({ delivery_state: "failed", last_error: reason, outcome: "issue_failed" });
    return { status: "failed", reason, httpStatus: 0 };
  }
  const marker = deliveryMarker(row.id);

  // An earlier attempt may have created the draft (an unknown outcome, or a
  // runner that stopped mid-call and left pending behind): find it first.
  if (row.delivery_state === "unknown" || (row.delivery_state === "pending" && row.attempt_id)) {
    let found: number | null;
    try {
      found = await findDraftByMarker({ pat, project: dest, marker, fetchImpl: opts.fetchImpl });
    } catch (e) {
      await release();
      return { status: "unknown", reason: `reconciliation failed: ${(e as Error).message}` };
    }
    if (found !== null) {
      await finish({ delivery_state: "delivered", project_item_id: String(found), project_url: projectUrl, outcome: doneOutcome, last_error: null });
      await extendAssets(env, row, opts.now);
      return { status: "delivered", itemId: found, projectUrl, warnings: [], reconciled: true };
    }
    if (!opts.createAnyway) {
      await release();
      return { status: "unknown_needs_decision" };
    }
  }

  let itemId: number;
  try {
    ({ itemId } = await createDraft({ pat, project: dest, title: draft.title, body: `${draft.body}\n\n${marker}`, fetchImpl: opts.fetchImpl }));
  } catch (e) {
    const reason = e instanceof Error ? e.message : "GitHub request failed";
    if (e instanceof TrackerError) {
      await finish({ delivery_state: "failed", last_error: `project ${reason}`, outcome: "issue_failed" });
      return { status: "failed", reason, httpStatus: e.status };
    }
    await finish({ delivery_state: "unknown", last_error: `project ${reason}`, outcome: "issue_failed" });
    return { status: "unknown", reason };
  }
  // 201: the draft exists. Everything after this only adds warnings.
  await finish({ delivery_state: "delivered", project_item_id: String(itemId), project_url: projectUrl, outcome: doneOutcome, last_error: null });
  await extendAssets(env, row, opts.now);
  const warnings = await setProjectFields(pat, dest, itemId, pageOf(row), opts.fetchImpl);
  if (warnings.length) {
    await env.DB.prepare("UPDATE feedback SET delivery_warnings = ?1 WHERE id = ?2").bind(JSON.stringify(warnings), row.id).run();
    console.warn("feedbackkit project fields skipped", { projectId: row.project_id, warnings });
  }
  return { status: "delivered", itemId, projectUrl, warnings };
}

async function deliverIssue(env: Env, row: Row, draft: IssueDraft, opts: DeliverOpts & { now: number }, finish: Finish): Promise<DeliveryResult> {
  const patSecret = draft.patSecret ?? (await projectPatSecret(env, row.project_id));
  const pat = patSecret ? (env[patSecret] as string | undefined) : undefined;
  if (!pat || !draft.repo) {
    const reason = "tracker credential not configured";
    await finish({ delivery_state: "failed", last_error: reason });
    return { status: "failed", reason, httpStatus: 0 };
  }
  try {
    const issue = await createIssue({ pat, repo: draft.repo, title: draft.title, body: draft.body, labels: draft.labels, type: draft.type, issueFields: draft.issueFields, fetchImpl: opts.fetchImpl });
    await finish({ delivery_state: "delivered", issue_url: issue.url, outcome: draft.outcome ?? "created", last_error: null });
    await extendAssets(env, row, opts.now);
    return { status: "delivered", issueUrl: issue.url, warnings: [] };
  } catch (e) {
    const status = e instanceof TrackerError ? e.status : 0;
    const reason = status ? `tracker error ${status}` : "tracker request failed";
    await finish({ delivery_state: "failed", last_error: reason });
    return { status: "failed", reason, httpStatus: status };
  }
}

/** Type (single select), Page (text) and Source (single select "FeedbackKit").
 * A missing field or option is skipped and reported, never a failed delivery. */
async function setProjectFields(pat: string, dest: ProjectDestination, itemId: number, page: string, fetchImpl?: FetchFn): Promise<string[]> {
  const warnings: string[] = [];
  let fields;
  try {
    fields = await listFields({ pat, project: dest, fetchImpl });
  } catch (e) {
    return [`project fields not readable: ${(e as Error).message}`];
  }
  const byName = (name: string) => fields.find((f) => f.name.toLowerCase() === name.toLowerCase());
  const option = (fieldName: string, optionName: string) => {
    const f = byName(fieldName);
    if (!f) return warnings.push(`field "${fieldName}" not found`), null;
    const o = f.options.find((x) => x.name.toLowerCase() === optionName.toLowerCase());
    if (!o) return warnings.push(`option "${optionName}" not found in field "${fieldName}"`), null;
    return { id: f.id, value: o.id };
  };
  const updates: Array<{ id: number; value: string }> = [];
  const type = option(dest.fieldNames.type, dest.typeOption);
  if (type) updates.push(type);
  const pageField = byName(dest.fieldNames.page);
  if (!pageField) warnings.push(`field "${dest.fieldNames.page}" not found`);
  else if (page) updates.push({ id: pageField.id, value: page });
  const source = option(dest.fieldNames.source, "FeedbackKit");
  if (source) updates.push(source);
  if (updates.length) {
    try {
      await updateItemFields({ pat, project: dest, itemId, fields: updates, fetchImpl });
    } catch (e) {
      warnings.push(`field update failed: ${(e as Error).message}`);
    }
  }
  return warnings;
}

/** Decision 3 of the plan: screenshots of a late delivery stay reachable for at
 * least 7 days after it (never shortened, never extended for kept-forever assets). */
async function extendAssets(env: Env, row: Row, now: number): Promise<void> {
  if (!row.client_feedback_id) return;
  await env.DB.prepare(
    "UPDATE assets SET expires_at = MAX(expires_at, ?1) WHERE feedback_id = ?2 AND project_id = ?3 AND deleted = 0 AND expires_at IS NOT NULL",
  )
    .bind(now + LATE_DELIVERY_ASSET_MS, row.client_feedback_id, row.project_id)
    .run();
}

async function readRow(env: Env, id: string): Promise<Row | null> {
  return env.DB.prepare(
    `SELECT id, project_id, client_feedback_id, delivery, delivery_state, outcome, issue_draft, payload, issue_url,
            project_item_id, project_url, delivery_warnings, claim_until, attempt_id FROM feedback WHERE id = ?1`,
  )
    .bind(id)
    .first<Row>();
}

function delivered(row: Row): DeliveryResult {
  let warnings: string[] = [];
  try {
    warnings = row.delivery_warnings ? (JSON.parse(row.delivery_warnings) as string[]) : [];
  } catch {
    /* keep empty */
  }
  return {
    status: "delivered",
    ...(row.issue_url ? { issueUrl: row.issue_url } : {}),
    ...(row.project_item_id ? { itemId: Number(row.project_item_id) } : {}),
    ...(row.project_url ? { projectUrl: row.project_url } : {}),
    warnings,
  };
}

function parseDraft(raw: string | null): IssueDraft | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as IssueDraft;
    return typeof d.title === "string" && typeof d.body === "string" ? d : null;
  } catch {
    return null;
  }
}

function pageOf(row: Row): string {
  try {
    const url = (JSON.parse(row.payload) as { pageUrl?: unknown }).pageUrl;
    return typeof url === "string" ? url : "";
  } catch {
    return "";
  }
}

/** Rows stored before the draft carried its secret: read it from the project. */
async function projectPatSecret(env: Env, projectId: string): Promise<string | undefined> {
  const p = await env.DB.prepare("SELECT config FROM projects WHERE id = ?1").bind(projectId).first<{ config: string }>();
  try {
    return (JSON.parse(p?.config ?? "{}") as { tracker?: { patSecret?: string } }).tracker?.patSecret;
  } catch {
    return undefined;
  }
}
