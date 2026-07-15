import { reduce, type WidgetState } from "./core/state.js";
import { installConsoleBuffer } from "./core/console-buffer.js";
import { collectDeviceInfo } from "./lib/device-info.js";
import { captureScreenshot } from "./lib/screenshot.js";
import { uuid } from "./lib/uuid.js";
import { Api } from "./lib/api.js";
import { WidgetUI, type UIConfig } from "./ui/panel.js";
import type { Locale } from "./ui/i18n.js";
import type { PublicConfig, FeedbackPayload } from "../shared/contract.js";

const DOC = "https://github.com/TruffleCraft/feedbackkit#readme";

type Label = string | Record<string, string>;
function label(l: Label, locale: string): string {
  return typeof l === "string" ? l : (l[locale] ?? Object.values(l)[0] ?? "");
}

function toUIConfig(cfg: PublicConfig, triggerLabel: string | undefined): UIConfig {
  const locale = (cfg.locale === "de" ? "de" : "en") as Locale;
  return {
    locale,
    triggerLabel,
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
  debug("booting", { project, base });
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

  // Auto-context collection.
  const { buffer } = installConsoleBuffer();

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
    fontStyle.textContent = `@font-face{font-family:"DM Sans";src:url("${base}/dm-sans.woff2") format("woff2");font-weight:100 1000;font-style:normal;font-display:swap}`;
    document.head.appendChild(fontStyle);
  }

  let state: WidgetState = { name: "closed" };
  let feedbackId = "";
  let base1: FeedbackPayload | null = null; // POST-1 payload, reused for POST-2
  let attachedKeys: string[] = []; // R2 keys of manually attached files (uploaded on pick)
  let pendingAttachments: Promise<"uploaded" | "failed" | "limit">[] = [];
  let editedShot: Blob | null = null; // annotated/cropped capture (#54); replaces the submit-time capture
  let editedShotUrl = ""; // object URL backing the annotator's <img>, revoked on reset
  let bailed = false;
  let slowTimer: ReturnType<typeof setTimeout> | undefined;
  let gen = 0; // attempt generation: a stale async result (from a closed/superseded attempt) is ignored

  function resetAttempt() {
    attachedKeys = [];
    pendingAttachments = [];
    feedbackId = "";
    base1 = null;
    bailed = false;
    editedShot = null;
    if (editedShotUrl) URL.revokeObjectURL(editedShotUrl);
    editedShotUrl = "";
  }

  const ui = new WidgetUI(shadow, toUIConfig(cfg, script.dataset.label), {
    onOpen: () => {
      resetAttempt();
      const device = collectDeviceInfo(window);
      ui.setContext({
        browser: device.viewport ? `${device.browser} · ${device.viewport.w}×${device.viewport.h}` : device.browser,
        url: location.pathname,
        consoleErrors: buffer.snapshot().length,
      });
      dispatch({ t: "open", type: cfg.types[0]?.type ?? "" }, () => api.event("opened"));
    },
    onClose: () => {
      gen++; // abandon any in-flight attempt
      dispatch({ t: "close" });
    },
    onSubmit: (type, text, screenshot) => void submit(type, text, screenshot),
    onSendNow: () => {
      bailed = true;
      dispatch({ t: "sendNow" }, () => api.event("sent_anyway"));
    },
    onComplete: (_type, answer) => void complete(answer),
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
    onEditScreenshot: () => void editShot(),
    onAnnotated: (blob) => {
      editedShot = blob;
      debug("screenshot annotated", { bytes: blob.size });
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

  // "Mark up screenshot" (#54): capture now, hand the image to the in-panel
  // annotator. 6s box (not the submit path's 3s — that one must stay under the
  // 4s slowHint; here the user explicitly asked and is watching). Failure shows
  // a hint — feedback itself is never blocked on a capture.
  async function editShot() {
    const myGen = gen;
    const t0 = Date.now();
    ui.captureStarted();
    const shot = await Promise.race([captureScreenshot({ skip: host, maxWidth: 1600, viewport: true }), new Promise<null>((r) => setTimeout(() => r(null), 6000))]);
    debug("edit capture", { ms: Date.now() - t0, ok: !!shot, bytes: shot?.size ?? 0 });
    if (myGen !== gen || state.name !== "form") return; // closed/superseded while capturing
    if (!shot) {
      ui.captureFailed();
      return;
    }
    if (editedShotUrl) URL.revokeObjectURL(editedShotUrl);
    editedShotUrl = URL.createObjectURL(shot);
    const img = new Image();
    img.src = editedShotUrl;
    try {
      await img.decode();
    } catch {
      ui.captureFailed();
      return;
    }
    if (myGen !== gen || state.name !== "form") return;
    ui.openAnnotator(img);
  }

  async function submit(type: string, text: string, screenshot: boolean) {
    const myGen = ++gen; // this attempt's token; a later submit/close bumps gen and invalidates us
    bailed = false;
    dispatch({ t: "submit" }, () => api.event("submitted"));
    if (state.name !== "extracting") return;
    slowTimer = setTimeout(() => {
      if (myGen === gen) dispatch({ t: "slowHint" });
    }, 4000);

    try {
      if (!feedbackId) feedbackId = uuid(); // reuse the id a pre-submit attach already created
      // A user can click Send while an attachment upload is still in flight.
      // Wait for those uploads so the visible chip cannot be silently omitted.
      await Promise.allSettled([...pendingAttachments]);
      if (myGen !== gen) return;
      const attachmentKeys: string[] = [];
      if (screenshot) {
        // An annotated/cropped shot (#54) wins over a fresh capture — what the
        // user marked up is exactly what uploads (and reaches the LLM via #53).
        // Otherwise: time-boxed capture. Now that cacheBust is gone a full-page
        // shot runs ~0.6-1s, so 3s is ample AND deliberately stays UNDER the 4s
        // slowHint: that ordering keeps capture invisible to the "send now"
        // escape hatch. (Raising it past 4s makes slowHint fire mid-capture, so
        // "send now" appears to do nothing while submit() is still blocked here,
        // and widens the close-during-capture drop window.) A page that still
        // can't capture in 3s degrades to no screenshot — feedback itself is
        // never blocked.
        const shot = editedShot ?? (await Promise.race([captureScreenshot({ skip: host, viewport: true }), new Promise<null>((r) => setTimeout(() => r(null), 3000))]));
        if (myGen !== gen) return; // superseded/closed while capturing
        if (shot) {
          const key = await api.uploadScreenshot(feedbackId, shot);
          if (myGen !== gen) return;
          if (key) attachmentKeys.push(key);
        }
      }
      // Keep the page screenshot first: the worker uses attachment 0 as the
      // bounded vision input. Manual evidence still follows in upload order.
      attachmentKeys.push(...attachedKeys);
      base1 = {
        v: 1,
        feedbackId,
        type,
        message: text,
        pageUrl: location.href,
        attachmentKeys: attachmentKeys.slice(0, 5), // contract cap
        deviceInfo: collectDeviceInfo(window),
        consoleErrors: buffer.snapshot(),
        hpField: "",
      };
      const res = await api.submit(base1);
      if (myGen !== gen) return;
      clearSlow();
      if (res.status === "follow_up") {
        base1.summary = res.summary;
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
    const payload: FeedbackPayload = { ...base1, followUpText: answer, extracted: echoed };
    const res = await api.submit(payload);
    if (myGen !== gen) return; // closed/superseded while POST-2 in flight
    dispatch({ t: "response", res });
  }

  // Manual file attach (picked in the form) → upload now, key rides along on submit.
  async function attach(file: File): Promise<"uploaded" | "failed" | "limit"> {
    if (attachedKeys.length + pendingAttachments.length >= 4) return "limit"; // leave room for the auto-screenshot (cap 5)
    if (!feedbackId) feedbackId = uuid();
    const bucket = attachedKeys; // capture: a close→reopen (resetAttempt) rebinds attachedKeys,
    const key = await api.uploadScreenshot(feedbackId, file); // so a stale upload lands in the OLD bucket, not the new session
    if (key) bucket.push(key);
    return key ? "uploaded" : "failed";
  }

  ui.render(state);
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void boot());
  else void boot();
}
