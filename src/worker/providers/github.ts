// GitHub issue-tracker provider (P1.7). REST only in v1; Projects v2 board fields
// are P3. Fetch is injectable for tests. Fine-grained PATs are scoped to ONE owner
// (documented in QUICKSTART) — a project references its PAT secret by name.

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

const API = "https://api.github.com";
const UA = "FeedbackKit/0.0";
const TIMEOUT_MS = 15_000;

/** Fetch with an abort-based timeout so a hung connection can't tie up the request. */
async function fetchWithTimeout(f: FetchFn, url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await f(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface CreateIssueInput {
  pat: string;
  repo: string; // "owner/name"
  title: string;
  body: string;
  labels?: string[];
  fetchImpl?: FetchFn;
}

export interface CreatedIssue {
  url: string;
  number: number;
}

export class TrackerError extends Error {
  override name = "TrackerError";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function createIssue(input: CreateIssueInput): Promise<CreatedIssue> {
  const f = input.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchWithTimeout(f, `${API}/repos/${input.repo}/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.pat}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": UA,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: input.title, body: input.body, labels: input.labels ?? [] }),
    });
  } catch (e) {
    // Network failure / timeout — a thrown TrackerError lets the caller run
    // create-anyway (persist + issue_failed) instead of a bare 500.
    throw new TrackerError(`GitHub request failed: ${(e as Error).message}`, 0);
  }
  if (!res.ok) {
    // Message stays generic to the client; the caller logs status + repo server-side.
    throw new TrackerError(`GitHub issue create failed (${res.status})`, res.status);
  }
  const json = (await res.json()) as { html_url?: string; number?: number };
  if (!json.html_url || typeof json.number !== "number") {
    throw new TrackerError("GitHub returned an unexpected issue payload", 502);
  }
  return { url: json.html_url, number: json.number };
}

export interface RepoAccess {
  ok: boolean;
  status: number;
  /** Present when GitHub signals the token is expiring/expired. */
  patExpiry?: string;
  reason?: string;
}

/** For /diag + project creation: does this PAT reach the target repo? */
export async function checkRepoAccess(repo: string, pat: string, fetchImpl?: FetchFn): Promise<RepoAccess> {
  const f = fetchImpl ?? fetch;
  try {
    const res = await fetchWithTimeout(f, `${API}/repos/${repo}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": UA,
      },
    });
    const patExpiry = res.headers.get("github-authentication-token-expiration") ?? undefined;
    if (res.ok) return { ok: true, status: 200, patExpiry };
    const reason =
      res.status === 401
        ? "PAT invalid or expired"
        : res.status === 404
          ? `repo ${repo} not found, or the PAT's owner can't see it (fine-grained PATs are scoped to one owner)`
          : `GitHub responded ${res.status}`;
    return { ok: false, status: res.status, patExpiry, reason };
  } catch (e) {
    return { ok: false, status: 0, reason: `network error: ${(e as Error).message}` };
  }
}
