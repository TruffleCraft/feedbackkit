import { reduce, type WidgetState } from "./core/state.js";
import { installConsoleBuffer } from "./core/console-buffer.js";
import { collectDeviceInfo } from "./lib/device-info.js";
import { captureScreenshot } from "./lib/screenshot.js";
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
  const api = new Api(base, project);

  const cfg = await api.config();
  if (!cfg) {
    console.warn(`[feedbackkit] widget disabled: could not load config for project "${project}" from ${base}. Check the project key and that its origin is on the allowlist. See ${DOC}`);
    return;
  }
  if (!cfg.enabled) return; // operator turned this project off

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
  let bailed = false;
  let slowTimer: ReturnType<typeof setTimeout> | undefined;

  const ui = new WidgetUI(shadow, toUIConfig(cfg, script.dataset.label), {
    onOpen: () => dispatch({ t: "open", type: cfg.types[0]?.type ?? "" }, () => api.event("opened")),
    onClose: () => dispatch({ t: "close" }),
    onSubmit: (type, text) => submit(type, text),
    onSendNow: () => {
      bailed = true;
      dispatch({ t: "sendNow" }, () => api.event("sent_anyway"));
    },
    onComplete: (_type, values) => complete(values),
    onRetry: () => dispatch({ t: "retry" }),
  });

  function dispatch(event: Parameters<typeof reduce>[1], after?: () => void) {
    const next = reduce(state, event);
    if (next === state) return;
    state = next;
    ui.render(state);
    after?.();
  }

  function clearSlow() {
    if (slowTimer) clearTimeout(slowTimer);
    slowTimer = undefined;
  }

  async function submit(type: string, text: string) {
    bailed = false;
    dispatch({ t: "submit" }, () => api.event("submitted"));
    if (state.name !== "extracting") return;
    slowTimer = setTimeout(() => dispatch({ t: "slowHint" }), 4000);

    feedbackId = crypto.randomUUID();
    // Screenshot (best-effort) → upload → key. Vision is a core input.
    const attachmentKeys: string[] = [];
    const shot = await captureScreenshot({ skip: host });
    if (shot) {
      const key = await api.uploadScreenshot(feedbackId, shot);
      if (key) attachmentKeys.push(key);
    }
    base1 = {
      v: 1,
      feedbackId,
      type,
      message: text,
      pageUrl: location.href,
      attachmentKeys,
      deviceInfo: collectDeviceInfo(window),
      consoleErrors: buffer.snapshot(),
      hpField: "",
    };
    const res = await api.submit(base1);
    clearSlow();
    if (res.status === "need_fields") {
      api.event("need_fields");
      if (bailed) {
        // User already chose "send now" → complete immediately with what we have.
        return complete(res.extracted, res.extracted);
      }
      dispatch({ t: "response", res });
    } else {
      dispatch({ t: "response", res });
    }
  }

  async function complete(values: Record<string, string>, extracted?: Record<string, string>) {
    if (!base1) return;
    dispatch({ t: "completeSubmit" }, () => api.event("completed"));
    // sendNow path arrives here from extracting (state submitting via sendNow) — allow it.
    const payload: FeedbackPayload = { ...base1, fields: values, extracted: extracted ?? values };
    const res = await api.submit(payload);
    dispatch({ t: "response", res });
  }

  ui.render(state);
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void boot());
  else void boot();
}
