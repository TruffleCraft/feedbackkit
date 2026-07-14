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
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });

  let state: WidgetState = { name: "closed" };
  let feedbackId = "";
  let base1: FeedbackPayload | null = null; // POST-1 payload, reused for POST-2
  let attachedKeys: string[] = []; // R2 keys of manually attached files (uploaded on pick)
  let bailed = false;
  let slowTimer: ReturnType<typeof setTimeout> | undefined;
  let gen = 0; // attempt generation: a stale async result (from a closed/superseded attempt) is ignored

  function resetAttempt() {
    attachedKeys = [];
    feedbackId = "";
    base1 = null;
    bailed = false;
  }

  const ui = new WidgetUI(shadow, toUIConfig(cfg, script.dataset.label), {
    onOpen: () => {
      resetAttempt();
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
    onAttach: (file) => void attach(file),
    onRetry: () => {
      resetAttempt();
      dispatch({ t: "retry" });
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
      // Screenshot (opt-out via the form checkbox; best-effort + time-boxed so a
      // slow/hung capture never wedges the send). Manually attached files first.
      const attachmentKeys: string[] = [...attachedKeys];
      if (screenshot) {
        const shot = await Promise.race([captureScreenshot({ skip: host }), new Promise<null>((r) => setTimeout(() => r(null), 3000))]);
        if (myGen !== gen) return; // superseded/closed while capturing
        if (shot) {
          const key = await api.uploadScreenshot(feedbackId, shot);
          if (myGen !== gen) return;
          if (key) attachmentKeys.push(key);
        }
      }
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
        api.event("need_fields");
        if (bailed) return complete(""); // user pre-chose "send now" → skip the question
      }
      dispatch({ t: "response", res });
    } catch (e) {
      if (myGen !== gen) return;
      clearSlow();
      console.warn(`[feedbackkit] submit failed: ${(e as Error).message}`);
      dispatch({ t: "response", res: { v: 1, status: "error", error: "submit failed" } });
    }
  }

  async function complete(answer: string) {
    if (!base1) return;
    const echoed = state.name === "asking" ? state.extracted : {}; // what POST-1 already understood
    const myGen = gen; // stay bound to the current attempt (complete() doesn't start a new one)
    dispatch({ t: "answer" }, () => api.event("completed"));
    const payload: FeedbackPayload = { ...base1, followUpText: answer, extracted: echoed };
    const res = await api.submit(payload);
    if (myGen !== gen) return; // closed/superseded while POST-2 in flight
    dispatch({ t: "response", res });
  }

  // Manual file attach (picked in the form) → upload now, key rides along on submit.
  async function attach(file: File) {
    if (attachedKeys.length >= 4) return; // leave room for the auto-screenshot (cap 5)
    if (!feedbackId) feedbackId = uuid();
    const key = await api.uploadScreenshot(feedbackId, file);
    if (key) attachedKeys.push(key);
  }

  ui.render(state);
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void boot());
  else void boot();
}
