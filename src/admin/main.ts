// FeedbackKit admin, read-only (P2, step 3, ADR-014). Fills the Worker-rendered
// shells from /api/admin/*. Two ways in: when Cloudflare Access sits in front of
// the admin, GET /api/admin/me answers with the signed-in email and no token is
// needed (Access sends its own cookie; the gateway trusts only the JWT header
// Access adds at the edge). Otherwise the admin token lives in sessionStorage
// only and goes out as a Bearer header.
//
// Everything that comes from the API is untrusted (feedback text is whatever a
// visitor typed): it reaches the DOM only through textContent / append(string),
// never innerHTML, and URLs only after a scheme check.

type Outcome = "created" | "accepted_incomplete" | "ai-failed" | "issue_failed";
type Label = string | Record<string, string>;

interface ProjectSummary {
  id: string;
  publicKey: string;
  configVersion: number;
  updatedAt: number;
  feedback7d: { total: number; byOutcome: Record<string, number> };
}
interface FieldSpec {
  key: string;
  label: Label;
  kind: string;
  required?: boolean;
  askIfMissing?: boolean;
}
interface Template {
  type: string;
  label: Label;
  fields?: FieldSpec[];
  tracker?: { repo?: string; labels?: string[] };
  noIssue?: boolean;
}
interface ProjectConfig {
  publicKey: string;
  configVersion: number;
  projectId: string;
  locale?: string;
  askType?: boolean;
  templates: Template[];
  tracker: { defaultRepo: string };
  auth?: { origins?: string[] };
}
interface Attachment {
  key: string;
  kind: string;
  url: string | null;
}
interface FeedbackItem {
  id: string;
  createdAt: number;
  outcome: string;
  type: string | null;
  title: string | null;
  summary: string | null;
  message: string | null;
  issueUrl: string | null;
  llmModel: string | null;
  attachments: Attachment[];
  retryable: boolean;
}
interface Funnel {
  events: Record<string, number>;
  feedback: { total: number; byOutcome: Record<string, number> };
}
interface SystemProject {
  id: string;
  configVersion: number;
  configValid: boolean;
  enabled?: boolean;
  llm?: { provider: string; model: string | null; usedToday: number; dailyBudget: number };
  tracker?: {
    repo: string;
    patSecret: string;
    patPresent: boolean;
    access: { ok: boolean; status: number; reason: string | null } | null;
    patExpiry: { raw: string; at: string | null; daysLeft: number | null } | null;
  };
}
interface SystemInfo {
  version: string;
  channel: string;
  schema: { ok: boolean; version: number | null; expected: number };
  bindings: Record<string, boolean>;
  secrets: { adminToken: boolean; githubPat: boolean; llmKey: boolean; accessTeamDomain?: boolean; accessAud?: boolean };
  projects: SystemProject[];
}

const TOKEN_KEY = "fk-admin-token";
const THEME_KEY = "fk-admin-theme";
const PAT_WARN_DAYS = 14;
const BUDGET_WARN = 0.8;
const DAY = 86_400_000;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ── storage (wrapped: private windows and blocked storage throw) ─────────────
function store(kind: "session" | "local", key: string, value?: string | null): string | null {
  try {
    const s = kind === "session" ? sessionStorage : localStorage;
    if (value === undefined) return s.getItem(key);
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    /* storage unavailable: the page still works for this load */
  }
  return null;
}
const readToken = () => store("session", TOKEN_KEY);

// Set when /api/admin/me reports a Cloudflare Access sign-in: requests then go
// out without a token, and Access adds the identity on its way to the gateway.
let accessEmail: string | null = null;

async function api<T>(path: string, token = readToken()): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (accessEmail === null) headers["Authorization"] = `Bearer ${token ?? ""}`;
  // same-origin: with Access in front, the browser must send the CF_Authorization
  // cookie or Access stops the request before it reaches the gateway.
  const res = await fetch(path, { headers, cache: "no-store", credentials: "same-origin" });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: unknown };
      if (typeof j.error === "string") msg = j.error;
    } catch {
      /* not JSON */
    }
    throw new HttpError(res.status, msg);
  }
  return (await res.json()) as T;
}

// ── DOM helpers ───────────────────────────────────────────────────────────────
type Kid = Node | string | number | null | undefined | false;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, string> | null, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]!);
  for (const k of kids) if (k !== null && k !== undefined && k !== false) e.append(typeof k === "number" ? String(k) : k);
  return e;
}
function icon(name: string): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "i");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(ns, "use");
  use.setAttribute("href", `#${name}`);
  svg.append(use);
  return svg;
}
const badge = (cls: string, text: string, ...kids: Kid[]) => el("span", { class: `badge ${cls}` }, ...kids, text);

/** Only http(s) URLs become links or image sources; anything else is dropped. */
function safeUrl(raw: string | null | undefined, imageOnly = false): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw, location.origin);
    if (u.protocol === "https:" || (u.protocol === "http:" && (!imageOnly || u.origin === location.origin))) return u.href;
  } catch {
    /* not a URL */
  }
  return null;
}

function labelText(l: Label | undefined, locale = "en"): string {
  if (!l) return "";
  if (typeof l === "string") return l;
  return l[locale] ?? l["en"] ?? Object.values(l)[0] ?? "";
}

// "12 Sep" / "20 Oct 2026", in UTC like the tooltips (Intl's en-GB says "Sept").
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayMonth = (d: Date) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
const dateFmt = { format: (d: Date | number) => `${dayMonth(new Date(d))} ${new Date(d).getUTCFullYear()}` };
function ago(ts: number, now = Date.now()): string {
  const d = now - ts;
  if (d < 60_000) return "Just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} min ago`;
  if (d < DAY) return `${Math.floor(d / 3_600_000)} h ago`;
  if (d < 2 * DAY) return "Yesterday";
  if (d < 7 * DAY) return `${Math.floor(d / DAY)} days ago`;
  return new Date(ts).getUTCFullYear() === new Date(now).getUTCFullYear() ? dayMonth(new Date(ts)) : dateFmt.format(ts);
}
function timeEl(ts: number, cls = "muted sm"): HTMLTimeElement {
  const iso = new Date(ts).toISOString();
  return el("time", { class: cls, datetime: iso, title: iso.replace("T", " ").slice(0, 16) + " UTC" }, ago(ts));
}
function inDays(days: number): string {
  if (days < 0) return "expired";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 60) return `in ${days} days`;
  return `in ${Math.round(days / 30)} months`;
}

function notice(text: string | null) {
  const n = $("notice");
  n.textContent = text ?? "";
  n.hidden = !text;
}

// ── theme (manual override on top of prefers-color-scheme) ───────────────────
function applyTheme(t: string | null) {
  if (t === "light" || t === "dark") document.documentElement.dataset["theme"] = t;
}
function toggleTheme() {
  const root = document.documentElement;
  const dark = root.dataset["theme"] ? root.dataset["theme"] === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  const next = dark ? "light" : "dark";
  root.dataset["theme"] = next;
  store("local", THEME_KEY, next);
}

// ── auth ──────────────────────────────────────────────────────────────────────
const MSG_WRONG = "That token didn't match.";
const MSG_LOCKED = "Too many failed sign-ins from your network. After 20 in an hour, sign-in stays blocked until the hour is over.";
const MSG_ENDED = "The saved token no longer works. Sign in again.";
const MSG_ACCESS_ENDED = "Your sign-in has ended. Reload the page to sign in again.";

/** Asks the gateway, without a token, whether Cloudflare Access signed this visitor in. */
async function accessSignIn(): Promise<string | null> {
  try {
    const res = await fetch("/api/admin/me", { headers: { Accept: "application/json" }, cache: "no-store", credentials: "same-origin" });
    if (!res.ok) return null;
    const me = (await res.json()) as { via?: unknown; email?: unknown };
    return me.via === "access" && typeof me.email === "string" && me.email ? me.email : null;
  } catch {
    return null;
  }
}

function showLogin(msg?: string) {
  store("session", TOKEN_KEY, null);
  notice(null);
  for (const s of document.querySelectorAll<HTMLElement>("main > section")) s.hidden = s.id !== "login";
  $("nav").hidden = true;
  $("signout").hidden = true;
  $("signout-access").hidden = true;
  $("who").hidden = true;
  setLoginError(msg ?? null);
  $("token").focus();
}
function setLoginError(msg: string | null) {
  const m = $("token-msg");
  m.textContent = msg ?? "";
  m.hidden = !msg;
  $("token").classList.toggle("err", !!msg);
  $("token").setAttribute("aria-invalid", msg ? "true" : "false");
}

function wireLogin(view: string) {
  const form = $<HTMLFormElement>("login-form");
  const input = $<HTMLInputElement>("token");
  const btn = $<HTMLButtonElement>("login-btn");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const token = input.value.trim();
    if (!token) return setLoginError("Paste the admin token first.");
    btn.disabled = true;
    try {
      await api("/api/admin/projects", token);
      store("session", TOKEN_KEY, token);
      input.value = "";
      setLoginError(null);
      start(view);
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) setLoginError(MSG_WRONG);
      else if (err instanceof HttpError && err.status === 429) setLoginError(MSG_LOCKED);
      else setLoginError("The gateway didn't answer. Try again in a moment.");
    } finally {
      btn.disabled = false;
    }
  });
}

/** 401/429 end the session; anything else is shown as a load error. */
function fail(err: unknown, what: string) {
  if (accessEmail !== null && err instanceof HttpError && err.status === 401) {
    for (const s of document.querySelectorAll<HTMLElement>("main > section")) s.hidden = true;
    return notice(MSG_ACCESS_ENDED);
  }
  if (err instanceof HttpError && err.status === 401) return showLogin(MSG_ENDED);
  if (err instanceof HttpError && err.status === 429) return showLogin(MSG_LOCKED);
  const why = err instanceof HttpError ? `The gateway answered ${err.status} (${err.message}).` : "The gateway didn't answer.";
  notice(`Couldn't load ${what}. ${why} Reload the page to try again.`);
}

// ── projects ──────────────────────────────────────────────────────────────────
async function loadProjects() {
  const r = await api<{ projects: ProjectSummary[] }>("/api/admin/projects");
  const list = r.projects;
  $("projects-sub").textContent = !list.length ? "No projects on this gateway yet" : list.length === 1 ? "1 project on this gateway" : `${list.length} projects on this gateway`;
  $("projects-table").hidden = list.length === 0;
  $("projects-empty").hidden = list.length > 0;
  if (!list.length) {
    $("import-cmd").textContent = [
      "curl -X POST \\",
      '  -H "Authorization: Bearer $ADMIN_TOKEN" \\',
      '  -H "Content-Type: application/json" \\',
      "  --data @feedbackkit.config.json \\",
      `  ${location.origin}/api/admin/config/import`,
    ].join("\n");
    return;
  }
  $("projects-rows").replaceChildren(
    ...list.map((p) => {
      const failed = p.feedback7d.byOutcome["issue_failed"] ?? 0;
      return el(
        "tr",
        null,
        el("td", null, el("a", { class: "name", href: `/admin/projects/${encodeURIComponent(p.id)}` }, p.id), el("div", { class: "mono muted" }, p.publicKey)),
        el("td", { class: "num" }, p.feedback7d.total),
        el("td", null, failed > 0 ? badge("failed", String(failed)) : el("span", { class: "muted" }, "0")),
        el("td", { class: "mono" }, `v${p.configVersion}`),
        el("td", null, timeEl(p.updatedAt, "muted")),
      );
    }),
  );
}

// ── project detail ────────────────────────────────────────────────────────────
type Filter = "all" | "created" | "saved" | Outcome;
const FILTERS: Record<Filter, { outcome?: Outcome; keep?: (i: FeedbackItem) => boolean }> = {
  all: {},
  created: { outcome: "created", keep: (i) => !!i.issueUrl },
  saved: { outcome: "created", keep: (i) => !i.issueUrl },
  accepted_incomplete: { outcome: "accepted_incomplete" },
  issue_failed: { outcome: "issue_failed" },
  "ai-failed": { outcome: "ai-failed" },
};
// Client-side filters skip rows, so a page can come back empty while older
// rows match; keep paging, but not forever.
const MAX_PAGES_PER_LOAD = 8;

function outcomeBadge(i: FeedbackItem): HTMLElement {
  switch (i.outcome) {
    case "created":
      return i.issueUrl ? badge("created", "Issue created") : badge("stored", "Saved, no issue");
    case "accepted_incomplete":
      return badge("incomplete", "Sent incomplete");
    case "ai-failed":
      return badge("aifail", "AI failed");
    case "issue_failed":
      return badge("failed", "Issue failed");
    default:
      return badge("stored", i.outcome);
  }
}

function thumb(atts: Attachment[]): HTMLElement {
  if (!atts.length) return el("div", { class: "thumb none", title: "No attachment" });
  const n = atts.length === 1 ? "1 attachment" : `${atts.length} attachments`;
  const url = safeUrl(atts.find((a) => a.url)?.url, true);
  if (!url) return el("div", { class: "thumb", title: `${n}, no public URL configured` }, icon("i-image"));
  const img = el("img", { src: url, alt: "Screenshot of the report", loading: "lazy", decoding: "async" });
  img.addEventListener("error", () => img.replaceWith(icon("i-image")), { once: true });
  return el("a", { class: "thumb", href: url, target: "_blank", rel: "noopener noreferrer", title: `${n}, opens full size` }, img);
}

function issueLink(raw: string | null): HTMLElement | null {
  const url = safeUrl(raw);
  if (!url) return null;
  const num = /\/(?:issues|pull)\/(\d+)/.exec(url)?.[1];
  return el("a", { class: "lnk", href: url, target: "_blank", rel: "noopener noreferrer" }, num ? `#${num}` : "Issue", icon("i-ext"));
}

function historyRow(i: FeedbackItem, typeLabels: Map<string, string>): HTMLElement {
  const text = i.summary || i.message || i.title || "(no text)";
  const meta = i.llmModel ? i.llmModel : "model not recorded";
  const side = el("div", { class: "side" }, outcomeBadge(i));
  let why: HTMLElement | null = null;
  if (i.outcome === "issue_failed") {
    const reason = i.retryable
      ? "An issue draft is saved. Retrying from this page comes in a later release."
      : "No issue draft was saved for this report, so it can't be retried.";
    side.append(el("button", { class: "b ghost sm", type: "button", disabled: "", title: reason }, "Retry"));
    why = el("p", { class: "why" }, reason);
  } else {
    const link = issueLink(i.issueUrl);
    if (link) side.append(link);
  }
  return el(
    "article",
    { class: "hrow", "data-outcome": i.outcome },
    thumb(i.attachments),
    el(
      "div",
      null,
      el("div", { class: "top-line" }, i.type ? el("span", { class: "t" }, typeLabels.get(i.type) ?? i.type) : null, timeEl(i.createdAt)),
      el("p", { class: "sum" }, text),
      el("p", { class: "meta mono" }, meta),
      why,
    ),
    side,
  );
}

function initHistory(id: string, typeLabels: Map<string, string>) {
  const rows = $("rows");
  const more = $<HTMLButtonElement>("more");
  const loading = $("rows-loading");
  let filter: Filter = "all";
  let cursor: string | null = null;
  let gen = 0;

  async function load(reset: boolean) {
    const mine = ++gen;
    if (reset) {
      cursor = null;
      rows.replaceChildren();
    }
    more.hidden = true;
    loading.hidden = false;
    const f = FILTERS[filter];
    let added = 0;
    let pages = 0;
    try {
      do {
        const q = new URLSearchParams();
        if (f.outcome) q.set("outcome", f.outcome);
        if (cursor) q.set("cursor", cursor);
        const r = await api<{ items: FeedbackItem[]; nextCursor: string | null }>(`/api/admin/projects/${encodeURIComponent(id)}/feedback?${q}`);
        if (mine !== gen) return;
        const keep = f.keep ? r.items.filter(f.keep) : r.items;
        rows.append(...keep.map((i) => historyRow(i, typeLabels)));
        added += keep.length;
        cursor = r.nextCursor;
        pages++;
      } while (f.keep && added === 0 && cursor && pages < MAX_PAGES_PER_LOAD);
    } catch (err) {
      if (mine === gen) fail(err, "the feedback history");
      return;
    } finally {
      if (mine === gen) loading.hidden = true;
    }
    more.hidden = !cursor;
    if (!rows.childElementCount && !cursor) {
      rows.append(el("p", { class: "empty-msg" }, filter === "all" ? "No reports yet. They show up here once someone sends feedback." : "No reports match this filter."));
    }
  }

  const chips = [...document.querySelectorAll<HTMLButtonElement>("#filters [data-filter]")];
  for (const chip of chips) {
    chip.addEventListener("click", () => {
      filter = chip.dataset["filter"] as Filter;
      for (const c of chips) c.setAttribute("aria-pressed", c === chip ? "true" : "false");
      void load(true);
    });
  }
  more.addEventListener("click", () => void load(false));
  void load(true);
}

function initTabs() {
  const tabs = [...document.querySelectorAll<HTMLButtonElement>("[role=tab][data-tab]")];
  const select = (name: string, focus = false) => {
    for (const t of tabs) {
      const on = t.dataset["tab"] === name;
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.tabIndex = on ? 0 : -1;
      $(`panel-${t.dataset["tab"]}`).hidden = !on;
      if (on && focus) t.focus();
    }
  };
  tabs.forEach((t, idx) => {
    t.addEventListener("click", () => {
      select(t.dataset["tab"]!);
      history.replaceState(null, "", `#${t.dataset["tab"]}`);
    });
    t.addEventListener("keydown", (e) => {
      const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      const next = tabs[(idx + step + tabs.length) % tabs.length]!;
      select(next.dataset["tab"]!, true);
    });
  });
  const fromHash = location.hash.slice(1);
  select(tabs.some((t) => t.dataset["tab"] === fromHash) ? fromHash : "history");
}

function renderFunnel(f: Funnel) {
  const ev = (k: string) => f.events[k] ?? 0;
  const opened = ev("opened");
  for (const step of document.querySelectorAll<HTMLElement>("#funnel [data-ev]")) {
    const n = ev(step.dataset["ev"]!);
    const pct = opened > 0 ? Math.round((n / opened) * 100) : null;
    step.querySelector("b")!.textContent = String(n);
    step.querySelector("small")!.textContent = pct === null ? "" : `${pct}%`;
    step.querySelector("i")!.style.setProperty("--w", `${Math.min(pct ?? 0, 100)}%`);
  }
  for (const b of document.querySelectorAll<HTMLElement>(".fafter [data-ev]")) b.textContent = String(ev(b.dataset["ev"]!));
}

function renderSetup(cfg: ProjectConfig, funnel: Funnel | null) {
  $("snippet").textContent = `<script src="${location.origin}/widget.js" data-project="${cfg.publicKey}"></script>`;
  const test = $<HTMLAnchorElement>("testpage");
  test.href = `/t/${encodeURIComponent(cfg.publicKey)}`;
  const origins = cfg.auth?.origins ?? [];
  $("origins").replaceChildren(
    ...(origins.length ? origins.map((o) => el("span", { class: "t mono" }, o)) : [el("p", { class: "help err" }, "No origins yet. The widget won't load on any site until you add one.")]),
  );
  const done = (stepId: string, isDone: boolean) => {
    const s = $(stepId);
    s.classList.toggle("done", isDone);
    s.querySelector(".n")!.replaceChildren(isDone ? icon("i-check") : stepId === "step-snippet" ? "1" : "2");
  };
  done("step-snippet", (funnel?.events["opened"] ?? 0) > 0);
  done("step-origins", origins.length > 0);

  const copyMsg = $("copy-msg");
  $("copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("snippet").textContent ?? "");
      copyMsg.textContent = "Copied";
    } catch {
      copyMsg.textContent = "Copying failed. Select the text instead.";
    }
    setTimeout(() => (copyMsg.textContent = ""), 2500);
  });
}

const KIND: Record<string, string> = { text: "Text", longtext: "Long text", select: "Choice", url: "URL" };

function renderTypes(cfg: ProjectConfig) {
  const locale = cfg.locale ?? "en";
  $("types-note").textContent = cfg.askType ? "People pick the type in the widget." : "The AI picks the type, so people don't choose one.";
  $("types-list").replaceChildren(
    ...cfg.templates.map((t, idx) => {
      const fields = t.fields ?? [];
      const required = fields.filter((f) => f.required).length;
      const labels = t.tracker?.labels ?? [];
      const meta = t.noIssue
        ? `${fields.length === 0 ? "No fields" : `${fields.length} fields`} · saved without an issue`
        : [
            fields.length === 1 ? "1 field" : `${fields.length} fields`,
            `${required} required`,
            t.tracker?.repo ?? cfg.tracker.defaultRepo,
            labels.length ? `labels ${labels.join(", ")}` : null,
          ]
            .filter(Boolean)
            .join(" · ");
      const inner = el("div", { class: "inner" });
      if (required > 3) {
        inner.append(el("p", { class: "note" }, `${required} required fields. Each extra one makes the follow-up longer for the person reporting. Consider making one optional.`));
      }
      inner.append(
        fields.length
          ? el(
              "div",
              { class: "tbl inset" },
              el(
                "table",
                null,
                el("thead", null, el("tr", null, ...["Label", "Key", "Kind", "Required", "Ask if missing"].map((h) => el("th", { scope: "col" }, h)))),
                el(
                  "tbody",
                  null,
                  ...fields.map((f) =>
                    el(
                      "tr",
                      null,
                      el("td", null, labelText(f.label, locale)),
                      el("td", { class: "mono" }, f.key),
                      el("td", null, KIND[f.kind] ?? f.kind),
                      el("td", null, f.required ? "Yes" : "No"),
                      el("td", null, f.askIfMissing === false ? "No" : "Yes"),
                    ),
                  ),
                ),
              ),
            )
          : el("p", { class: "help" }, t.noIssue ? "Stored in the history. It never opens an issue." : "No fields. The issue holds the text as written."),
      );
      const d = el("details", { class: "tcard" }, el("summary", null, el("span", { class: "nm" }, labelText(t.label, locale) || t.type), el("span", { class: "meta" }, meta)), inner);
      if (idx === 0) d.open = true;
      return d;
    }),
  );
}

async function loadProject() {
  const id = decodeURIComponent(location.pathname.split("/")[3] ?? "");
  $("p-name").textContent = id;
  $("p-crumb").textContent = id;
  document.title = `${id} · FeedbackKit admin`;
  initTabs();
  const base = `/api/admin/projects/${encodeURIComponent(id)}`;
  let cfg: ProjectConfig;
  try {
    cfg = await api<ProjectConfig>(`${base}/config`);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      notice(`There's no project called "${id}" on this gateway.`);
      $("view-project").hidden = true;
      return;
    }
    throw err;
  }
  $("p-meta").textContent = `${cfg.publicKey} · config v${cfg.configVersion}`;
  renderTypes(cfg);
  initHistory(id, new Map(cfg.templates.map((t) => [t.type, labelText(t.label, cfg.locale) || t.type])));

  const exp = $<HTMLButtonElement>("p-export");
  exp.disabled = false;
  exp.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(cfg, null, 2) + "\n"], { type: "application/json" });
    const a = el("a", { href: URL.createObjectURL(blob), download: `${id}.feedbackkit.config.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  let funnel: Funnel | null = null;
  try {
    funnel = await api<Funnel>(`${base}/funnel?days=30`);
    renderFunnel(funnel);
  } catch (err) {
    fail(err, "the funnel");
  }
  renderSetup(cfg, funnel);
}

// ── system ────────────────────────────────────────────────────────────────────
function attentionItems(s: SystemInfo): HTMLElement[] {
  const out: HTMLElement[] = [];
  const item = (project: string | null, ...text: Kid[]) => out.push(el("div", null, el("span", null, project ? el("b", null, project) : null, project ? " " : null, ...text)));
  if (!s.schema.ok) item(null, `The database schema is v${s.schema.version ?? "?"}, the code expects v${s.schema.expected}. Apply the D1 migrations.`);
  for (const p of s.projects) {
    if (!p.configValid || !p.tracker || !p.llm) {
      item(p.id, "has a stored config that doesn't validate. Import a fixed config.");
      continue;
    }
    const t = p.tracker;
    if (!t.patPresent) item(p.id, "can't create issues: ", el("code", { class: "mono" }, t.patSecret), " is not set.");
    else if (t.access && !t.access.ok) item(p.id, `can't reach ${t.repo}: ${t.access.reason ?? `GitHub answered ${t.access.status}`}.`);
    const days = t.patExpiry?.daysLeft;
    if (t.patExpiry?.at && typeof days === "number" && days <= PAT_WARN_DAYS) {
      const when = dateFmt.format(new Date(t.patExpiry.at));
      item(p.id, days < 0 ? `GitHub token expired on ${when}.` : `GitHub token expires on ${when}.`);
    }
    if (p.llm.provider !== "off" && p.llm.dailyBudget > 0 && p.llm.usedToday / p.llm.dailyBudget > BUDGET_WARN) {
      item(p.id, `has used ${p.llm.usedToday} of ${p.llm.dailyBudget} AI calls today. The count resets at 00:00 UTC.`);
    }
  }
  return out;
}

function projectRow(p: SystemProject): HTMLElement {
  const name = el("td", { class: "name" }, p.id);
  if (!p.configValid || !p.llm || !p.tracker) return el("tr", null, name, el("td", { colspan: "3", class: "danger" }, "Config doesn't validate"));
  const { llm, tracker } = p;
  let usage: HTMLElement[];
  if (llm.provider === "off") usage = [el("td", { class: "muted sm" }, "AI off"), el("td")];
  else {
    const ratio = llm.dailyBudget > 0 ? llm.usedToday / llm.dailyBudget : 0;
    const fill = el("span", ratio > BUDGET_WARN ? { class: "hot" } : null);
    fill.style.setProperty("--w", `${Math.min(100, Math.round(ratio * 100))}%`);
    usage = [el("td", { class: "w38" }, el("div", { class: "bar", role: "img", "aria-label": `${Math.round(ratio * 100)}% of the daily budget` }, fill)), el("td", { class: "num" }, `${llm.usedToday} / ${llm.dailyBudget}`)];
  }
  let token: HTMLElement;
  const exp = tracker.patExpiry;
  if (!tracker.patPresent) token = el("td", null, el("span", { class: "danger" }, "Secret not set"));
  else if (exp?.at && typeof exp.daysLeft === "number") {
    const soon = exp.daysLeft <= PAT_WARN_DAYS;
    token = el("td", null, el("span", soon ? { class: "danger" } : null, dateFmt.format(new Date(exp.at))), el("div", { class: "sm muted" }, inDays(exp.daysLeft)));
  } else if (tracker.access && !tracker.access.ok) token = el("td", null, el("span", { class: "danger" }, `No access (${tracker.access.status})`));
  else token = el("td", { class: "muted" }, "No expiry date");
  return el("tr", null, name, ...usage, token);
}

async function loadSystem() {
  const s = await api<SystemInfo>("/api/admin/system");
  $("sys-sub").textContent = `${s.version} on ${s.channel} · schema v${s.schema.version ?? "?"}`;

  const items = attentionItems(s);
  const count = $("attn-count");
  count.className = `badge ${items.length ? "failed" : "ok"}`;
  count.textContent = items.length ? String(items.length) : "All good";
  $("attention").replaceChildren(...(items.length ? items : [el("div", null, el("span", { class: "muted" }, "Nothing needs attention right now."))]));

  $("sys-projects").replaceChildren(...(s.projects.length ? s.projects.map(projectRow) : [el("tr", null, el("td", { colspan: "4", class: "muted" }, "No projects yet."))]));

  const bindings = Object.keys(s.bindings);
  const missingBindings = bindings.filter((b) => !s.bindings[b]);
  const pats = new Map<string, boolean>();
  let llmUsed = false;
  for (const p of s.projects) {
    if (p.tracker) pats.set(p.tracker.patSecret, p.tracker.patPresent);
    if (p.llm && p.llm.provider !== "off") llmUsed = true;
  }
  const patsSet = [...pats.values()].filter(Boolean).length;
  const missingSecrets = pats.size - patsSet + (llmUsed && !s.secrets.llmKey ? 1 : 0);
  const secretList = ["ADMIN_TOKEN", s.secrets.llmKey ? "LLM_API_KEY" : llmUsed ? "LLM_API_KEY missing" : "no LLM_API_KEY", `${patsSet} of ${pats.size} GitHub tokens`].join(", ");
  const row = (k: string, v: string, status: HTMLElement) => el("tr", null, el("td", null, k), el("td", { class: "mono" }, v), el("td", null, status));
  $("sys-gateway").replaceChildren(
    row("Release", s.version, badge("ok", s.channel)),
    row("Database schema", `v${s.schema.version ?? "?"}`, s.schema.ok ? badge("ok", "Matches code") : badge("failed", `Expected v${s.schema.expected}`)),
    row("Bindings", bindings.join(" · "), missingBindings.length ? badge("failed", `Missing ${missingBindings.join(", ")}`) : badge("ok", "All present")),
    row("Secrets", secretList, missingSecrets ? badge("failed", `${missingSecrets} missing`) : badge("ok", "All set")),
  );
}

// ── boot ──────────────────────────────────────────────────────────────────────
const LOADERS: Record<string, [string, () => Promise<void>]> = {
  projects: ["the projects", loadProjects],
  project: ["the project", loadProject],
  system: ["the system status", loadSystem],
};

let started = false;

function start(view: string) {
  // A second sign-in in the same page load (after a 401) starts from a clean
  // page instead of wiring every listener twice.
  if (started) return location.reload();
  started = true;
  const section = $(`view-${view}`);
  $("login").hidden = true;
  $("nav").hidden = false;
  $("signout").hidden = accessEmail !== null;
  $("signout-access").hidden = accessEmail === null;
  if (accessEmail !== null) {
    const who = $("who");
    // On phones only the email shows; the label is for wider screens and screen readers.
    who.replaceChildren(el("span", { class: "who-label" }, "Signed in as "), accessEmail);
    who.title = accessEmail;
    who.hidden = false;
  }
  section.hidden = false;
  const [what, load] = LOADERS[view] ?? LOADERS["projects"]!;
  load().catch((err) => fail(err, what));
}

async function boot() {
  applyTheme(store("local", THEME_KEY));
  $("theme").addEventListener("click", toggleTheme);
  $("signout").addEventListener("click", () => showLogin());
  const view = document.body.dataset["view"] ?? "projects";
  wireLogin(view);
  accessEmail = await accessSignIn();
  if (accessEmail !== null || readToken()) start(view);
  else showLogin();
}

void boot();
