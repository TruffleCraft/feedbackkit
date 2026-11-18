import { reduce, visibilityChange, type RetrySnapshot, type WidgetState } from "./core/state.js";
import { createConsoleBuffer, installConsoleBuffer } from "./core/console-buffer.js";
import { collectDeviceInfo } from "./lib/device-info.js";
import { captureScreenshot } from "./lib/screenshot.js";
import { uuid } from "./lib/uuid.js";
import { Api } from "./lib/api.js";
import { readHostContext } from "./lib/host-context.js";
import { TurnstileGate } from "./lib/turnstile.js";
import { WidgetUI, type SentEntry, type UIConfig } from "./ui/panel.js";
import type { Locale } from "./ui/i18n.js";
import { redactPageUrl } from "../shared/page-url.js";
import type { PublicConfig, FeedbackPayload, FeedbackResponse } from "../shared/contract.js";

declare global {
  interface Window {
    /** Host-supplied debug context (object, or a function read at submit time). */
    FeedbackKitContext?: unknown;
    /** Set by the widget once booted: open the panel from the host's own UI,
     * or bring back a minimized report. The widget also dispatches
     * `feedbackkit:open` and `feedbackkit:close` on window when a report starts
     * and ends; minimizing and restoring fire nothing. */
    FeedbackKit?: { open(): void; version: string };
  }
}

const DOC = "https://github.com/TruffleCraft/feedbackkit#readme";
// Release of this bundle (ADR-013), injected by scripts/build-widget.mjs.
declare const __FK_RELEASE__: string;
const RELEASE = typeof __FK_RELEASE__ === "string" ? __FK_RELEASE__ : "0.0.0-local";

type Label = string | Record<string, string>;

/** A screenshot in the draft (#170): uploaded on capture, labelled with its page
 * (origin and path). After a page load only the key and the page come back. */
interface Shot {
  blob?: Blob;
  url?: string;
  key?: string | null;
  page: string;
  up?: Promise<unknown>;
}

/** The tab's sessionStorage (#170): read with one argument, write a value, drop
 * with null. A blocked storage leaves the draft in memory only. */
function stash(key: string, value?: unknown): unknown {
  try {
    if (value === undefined) return JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage blocked or unreadable */
  }
  return null;
}
function label(l: Label, locale: string): string {
  return typeof l === "string" ? l : (l[locale] ?? Object.values(l)[0] ?? "");
}

function toUIConfig(cfg: PublicConfig, triggerLabel: string | undefined, hideTrigger: boolean, triggerMedia?: MediaQueryList): UIConfig {
  const locale = (cfg.locale === "de" ? "de" : "en") as Locale;
  // https-only: a server value never goes into an href unchecked.
  const privacyUrl = cfg.privacyUrl && /^https:\/\//i.test(cfg.privacyUrl) ? cfg.privacyUrl : undefined;
  return {
    locale,
    triggerLabel,
    heading: cfg.appearance?.heading,
    hideTrigger,
    triggerMedia,
    screenshot: cfg.capture?.screenshot !== "off",
    privacyUrl,
    autoType: !!cfg.autoType,
    types: cfg.types.map((ty) => ({
      type: ty.type,
      label: label(ty.label, locale),
      guidance: ty.guidance ? label(ty.guidance, locale) : undefined,
      fields: ty.fields.filter((f) => f.required).map((f) => ({ key: f.key, label: label(f.label, locale), required: f.required })),
    })),
  };
}

async function boot() {
  const script = (document.currentScript as HTMLScriptElement | null) ?? document.querySelector<HTMLScriptElement>("script[data-project]");
  const project = script?.dataset.project;
  if (!script || !project) {
    console.warn(`[feedbackkit] widget not started: <script> is missing data-project. See ${DOC}`);
    return;
  }
  const base = script.dataset.base ?? new URL(script.src).origin;
  // Verbose logging for integrators: <script … data-debug> or ?fkdebug=1.
  const debug: (...a: unknown[]) => void = script.dataset.debug != null || /[?&]fkdebug=1\b/.test(location.search) ? (...a) => console.info("[feedbackkit]", ...a) : () => {};
  debug("booting", { project, base, release: RELEASE });
  const api = new Api(base, project);

  const cfg = await api.config();
  if (!cfg) {
    console.warn(`[feedbackkit] widget disabled: could not load config for project "${project}" from ${base}. Check the project key and that its origin is on the allowlist. See ${DOC}`);
    return;
  }
  if (!cfg.enabled) {
    debug("project disabled");
    return; // operator turned this project off
  }
  debug("config loaded", { types: cfg.types.length, locale: cfg.locale });

  // Auto-context collection. A project can switch the console capture off (its
  // error messages may echo page content); the hook is then never installed.
  const consoleOn = cfg.capture?.console !== false;
  const buffer = consoleOn ? installConsoleBuffer().buffer : createConsoleBuffer(0);
  const screenshotOn = cfg.capture?.screenshot !== "off";
  const gate = cfg.turnstileSiteKey ? new TurnstileGate(cfg.turnstileSiteKey) : null;

  const host = document.createElement("div");
  host.setAttribute("data-feedbackkit", "host");
  host.style.cssText = "all: initial;"; // isolate from page styles; shadow does the rest
  const syncTheme = () => {
    const theme = cfg.appearance?.theme && cfg.appearance.theme !== "auto" ? cfg.appearance.theme : document.documentElement.getAttribute("data-theme");
    if (theme === "dark" || theme === "light") host.setAttribute("data-theme", theme);
    else host.removeAttribute("data-theme"); // CSS prefers-color-scheme fallback
  };
  syncTheme();
  if (cfg.appearance?.accent) host.style.setProperty("--fk-accent", cfg.appearance.accent);
  new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });

  if (!document.querySelector("style[data-feedbackkit-font]")) {
    const fontStyle = document.createElement("style");
    fontStyle.setAttribute("data-feedbackkit-font", "");
    fontStyle.textContent = `@font-face{font-family:"FK Urbanist";src:url("${base}/urbanist.woff2") format("woff2");font-weight:100 900;font-style:normal;font-display:swap}`;
    document.head.appendChild(fontStyle);
  }

  let state: WidgetState = { name: "closed" };
  let feedbackId = "";
  let base1: FeedbackPayload | null = null; // POST-1 payload, reused for POST-2 and for a retry
  let sent = { text: "", type: "" }; // what the user sent with POST-1 (type "" = the gateway decides)
  let attachedKeys: string[] = []; // R2 keys of manually attached files (uploaded on pick)
  let pendingAttachments: Promise<{ status: "uploaded" | "failed" | "limit"; key?: string }>[] = [];
  let shots: Shot[] = []; // the draft's page captures (#91), marked up in place
  let editing = -1; // index of the screenshot open in the annotator
  let bailed = false;
  // Kept in the tab (#170): the draft until the report ends, and the reports sent.
  const DRAFT = `fk-draft:${project}`;
  const SENT = `fk-sent:${project}`;
  const stored = stash(SENT);
  let sentList = (Array.isArray(stored) ? stored : []).filter((e): e is SentEntry => typeof e?.s === "string" && typeof e.t === "number");
  let slowTimer: ReturnType<typeof setTimeout> | undefined;
  let gen = 0; // attempt generation: a stale async result (from a closed/superseded attempt) is ignored

  function resetAttempt() {
    attachedKeys = [];
    pendingAttachments = [];
    feedbackId = "";
    base1 = null;
    sent = { text: "", type: "" };
    bailed = false;
    for (const s of shots) if (s.url) URL.revokeObjectURL(s.url);
    shots = [];
    editing = -1;
    ui.resetDraft();
  }

  // <script … data-trigger="none">: no floating button; the host opens the panel
  // via window.FeedbackKit.open() (own button, or right after a lazy load with
  // data-autoopen).
  const hideTrigger = script.dataset.trigger === "none";
  // <script … data-trigger-media="(min-width: 861px)">: the floating button shows
  // only while the query matches, and follows resizes (#437). Below it the host
  // opens the panel itself, as with data-trigger="none".
  let triggerMedia: MediaQueryList | undefined;
  const mediaQuery = script.dataset.triggerMedia?.trim();
  if (mediaQuery && !hideTrigger && typeof window.matchMedia === "function") {
    const mql = window.matchMedia(mediaQuery);
    // Browsers turn an unparsable query into "not all", which would hide the button for good.
    if (mql.media === "not all" && mediaQuery !== "not all") console.warn(`[feedbackkit] data-trigger-media ignored: "${mediaQuery}" is not a valid media query. See ${DOC}`);
    else triggerMedia = mql;
  }

  // A report starts: fresh from open(), or a draft restored after a page load.
  const begin = (after?: () => void) => {
    gate?.preload();
    const device = collectDeviceInfo(window);
    ui.setContext({
      browser: device.viewport ? `${device.browser} · ${device.viewport.w}×${device.viewport.h}` : device.browser,
      url: location.pathname,
      console: consoleOn,
      consoleErrors: buffer.snapshot().length,
      contextKeys: Object.keys(readHostContext(window.FeedbackKitContext) ?? {}),
    });
    dispatch({ t: "open", type: cfg.autoType ? "" : (cfg.types[0]?.type ?? "") }, after);
  };
  const open = () => {
    if (state.name !== "closed") return ui.restore(); // a minimized report comes back as it was
    resetAttempt();
    begin(() => api.event("opened"));
  };

  const ui = new WidgetUI(shadow, toUIConfig(cfg, script.dataset.label, hideTrigger, triggerMedia), {
    onOpen: open,
    onClose: () => {
      // Closing ends the report (the panel asked first if work was unsent);
      // minimizing is the way to keep it.
      gen++; // abandon any in-flight attempt
      stash(DRAFT, null);
      dispatch({ t: "close" });
    },
    onSubmit: (type, text) => void submit(type, text),
    onSendNow: () => {
      bailed = true;
      dispatch({ t: "sendNow" }, () => api.event("sent_anyway"));
    },
    onComplete: (answer) => void complete(answer),
    onAttach: (file) => {
      const bucket = pendingAttachments;
      const upload = attach(file);
      bucket.push(upload);
      void upload.finally(() => {
        const index = bucket.indexOf(upload);
        if (index >= 0) bucket.splice(index, 1);
      });
      return upload;
    },
    onRetry: () => void retry(),
    onRestart: () => {
      resetAttempt();
      dispatch({ t: "restart" });
    },
    onAddScreenshot: () => void addShot(),
    onEditShot: (i) => void editShot(i),
    onRemoveFile: (key) => {
      const index = attachedKeys.indexOf(key);
      if (index >= 0) attachedKeys.splice(index, 1);
      showShots();
    },
    onRemoveShot: (i) => {
      const [removed] = shots.splice(i, 1);
      if (removed?.url) URL.revokeObjectURL(removed.url);
      showShots();
    },
    onAnnotated: (blob) => {
      const shot = shots[editing];
      editing = -1;
      if (!shot) return;
      if (shot.url) URL.revokeObjectURL(shot.url);
      // The marked-up image replaces the upload; the first file is left without a report.
      Object.assign(shot, { blob, url: URL.createObjectURL(blob), key: undefined });
      upload(shot);
      debug("screenshot annotated", { bytes: blob.size });
      showShots();
    },
  });

  function dispatch(event: Parameters<typeof reduce>[1], after?: () => void) {
    const next = reduce(state, event);
    if (next === state) return;
    const change = visibilityChange(state, next);
    if (next.name === "done" && state.name !== "done") {
      // Sent: into the tab's list, and the draft is gone.
      sentList = [...sentList, { s: next.summary || sent.text.slice(0, 200), k: next.type, t: Date.now(), id: next.id, u: next.issueUrl }].slice(-20);
      stash(SENT, sentList);
      stash(DRAFT, null);
      ui.setSent(sentList);
    }
    state = next;
    debug("state →", state.name);
    // Tell the host before the panel renders, so a page that hides its content
    // while the panel is open does so before the first screenshot can be taken.
    // Every way the panel opens or closes passes here, and only on a real change.
    if (change) window.dispatchEvent(new CustomEvent(`feedbackkit:${change}`));
    ui.render(state);
    after?.();
  }

  function clearSlow() {
    if (slowTimer) clearTimeout(slowTimer);
    slowTimer = undefined;
  }

  const MAX_SHOTS = 4; // with manual images, at most 5 attachments in total (contract cap)
  function showShots() {
    ui.setShots(
      shots.map((s) => ({ url: s.url, page: s.page.replace(/^[a-z]+:\/\/[^/]+/i, "") || "/" })),
      shots.length < MAX_SHOTS && shots.length + attachedKeys.length + pendingAttachments.length < 5,
    );
  }

  /** Upload a screenshot now (#170), so the draft survives a page load as a key. */
  function upload(shot: Shot) {
    if (!feedbackId) feedbackId = uuid();
    const up: Promise<unknown> = (shot.up = api.uploadScreenshot(feedbackId, shot.blob!).then((key) => {
      if (shot.up === up) shot.key = key; // a later markup replaced this upload
    }));
  }

  // "Screenshot" (#91): capture the visible page now and add it to the draft; its
  // thumbnail opens it in the annotator (#54). 6s box: the user asked and is watching.
  // Failure shows a hint — feedback itself is never blocked on a capture.
  async function addShot() {
    if (!screenshotOn) return;
    const myGen = gen;
    const page = redactPageUrl(location.href); // the page it shows, origin and path only
    const t0 = Date.now();
    ui.captureStarted();
    const shot = await Promise.race([captureScreenshot({ skip: host, maxWidth: 1600, viewport: true }), new Promise<null>((r) => setTimeout(() => r(null), 6000))]);
    debug("capture", { ms: Date.now() - t0, ok: !!shot, bytes: shot?.size ?? 0 });
    ui.captureDone();
    if (myGen !== gen || state.name !== "form") return showShots(); // closed while capturing
    if (!shot) return ui.captureFailed();
    const added: Shot = { blob: shot, url: URL.createObjectURL(shot), page };
    shots.push(added);
    upload(added);
    showShots();
  }

  async function editShot(i: number) {
    const shot = shots[i];
    if (!shot?.url) return; // restored after a page load: the image stayed on the other page
    const img = new Image();
    img.src = shot.url;
    try {
      await img.decode();
    } catch {
      return ui.captureFailed();
    }
    if (state.name !== "form") return;
    editing = i;
    ui.openAnnotator(img);
  }

  function startSlow(myGen: number) {
    clearSlow();
    slowTimer = setTimeout(() => {
      if (myGen === gen) dispatch({ t: "slowHint" });
    }, 4000);
  }

  /** What a retry of this leg resends (null until POST-1's payload exists). */
  function snapshot(leg: 1 | 2, answer?: string, extracted?: Record<string, string>): RetrySnapshot | undefined {
    if (!base1) return undefined;
    return { leg, feedbackId: base1.feedbackId, text: sent.text, type: sent.type, attachmentKeys: [...base1.attachmentKeys], ...(leg === 2 ? { answer: answer ?? "", extracted: { ...(extracted ?? {}) } } : {}) };
  }

  const failure = (error: string): FeedbackResponse => ({ v: 1, status: "error", error });

  async function submit(type: string, text: string) {
    const myGen = ++gen; // this attempt's token; a later submit/close bumps gen and invalidates us
    bailed = false;
    dispatch({ t: "submit" }, () => api.event("submitted"));
    if (state.name !== "extracting") return;
    startSlow(myGen);

    try {
      // Turnstile (if enabled) runs alongside the capture; awaited before the POST.
      const tokenP = gate?.token();
      if (!feedbackId) feedbackId = uuid(); // reuse the id a pre-submit attach already created
      // A user can click Send while an attachment upload is still in flight.
      // Wait for those uploads so the visible chip cannot be silently omitted.
      await Promise.allSettled([...pendingAttachments]);
      if (myGen !== gen) return;
      const attachmentKeys: string[] = [];
      // The draft's screenshots go first, in order, so the worker's vision input
      // (attachment 0) is a page capture. Manual evidence follows in upload order.
      for (const shot of screenshotOn ? shots : []) {
        await shot.up; // uploaded on capture; a failed upload gets one more try
        const key = shot.key ?? (shot.blob ? await api.uploadScreenshot(feedbackId, shot.blob) : null);
        if (myGen !== gen) return; // superseded/closed while uploading
        if (key) attachmentKeys.push(key);
      }
      attachmentKeys.push(...attachedKeys);
      sent = { text, type };
      base1 = {
        v: 1,
        feedbackId,
        ...(type ? { type } : {}), // absent → the gateway classifies (autoType)
        message: text,
        pageUrl: redactPageUrl(location.href), // origin + path only: queries/fragments carry tokens
        attachmentKeys: attachmentKeys.slice(0, 5), // contract cap
        deviceInfo: collectDeviceInfo(window),
        consoleErrors: buffer.snapshot(),
        hpField: "",
      };
      const context = readHostContext(window.FeedbackKitContext);
      if (context) base1.context = context;
      await post1(myGen, tokenP);
    } catch (e) {
      if (myGen !== gen) return;
      clearSlow();
      console.warn(`[feedbackkit] submit failed: ${(e as Error).message}`);
      dispatch({ t: "response", res: failure("submit failed"), retry: snapshot(1) });
    }
  }

  /** POST-1 with the stored payload: the first send, or a retry of it. */
  async function post1(myGen: number, tokenP?: Promise<string | undefined>) {
    if (!base1) return;
    const turnstileToken = await (tokenP ?? gate?.token());
    if (myGen !== gen) return;
    const res = await api.submit({ ...base1, turnstileToken });
    if (myGen !== gen) return;
    clearSlow();
    if (res.status === "follow_up") {
      base1.summary = res.summary;
      if (res.type) base1.type = res.type; // POST-2 completes the type the gateway chose
      if (!sent.type) base1.autoTyped = true; // …and lets the answer settle it
      api.event("need_fields");
      // User pre-chose "send now": skip the question, but keep POST-1's extraction.
      if (bailed) return complete("", res.extracted);
    }
    dispatch({ t: "response", res, retry: snapshot(1) });
  }

  async function complete(answer: string, extractedOverride?: Record<string, string>) {
    if (!base1) return;
    const echoed = extractedOverride ?? (state.name === "asking" ? state.extracted : {}); // what POST-1 already understood
    dispatch({ t: "answer" }, () => api.event("completed"));
    await post2(gen, answer, echoed); // stay bound to the current attempt (complete() doesn't start a new one)
  }

  /** POST-2 (the follow-up answer): the first send, or a retry of it. */
  async function post2(myGen: number, answer: string, echoed: Record<string, string>) {
    if (!base1) return;
    let res: FeedbackResponse;
    try {
      const turnstileToken = gate ? await gate.token() : undefined; // tokens are single-use: fresh one per POST
      if (myGen !== gen) return;
      res = await api.submit({ ...base1, followUpText: answer, extracted: echoed, turnstileToken });
    } catch (e) {
      console.warn(`[feedbackkit] submit failed: ${(e as Error).message}`);
      res = failure("submit failed");
    }
    if (myGen !== gen) return; // closed/superseded while POST-2 in flight
    dispatch({ t: "response", res, retry: snapshot(2, answer, echoed) });
  }

  /** Resend the failed leg with the same id, text and uploaded keys (#108):
   * no reset, no second upload, a fresh Turnstile token. */
  async function retry() {
    if (state.name !== "failed") return;
    const snap = state.retry;
    if (!snap || !base1 || base1.feedbackId !== snap.feedbackId) {
      resetAttempt(); // nothing was sent: start over with an empty form
      return dispatch({ t: "retry" });
    }
    const myGen = ++gen;
    dispatch({ t: "retry" });
    if (snap.leg === 2) return post2(myGen, snap.answer ?? "", snap.extracted ?? {});
    bailed = false;
    startSlow(myGen);
    try {
      await post1(myGen);
    } catch (e) {
      if (myGen !== gen) return;
      clearSlow();
      console.warn(`[feedbackkit] submit failed: ${(e as Error).message}`);
      dispatch({ t: "response", res: failure("submit failed"), retry: snap });
    }
  }

  // Manual file attach (picked in the form) → upload now, key rides along on submit.
  async function attach(file: File): Promise<{ status: "uploaded" | "failed" | "limit"; key?: string }> {
    if (attachedKeys.length + pendingAttachments.length + shots.length >= 5) return { status: "limit" }; // contract cap: 5 attachments
    if (!feedbackId) feedbackId = uuid();
    const bucket = attachedKeys; // capture: a close→reopen (resetAttempt) rebinds attachedKeys,
    const key = await api.uploadScreenshot(feedbackId, file, "upload"); // so a stale upload lands in the OLD bucket, not the new session
    if (key) bucket.push(key);
    showShots(); // the screenshot button's cap depends on the attachment count
    return key ? { status: "uploaded", key } : { status: "failed" };
  }

  ui.render(state);
  ui.setSent(sentList);

  // A full page load keeps the draft in the tab: text, report id and upload keys.
  addEventListener("pagehide", () => {
    if (state.name === "form" && (ui.text.trim() || shots.length || attachedKeys.length)) {
      if (!feedbackId) feedbackId = uuid();
      stash(DRAFT, { id: feedbackId, text: ui.text, shots: shots.filter((s) => s.key).map((s) => ({ k: s.key, p: s.page })), files: attachedKeys });
    } else stash(DRAFT, null);
  });
  const saved = stash(DRAFT) as { id?: string; text?: string; shots?: { k: string; p: string }[]; files?: string[] } | null;
  if (saved?.id) {
    // Back minimized. This page has not heard the report start, so
    // feedbackkit:open fires once; the funnel already counted the open.
    feedbackId = saved.id;
    shots = (saved.shots ?? []).slice(0, MAX_SHOTS).map((s) => ({ key: s.k, page: s.p }));
    attachedKeys = (saved.files ?? []).slice(0, 5 - shots.length);
    ui.text = saved.text ?? "";
    ui.addFileKeys(attachedKeys);
    showShots();
    ui.min = true;
    begin();
  }

  window.FeedbackKit = { open, version: RELEASE };
  if (script.dataset.autoopen != null) open();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void boot());
  else void boot();
}
