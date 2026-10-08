import { reduce, type WidgetState } from "./core/state.js";
import { createConsoleBuffer, installConsoleBuffer } from "./core/console-buffer.js";
import { collectDeviceInfo } from "./lib/device-info.js";
import { captureScreenshot } from "./lib/screenshot.js";
import { uuid } from "./lib/uuid.js";
import { Api } from "./lib/api.js";
import { readHostContext } from "./lib/host-context.js";
import { TurnstileGate } from "./lib/turnstile.js";
import { WidgetUI, type UIConfig } from "./ui/panel.js";
import type { Locale } from "./ui/i18n.js";
import { redactPageUrl } from "../shared/page-url.js";
import type { PublicConfig, FeedbackPayload } from "../shared/contract.js";

declare global {
  interface Window {
    /** Host-supplied debug context (object, or a function read at submit time). */
    FeedbackKitContext?: unknown;
    /** Set by the widget once booted: open the panel from the host's own UI. */
    FeedbackKit?: { open(): void; version: string };
  }
}

const DOC = "https://github.com/TruffleCraft/feedbackkit#readme";
// Release of this bundle (ADR-013), injected by scripts/build-widget.mjs.
declare const __FK_RELEASE__: string;
const RELEASE = typeof __FK_RELEASE__ === "string" ? __FK_RELEASE__ : "0.0.0-local";

type Label = string | Record<string, string>;
function label(l: Label, locale: string): string {
  return typeof l === "string" ? l : (l[locale] ?? Object.values(l)[0] ?? "");
}

function toUIConfig(cfg: PublicConfig, triggerLabel: string | undefined, hideTrigger: boolean): UIConfig {
  const locale = (cfg.locale === "de" ? "de" : "en") as Locale;
  // https-only: a server value never goes into an href unchecked.
  const privacyUrl = cfg.privacyUrl && /^https:\/\//i.test(cfg.privacyUrl) ? cfg.privacyUrl : undefined;
  return {
    locale,
    triggerLabel,
    hideTrigger,
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
    const theme = document.documentElement.getAttribute("data-theme");
    if (theme === "dark" || theme === "light") host.setAttribute("data-theme", theme);
    else host.removeAttribute("data-theme"); // CSS prefers-color-scheme fallback
  };
  syncTheme();
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
  let base1: FeedbackPayload | null = null; // POST-1 payload, reused for POST-2
  let attachedKeys: string[] = []; // R2 keys of manually attached files (uploaded on pick)
  let pendingAttachments: Promise<{ status: "uploaded" | "failed" | "limit"; key?: string }>[] = [];
  let shots: { blob: Blob; url: string }[] = []; // the draft's page captures (#91), marked up in place
  let editing = -1; // index of the screenshot open in the annotator
  let draft = false; // closed from the form: the next open shows the same text and media
  let bailed = false;
  let slowTimer: ReturnType<typeof setTimeout> | undefined;
  let gen = 0; // attempt generation: a stale async result (from a closed/superseded attempt) is ignored

  function resetAttempt() {
    attachedKeys = [];
    pendingAttachments = [];
    feedbackId = "";
    base1 = null;
    bailed = false;
    for (const s of shots) URL.revokeObjectURL(s.url);
    shots = [];
    editing = -1;
    ui.resetDraft();
  }

  // <script … data-trigger="none">: no floating button; the host opens the panel
  // via window.FeedbackKit.open() (own button, or right after a lazy load with
  // data-autoopen).
  const hideTrigger = script.dataset.trigger === "none";

  const open = () => {
    if (state.name !== "closed") return;
    if (draft) showShots(); // resync the screenshot button (a capture may have been cut off by the close)
    else resetAttempt();
    draft = false;
    gate?.preload();
    const device = collectDeviceInfo(window);
    ui.setContext({
      browser: device.viewport ? `${device.browser} · ${device.viewport.w}×${device.viewport.h}` : device.browser,
      url: location.pathname,
      console: consoleOn,
      consoleErrors: buffer.snapshot().length,
      contextKeys: Object.keys(readHostContext(window.FeedbackKitContext) ?? {}),
    });
    dispatch({ t: "open", type: cfg.autoType ? "" : (cfg.types[0]?.type ?? "") }, () => api.event("opened"));
  };

  const ui = new WidgetUI(shadow, toUIConfig(cfg, script.dataset.label, hideTrigger), {
    onOpen: open,
    onClose: () => {
      draft = state.name === "form"; // closing before sending keeps the draft (scroll, then add another screenshot)
      gen++; // abandon any in-flight attempt
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
    onRetry: () => {
      resetAttempt();
      dispatch({ t: "retry" });
    },
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
      if (removed) URL.revokeObjectURL(removed.url);
      showShots();
    },
    onAnnotated: (blob) => {
      const shot = shots[editing];
      editing = -1;
      if (!shot) return;
      URL.revokeObjectURL(shot.url);
      Object.assign(shot, { blob, url: URL.createObjectURL(blob) });
      debug("screenshot annotated", { bytes: blob.size });
      showShots();
    },
  });

  function dispatch(event: Parameters<typeof reduce>[1], after?: () => void) {
    const next = reduce(state, event);
    if (next === state) return;
    state = next;
    debug("state →", state.name);
    ui.render(state);
    after?.();
  }

  function clearSlow() {
    if (slowTimer) clearTimeout(slowTimer);
    slowTimer = undefined;
  }

  const MAX_SHOTS = 4; // with manual images, at most 5 attachments in total (contract cap)
  function showShots() {
    ui.setShots(shots.map((s) => s.url), shots.length < MAX_SHOTS && shots.length + attachedKeys.length + pendingAttachments.length < 5);
  }

  // "Screenshot" (#91): capture the visible page now and add it to the draft; its
  // thumbnail opens it in the annotator (#54). 6s box: the user asked and is watching.
  // Failure shows a hint — feedback itself is never blocked on a capture.
  async function addShot() {
    if (!screenshotOn) return;
    const myGen = gen;
    const t0 = Date.now();
    ui.captureStarted();
    const shot = await Promise.race([captureScreenshot({ skip: host, maxWidth: 1600, viewport: true }), new Promise<null>((r) => setTimeout(() => r(null), 6000))]);
    debug("capture", { ms: Date.now() - t0, ok: !!shot, bytes: shot?.size ?? 0 });
    ui.captureDone();
    if (myGen !== gen || state.name !== "form") return showShots(); // closed while capturing
    if (!shot) return ui.captureFailed();
    shots.push({ blob: shot, url: URL.createObjectURL(shot) });
    showShots();
  }

  async function editShot(i: number) {
    const shot = shots[i];
    if (!shot) return;
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

  async function submit(type: string, text: string) {
    const myGen = ++gen; // this attempt's token; a later submit/close bumps gen and invalidates us
    bailed = false;
    dispatch({ t: "submit" }, () => api.event("submitted"));
    if (state.name !== "extracting") return;
    slowTimer = setTimeout(() => {
      if (myGen === gen) dispatch({ t: "slowHint" });
    }, 4000);

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
        const key = await api.uploadScreenshot(feedbackId, shot.blob);
        if (myGen !== gen) return; // superseded/closed while uploading
        if (key) attachmentKeys.push(key);
      }
      attachmentKeys.push(...attachedKeys);
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
      const turnstileToken = await tokenP;
      if (myGen !== gen) return;
      const res = await api.submit({ ...base1, turnstileToken });
      if (myGen !== gen) return;
      clearSlow();
      if (res.status === "follow_up") {
        base1.summary = res.summary;
        if (res.type) base1.type = res.type; // POST-2 completes the type the gateway chose
        if (!type) base1.autoTyped = true; // …and lets the answer settle it
        api.event("need_fields");
        // User pre-chose "send now": skip the question, but keep POST-1's extraction.
        if (bailed) return complete("", res.extracted);
      }
      dispatch({ t: "response", res });
    } catch (e) {
      if (myGen !== gen) return;
      clearSlow();
      console.warn(`[feedbackkit] submit failed: ${(e as Error).message}`);
      dispatch({ t: "response", res: { v: 1, status: "error", error: "submit failed" } });
    }
  }

  async function complete(answer: string, extractedOverride?: Record<string, string>) {
    if (!base1) return;
    const echoed = extractedOverride ?? (state.name === "asking" ? state.extracted : {}); // what POST-1 already understood
    const myGen = gen; // stay bound to the current attempt (complete() doesn't start a new one)
    dispatch({ t: "answer" }, () => api.event("completed"));
    const turnstileToken = gate ? await gate.token() : undefined; // tokens are single-use: fresh one for POST-2
    if (myGen !== gen) return;
    const payload: FeedbackPayload = { ...base1, followUpText: answer, extracted: echoed, turnstileToken };
    const res = await api.submit(payload);
    if (myGen !== gen) return; // closed/superseded while POST-2 in flight
    dispatch({ t: "response", res });
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

  window.FeedbackKit = { open, version: RELEASE };
  if (script.dataset.autoopen != null) open();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void boot());
  else void boot();
}
