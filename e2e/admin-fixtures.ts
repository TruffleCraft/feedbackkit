import type { Page, Route } from "@playwright/test";

// Mocked /api/admin/* for the admin specs (and the PR screenshots). All
// projects, people and reports are made up.

export const TOKEN = "test-admin-token";
const DAY = 86_400_000;
const HOUR = 3_600_000;

const R2 = "https://r2.harborline.test";
export const SHOT_URL = `${R2}/fk/harborline/2026/10/shot-1.webp`;

// A small stand-in "screenshot": an app window with a few blocks.
export const SHOT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">
<rect width="320" height="200" fill="#f4f4f5"/><rect width="320" height="34" fill="#1e3a8a"/>
<rect x="16" y="50" width="180" height="14" rx="4" fill="#cbd5e1"/><rect x="16" y="74" width="288" height="70" rx="8" fill="#fff"/>
<circle cx="160" cy="109" r="16" fill="none" stroke="#7c3aed" stroke-width="5" stroke-dasharray="60 40"/>
<rect x="16" y="156" width="120" height="28" rx="14" fill="#7c3aed"/></svg>`;

export interface Item {
  id: string;
  clientFeedbackId: string;
  createdAt: number;
  outcome: string;
  type: string | null;
  title: string | null;
  summary: string | null;
  message: string | null;
  pageUrl: string | null;
  issueUrl: string | null;
  llmModel: string | null;
  attachments: Array<{ key: string; kind: string; url: string | null }>;
  retryable: boolean;
  delivery?: string | null;
  deliveryState?: string | null;
  disposition?: string;
  note?: string | null;
  projectUrl?: string | null;
  warnings?: string[];
  isTest?: boolean;
}

export function feedbackItems(now = Date.now()): Item[] {
  const shot = (n: number) => [{ key: `fk/harborline/2026/10/shot-${n}.webp`, kind: "screenshot", url: n === 1 ? SHOT_URL : `${R2}/fk/harborline/2026/10/shot-${n}.webp` }];
  const base = (n: number, over: Partial<Item>): Item => ({
    id: `srv-${n}`,
    clientFeedbackId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    createdAt: now - n * HOUR,
    outcome: "created",
    type: "bug",
    title: null,
    summary: null,
    message: null,
    pageUrl: "https://harborline.app/bookings",
    issueUrl: null,
    llmModel: "openai/gpt-4o-mini",
    attachments: [],
    retryable: false,
    delivery: "issue",
    deliveryState: over.issueUrl ? "delivered" : "failed",
    disposition: "open",
    note: null,
    projectUrl: null,
    warnings: [],
    isTest: false,
    ...over,
  });
  return [
    base(1, { createdAt: now - 2 * HOUR, outcome: "issue_failed", summary: "Payment spinner never stops after the card check on iPhone", attachments: shot(1), retryable: true }),
    base(2, { createdAt: now - 5 * HOUR, summary: "Calendar skips Sunday when a stay runs into the next month", issueUrl: "https://github.com/harborline/web/issues/214", attachments: shot(1) }),
    base(3, { createdAt: now - 26 * HOUR, type: "idea", summary: "Let harbor staff export the weekly arrivals list as CSV", issueUrl: "https://github.com/harborline/web/issues/213" }),
    base(4, { createdAt: now - 2 * DAY - HOUR, outcome: "accepted_incomplete", type: "improvement", summary: "Berth labels overlap on the harbor map when zoomed out", issueUrl: "https://github.com/harborline/web/issues/211", attachments: shot(1) }),
    base(5, { createdAt: now - 26 * DAY, outcome: "issue_failed", summary: "Confirmation email shows the wrong time zone", llmModel: null }),
    base(6, { createdAt: now - 28 * DAY, outcome: "ai-failed", summary: null, message: 'Search ignores the "pets allowed" filter', issueUrl: "https://github.com/harborline/web/issues/205" }),
    base(7, { createdAt: now - 29 * DAY, type: "praise", summary: "Booking a berth for two boats at once works really well", delivery: "local", deliveryState: null }),
    // second page
    base(8, { createdAt: now - 40 * DAY, summary: "Map tiles load slowly on the marina page", issueUrl: "https://github.com/harborline/web/issues/190" }),
    base(9, { createdAt: now - 45 * DAY, type: "question", summary: null, message: "<img src=x onerror=alert(1)> Can I change a booking after paying?", issueUrl: "https://github.com/harborline/web/issues/188" }),
  ];
}

/** The inbox views: a local report, a delivered Project draft, one from before the delivery model. */
export function inboxItems(now = Date.now()): Item[] {
  const all = feedbackItems(now);
  return [
    { ...all[6]!, id: "loc-1", createdAt: now - HOUR, message: "Love the new berth map ```not a fence``` really", summary: null },
    { ...all[1]!, id: "prj-1", createdAt: now - 2 * HOUR, issueUrl: null, delivery: "project", deliveryState: "delivered", projectUrl: "https://github.com/orgs/harborline/projects/3", warnings: ['field "Page" not found'] },
    { ...all[2]!, id: "old-1", createdAt: now - 3 * HOUR, issueUrl: null, delivery: null, deliveryState: null, type: "question", summary: "Old report from before the delivery model" },
    { ...all[0]!, id: "unk-1", createdAt: now - 4 * HOUR, delivery: "project", deliveryState: "unknown", retryable: true, summary: "Draft that may exist already" },
  ];
}

export const harborConfig = {
  publicKey: "fk_pub_3a91c07e5d22",
  configVersion: 12,
  projectId: "harborline",
  locale: "en",
  askType: false,
  templates: [
    {
      type: "bug",
      label: "Bug",
      fields: [
        { key: "actual", label: "What happened", kind: "longtext", required: true },
        { key: "expected", label: "What you expected", kind: "longtext", required: true },
        { key: "steps", label: "Steps to reproduce", kind: "longtext", required: true },
        { key: "booking_id", label: "Booking number", kind: "text", required: true, askIfMissing: false },
        { key: "device", label: "Device", kind: "text", askIfMissing: false },
      ],
      tracker: { labels: ["bug", "triage"] },
    },
    { type: "idea", label: "Idea", fields: [{ key: "problem", label: "Problem it solves", kind: "longtext", required: true }, { key: "who", label: "Who asks for it", kind: "text" }], tracker: { labels: ["idea"] } },
    { type: "improvement", label: { en: "Improvement", de: "Verbesserung" }, fields: [{ key: "what", label: "What to change", kind: "longtext", required: true }], tracker: { labels: ["enhancement"] } },
    { type: "praise", label: "Praise", noIssue: true },
  ],
  tracker: { kind: "github", defaultRepo: "harborline/web", patSecret: "GITHUB_PAT_HARBOR" },
  auth: { origins: ["https://harborline.app", "https://staging.harborline.app"] },
  storage: { kind: "r2", publicBaseUrl: `${R2}/` },
  llm: { provider: "openrouter", model: "openai/gpt-4o-mini", dailyBudget: 200 },
};

export function projects(now = Date.now()) {
  return [
    { id: "harborline", publicKey: "fk_pub_3a91c07e5d22", configVersion: 12, updatedAt: now - 3 * DAY, feedback7d: { total: 38, byOutcome: { created: 33, accepted_incomplete: 2, "ai-failed": 1, issue_failed: 2 } }, deliveries: ["issue", "local"], links: { repo: "https://github.com/harborline/web" } },
    { id: "ledgerkite-docs", publicKey: "fk_pub_51d8ee0a73b4", configVersion: 1, updatedAt: now - 26 * HOUR, feedback7d: { total: 0, byOutcome: { created: 0, accepted_incomplete: 0, "ai-failed": 0, issue_failed: 0 } } },
    { id: "pantry-planner", publicKey: "fk_pub_b7e204f19c6a", configVersion: 4, updatedAt: now - 35 * DAY, feedback7d: { total: 11, byOutcome: { created: 11, accepted_incomplete: 0, "ai-failed": 0, issue_failed: 0 } } },
  ];
}

export const funnel = {
  v: 1,
  projectId: "harborline",
  days: 30,
  events: { opened: 412, typed: 238, submitted: 171, need_fields: 64, completed: 49, sent_anyway: 11, abandoned: 71 },
  feedback: { total: 171, byOutcome: { created: 158, accepted_incomplete: 9, "ai-failed": 1, issue_failed: 3 } },
};

export function system(now = Date.now()) {
  const expiry = (days: number) => {
    const at = new Date(now + days * DAY + HOUR).toISOString();
    return { raw: at, at, daysLeft: days };
  };
  return {
    v: 1,
    service: "feedbackkit",
    version: "0.2.0",
    channel: "stable",
    wireVersion: 1,
    schema: { expected: 2, ok: true, version: 2 },
    bindings: { DB: true, UPLOADS: true, ASSETS: true },
    secrets: { adminToken: true, githubPat: true, llmKey: true, accessTeamDomain: true, accessAud: true },
    projects: [
      {
        id: "harborline",
        configVersion: 12,
        configValid: true,
        enabled: true,
        llm: { provider: "openrouter", model: "openai/gpt-4o-mini", usedToday: 172, dailyBudget: 200 },
        tracker: { repo: "harborline/web", patSecret: "GITHUB_PAT_HARBOR", patPresent: true, access: { ok: true, status: 200, reason: null }, patExpiry: expiry(12) },
      },
      {
        id: "ledgerkite-docs",
        configVersion: 1,
        configValid: true,
        enabled: true,
        llm: { provider: "off", model: null, usedToday: 0, dailyBudget: 200 },
        tracker: { repo: "ledgerkite/docs", patSecret: "GITHUB_PAT_LEDGER", patPresent: false, access: null, patExpiry: null },
      },
      {
        id: "pantry-planner",
        configVersion: 4,
        configValid: true,
        enabled: true,
        llm: { provider: "openrouter", model: "openai/gpt-4o-mini", usedToday: 31, dailyBudget: 150 },
        tracker: { repo: "pantry/app", patSecret: "GITHUB_PAT_PANTRY", patPresent: true, access: { ok: true, status: 200, reason: null }, patExpiry: expiry(145) },
        retention: {
          retentionDays: 30,
          dueSoon: 2,
          items: [
            { id: "r1", type: "praise", outcome: "created", createdAt: now - 27 * DAY, deletesAt: now + 3 * DAY },
            { id: "r2", type: "bug", outcome: "issue_failed", createdAt: now - 25 * DAY, deletesAt: now + 5 * DAY },
          ],
        },
      },
    ],
  };
}

export interface AdminMockOpts {
  /** Answer every admin call with this status (401 = wrong token, 429 = lockout). */
  status?: 401 | 429;
  emptyProjects?: boolean;
  items?: Item[];
  /** Page size of the mocked history (the real API defaults to 25). */
  pageSize?: number;
  /** Signed in through Cloudflare Access as this email: /api/admin/me says so and no token is needed. */
  access?: string;
  /** Scripted answers of POST …/retry, in order (default: delivered). */
  retry?: Array<{ status: number; body: Record<string, unknown> }>;
}

/** Every write the admin sent: method, path and body. */
export type Write = { method: string; path: string; body: unknown };

/** Records the outcome filter of every history request, for assertions. */
export async function installAdminMocks(page: Page, opts: AdminMockOpts = {}) {
  const requests: Array<{ outcome: string | null; cursor: string | null; view: string | null }> = [];
  const writes: Write[] = [];
  let configVersion = harborConfig.configVersion;
  /** The Authorization header of every admin call ("" when none was sent). */
  const authHeaders: string[] = [];
  const items = opts.items ?? feedbackItems();
  const pageSize = opts.pageSize ?? 7;
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

  await page.route(`${R2}/**`, (r) => r.fulfill({ status: 200, contentType: "image/svg+xml", body: SHOT_SVG }));
  await page.route("**/api/admin/**", (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const auth = req.headers()["authorization"] ?? "";
    authHeaders.push(auth);
    // Like the gateway: a probe without credentials is a plain 401 (never 429).
    if (url.pathname === "/api/admin/me") {
      if (opts.access) return json(route, { v: 1, via: "access", email: opts.access });
      if (!auth) return json(route, { v: 1, status: "error", error: "unauthorized" }, 401);
    }
    if (opts.status === 429) return json(route, { v: 1, status: "error", error: "rate limited" }, 429);
    if (opts.status === 401 || (!opts.access && auth !== `Bearer ${TOKEN}`)) return json(route, { v: 1, status: "error", error: "unauthorized" }, 401);

    const p = url.pathname;
    if (p === "/api/admin/me") return json(route, { v: 1, via: "token" });

    if (p === "/api/admin/projects") return json(route, { v: 1, projects: opts.emptyProjects ? [] : projects() });
    if (p === "/api/admin/system") return json(route, system());
    const method = req.method();
    if (method !== "GET") {
      const body = req.postData() ? (JSON.parse(req.postData()!) as Record<string, unknown>) : undefined;
      writes.push({ method, path: p, body });
      const fb = /^\/api\/admin\/feedback\/([^/]+)(\/retry)?$/.exec(p);
      if (fb && fb[2]) {
        const next = opts.retry?.shift() ?? { status: 200, body: { v: 1, status: "delivered", feedbackId: fb[1], projectUrl: "https://github.com/orgs/harborline/projects/3", warnings: [] } };
        return json(route, next.body, next.status);
      }
      const item = fb ? items.find((i) => i.id === fb[1]) : undefined;
      if (fb && method === "PATCH" && item) {
        if (typeof body?.["disposition"] === "string") item.disposition = body["disposition"] as string;
        if (body && "note" in body) item.note = (body["note"] as string) || null;
        return json(route, { v: 1, status: "updated", feedbackId: item.id, disposition: item.disposition, note: item.note });
      }
      if (fb && method === "DELETE" && item) {
        items.splice(items.indexOf(item), 1);
        return json(route, { v: 1, status: "deleted", feedbackId: item.id, assetsDeleted: 1 });
      }
      if (p === "/api/admin/projects/harborline/config/validate") {
        const cfg = body?.["config"] as { templates?: Array<{ type: string; noIssue?: boolean }> } | undefined;
        if (!cfg?.templates?.length) return json(route, { v: 1, status: "error", code: "FK_CONFIG_INVALID", error: "config failed validation", issues: ["templates: Array must contain at least 1 element(s)"] }, 400);
        return json(route, { v: 1, status: "valid", configVersion, deliveries: cfg.templates.map((t) => ({ type: t.type, delivery: t.noIssue ? "local" : "issue" })) });
      }
      if (p === "/api/admin/projects/harborline/config" && method === "PUT") {
        if (body?.["expectedVersion"] !== configVersion) return json(route, { v: 1, status: "error", code: "FK_CONFIG_STALE", error: `the config changed since you loaded it (now v${configVersion}); review the new diff and publish again`, configVersion, config: harborConfig }, 409);
        configVersion++;
        return json(route, { v: 1, status: "published", configVersion });
      }
      if (p === "/api/admin/projects/harborline/test-report") {
        return json(route, { v: 1, status: "sent", feedbackId: "t-1", type: "bug", delivery: "issue", deliveryState: "delivered", issueUrl: "https://github.com/harborline/web/issues/300", projectUrl: null, warnings: [] });
      }
      return json(route, { v: 1, status: "error", error: "not found" }, 404);
    }
    if (p === "/api/admin/projects/harborline/config") return json(route, { ...harborConfig, configVersion });
    if (p === "/api/admin/projects/harborline/funnel") return json(route, funnel);
    if (p === "/api/admin/projects/harborline/feedback") {
      const outcome = url.searchParams.get("outcome");
      const cursor = url.searchParams.get("cursor");
      const view = url.searchParams.get("view");
      requests.push({ outcome, cursor, view });
      const inView = (i: Item) =>
        !view ||
        (view === "open" && i.delivery === "local" && i.disposition === "open") ||
        (view === "done" && i.delivery === "local" && i.disposition !== "open") ||
        (view === "undecided" && i.delivery === null && !i.issueUrl && i.disposition === "open");
      const all = items.filter((i) => (!outcome || i.outcome === outcome) && inView(i));
      const start = cursor ? Number(cursor) : 0;
      const slice = all.slice(start, start + pageSize);
      const next = start + pageSize < all.length ? String(start + pageSize) : null;
      return json(route, { v: 1, items: slice, nextCursor: next });
    }
    if (p.startsWith("/api/admin/projects/")) return json(route, { v: 1, status: "error", error: "unknown project" }, 404);
    return json(route, { v: 1, status: "error", error: "not found" }, 404);
  });
  return { requests, authHeaders, writes };
}

/** Starts the page signed in (the token the login would have stored). */
export async function signedIn(page: Page) {
  await page.addInitScript((t) => sessionStorage.setItem("fk-admin-token", t), TOKEN);
}
