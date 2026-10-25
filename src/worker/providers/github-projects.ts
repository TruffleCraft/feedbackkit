// GitHub Projects (v2) delivery (#110): REST endpoints for organisation-owned
// projects, usable with a fine-grained PAT that has the organisation permission
// "Projects: read and write".
// https://docs.github.com/en/rest/projects/drafts
// https://docs.github.com/en/rest/projects/items
// https://docs.github.com/en/rest/projects/fields
import { TrackerError, type FetchFn } from "./github.js";

const API = "https://api.github.com";
const UA = "FeedbackKit/0.0";
const API_VERSION = "2026-03-10"; // the version the Projects REST docs name
const TIMEOUT_MS = 15_000;

export interface ProjectRef {
  org: string;
  number: number;
}

interface CallInput {
  pat: string;
  fetchImpl?: FetchFn;
}

/** Thrown when GitHub may or may not have acted (timeout, lost response, 5xx). */
export class UncertainError extends Error {
  override name = "UncertainError";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call(input: CallInput, method: string, path: string, body?: unknown): Promise<Response> {
  const f = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await f(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${input.pat}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": UA,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
  } catch (e) {
    throw new UncertainError(`GitHub request failed: ${(e as Error).message}`, 0);
  } finally {
    clearTimeout(timer);
  }
}

const projectPath = (p: ProjectRef) => `/orgs/${encodeURIComponent(p.org)}/projectsV2/${p.number}`;

/** Human link to the project board. */
export function projectHtmlUrl(p: ProjectRef): string {
  return `https://github.com/orgs/${encodeURIComponent(p.org)}/projects/${p.number}`;
}

export interface CreatedDraft {
  itemId: number;
}

/** POST …/drafts. 201 = the draft exists. A definite refusal (4xx) throws
 * TrackerError; anything where GitHub may have created it throws UncertainError. */
export async function createDraft(input: CallInput & { project: ProjectRef; title: string; body: string }): Promise<CreatedDraft> {
  const res = await call(input, "POST", `${projectPath(input.project)}/drafts`, { title: input.title, body: input.body });
  if (res.status === 201) {
    const json = (await res.json().catch(() => null)) as { id?: unknown } | null;
    const itemId = Number(json?.id);
    // Created, but the id is unreadable: the draft exists, so this is not a failure.
    if (!Number.isFinite(itemId)) throw new UncertainError("draft created, response unreadable", 201);
    return { itemId };
  }
  if (res.status >= 500 || res.status === 0) throw new UncertainError(`GitHub answered ${res.status}`, res.status);
  throw new TrackerError(`GitHub answered ${res.status}`, res.status);
}

export interface ProjectField {
  id: number;
  name: string;
  dataType: string;
  options: Array<{ id: string; name: string }>;
}

/** GET …/fields (first 100: the 50-field limit of a project fits). */
export async function listFields(input: CallInput & { project: ProjectRef }): Promise<ProjectField[]> {
  const res = await call(input, "GET", `${projectPath(input.project)}/fields?per_page=100`);
  if (!res.ok) throw new TrackerError(`GitHub answered ${res.status}`, res.status);
  const json = (await res.json()) as Array<{ id: number; name: string; data_type: string; options?: Array<{ id: string; name: { raw?: string } | string }> }>;
  return json.map((f) => ({
    id: f.id,
    name: f.name,
    dataType: f.data_type,
    options: (f.options ?? []).map((o) => ({ id: o.id, name: typeof o.name === "string" ? o.name : (o.name.raw ?? "") })),
  }));
}

/** PATCH …/items/:id with field values (text as is, single select by option id). */
export async function updateItemFields(input: CallInput & { project: ProjectRef; itemId: number; fields: Array<{ id: number; value: string }> }): Promise<void> {
  const res = await call(input, "PATCH", `${projectPath(input.project)}/items/${input.itemId}`, { fields: input.fields });
  if (!res.ok) throw new TrackerError(`GitHub answered ${res.status}`, res.status);
}

const MAX_PAGES = 5;

/** Look for a draft whose body carries the marker, newest pages first as GitHub
 * lists them, at most 5 pages of 100. null = not found within that window. */
export async function findDraftByMarker(input: CallInput & { project: ProjectRef; marker: string }): Promise<number | null> {
  let path = `${projectPath(input.project)}/items?per_page=100`;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await call(input, "GET", path);
    if (!res.ok) throw new TrackerError(`GitHub answered ${res.status}`, res.status);
    const items = (await res.json()) as Array<{ id: number; content_type?: string; content?: { body?: string | null } | null }>;
    const hit = items.find((i) => i.content_type === "DraftIssue" && typeof i.content?.body === "string" && i.content.body.includes(input.marker));
    if (hit) return hit.id;
    const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1];
    if (!next) return null;
    path = next.replace(API, "");
  }
  return null;
}
