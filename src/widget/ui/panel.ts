import type { WidgetState } from "../core/state.js";
import { STYLES } from "./styles.js";
import { AnnotatorUI } from "./annotate.js";
import { t, type Locale } from "./i18n.js";

// Shadow-DOM view. Built ONCE; render() toggles view visibility and patches text
// (never innerHTML-replaces a subtree carrying user input — the re-render ban).
// Implements the four vanilla invariants: shadowRoot focus + restore, one
// persistent aria-live region, body-append + dvh + scroll-lock, no re-render.
// Follow-up is a SINGLE conversational question (state `asking`), not a form.

export interface UIField {
  key: string;
  label: string;
  required: boolean;
}
export interface UIType {
  type: string;
  label: string;
  guidance?: string; // inline "what's needed" hint, shown under the type selector
  fields: UIField[];
}
export interface UIConfig {
  locale: Locale;
  triggerLabel?: string;
  types: UIType[];
}
export interface UIHandlers {
  onOpen(): void;
  onClose(): void;
  onSubmit(type: string, text: string, screenshot: boolean): void;
  onSendNow(): void;
  onComplete(type: string, answer: string): void;
  onAttach(file: File): Promise<"uploaded" | "failed" | "limit">;
  onRetry(): void;
  onRestart(): void;
  /** "Mark up screenshot" clicked → index captures the page, then calls openAnnotator(). */
  onEditScreenshot(): void;
  /** Annotator finished → index uses this blob at submit instead of a fresh capture. */
  onAnnotated(blob: Blob): void;
}

export interface UIContext {
  browser?: string;
  url?: string;
  consoleErrors?: number;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, kids: Node[] = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const k of kids) node.appendChild(k);
  return node;
}

export class WidgetUI {
  private trigger!: HTMLButtonElement;
  private backdrop!: HTMLDivElement;
  private title!: HTMLHeadingElement;
  private live!: HTMLDivElement;
  private views: Record<string, HTMLElement> = {};
  private typeButtons: HTMLButtonElement[] = [];
  private guidanceEl!: HTMLParagraphElement;
  private textarea!: HTMLTextAreaElement;
  private attachInput!: HTMLInputElement;
  private questionEl!: HTMLParagraphElement;
  private answerBox!: HTMLTextAreaElement;
  private sendNowBtn!: HTMLButtonElement;
  private statusText!: HTMLSpanElement;
  private issueLink!: HTMLAnchorElement;
  private doneMsg!: HTMLParagraphElement;
  private panel!: HTMLDivElement;
  private annotator!: AnnotatorUI;
  private shotChip!: HTMLSpanElement;
  private shotLabelEl!: HTMLSpanElement;
  private shotMarkupBtn!: HTMLButtonElement;
  private shotToggleBtn!: HTMLButtonElement;
  private ctxBrowserChip!: HTMLSpanElement;
  private ctxUrlChip!: HTMLSpanElement;
  private ctxConsoleChip!: HTMLSpanElement;
  private fileChips!: HTMLDivElement;
  private mediaHint!: HTMLParagraphElement;
  private shotEnabled = true;
  private annotatorReturnFocus: HTMLElement | null = null;
  private scrollLock = "";
  private locked = false;
  private hasOpened = false;
  private activeType = "";

  constructor(
    private shadow: ShadowRoot,
    private config: UIConfig,
    private h: UIHandlers,
  ) {
    this.build();
  }

  private tr(k: Parameters<typeof t>[1]) {
    return t(this.config.locale, k);
  }

  private build() {
    this.shadow.appendChild(el("style", { textContent: STYLES }));

    // Expanding pill trigger: icon disc + label revealed on hover/focus.
    const triggerLabel = this.config.triggerLabel || this.tr("trigger");
    const icon = el("span", { className: "fk-trigger-icon", textContent: "✦" });
    const label = el("span", { className: "fk-trigger-label", textContent: triggerLabel });
    this.trigger = el("button", { className: "fk-trigger", type: "button", ariaLabel: triggerLabel }, [icon, label]);
    this.trigger.setAttribute("aria-haspopup", "dialog");
    this.trigger.addEventListener("click", () => this.h.onOpen());

    // One persistent, always-mounted live region (conditional rendering swallows announcements).
    this.live = el("div", { className: "fk-sr" });
    this.live.setAttribute("aria-live", "polite");
    this.live.setAttribute("role", "status");

    this.title = el("h2", { className: "fk-title", id: "fk-title", textContent: this.tr("title") });
    const closeBtn = el("button", { className: "fk-x", type: "button", textContent: "×", ariaLabel: this.tr("close") });
    closeBtn.addEventListener("click", () => this.h.onClose());
    const head = el("div", { className: "fk-head" }, [this.title, closeBtn]);

    this.panel = el("div", { className: "fk-panel", role: "dialog" }, [head, this.buildForm(), this.buildExtracting(), this.buildAsking(), this.buildDone(), this.buildFailed()]);
    this.panel.setAttribute("aria-modal", "true");
    this.panel.setAttribute("aria-labelledby", "fk-title");
    this.panel.addEventListener("click", (e) => e.stopPropagation());

    this.backdrop = el("div", { className: "fk-backdrop", hidden: true }, [this.panel]);
    this.backdrop.addEventListener("click", () => this.h.onClose()); // click outside = close
    this.backdrop.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Escape") this.h.onClose();
    });

    this.buildAnnotate();
    this.shadow.append(this.trigger, this.backdrop, this.annotator.root, this.live);
  }

  private buildForm(): HTMLElement {
    const types = el("div", { className: "fk-tabs" });
    this.config.types.forEach((ty, i) => {
      const b = el("button", { className: "fk-type", type: "button", textContent: ty.label });
      b.setAttribute("aria-pressed", String(i === 0));
      b.addEventListener("click", () => this.selectType(ty.type));
      this.typeButtons.push(b);
      types.appendChild(b);
    });
    this.activeType = this.config.types[0]?.type ?? "";

    // Inline guidance for the active type ("what a good report needs"). Empty →
    // hidden, so types without guidance render exactly as before.
    this.guidanceEl = el("p", { className: "fk-guidance" });

    const label = el("label", { className: "fk-label", htmlFor: "fk-text", textContent: this.tr("textLabel") });
    this.textarea = el("textarea", { className: "fk-input", id: "fk-text", placeholder: this.tr("textPlaceholder") });

    this.shotChip = this.buildShotChip();
    this.ctxConsoleChip = el("span", { className: "fk-chip readonly", hidden: true });
    this.ctxBrowserChip = el("span", { className: "fk-chip readonly", hidden: true });
    this.ctxUrlChip = el("span", { className: "fk-chip readonly", hidden: true });
    const contextChips = el("div", { className: "fk-chips fk-context" }, [this.ctxConsoleChip, this.ctxBrowserChip, this.ctxUrlChip]);

    this.attachInput = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", hidden: true, id: "fk-file", multiple: true });
    this.attachInput.addEventListener("change", () => {
      this.acceptFiles(this.attachInput.files);
      this.attachInput.value = "";
    });
    const addImages = el("button", { className: "fk-media-add", type: "button", textContent: this.tr("addImages") });
    addImages.addEventListener("click", () => this.attachInput.click());
    this.fileChips = el("div", { className: "fk-chips fk-files" });
    const media = el("div", { className: "fk-media" }, [
      el("div", { className: "fk-media-head" }, [this.shotChip, addImages]),
      el("div", { className: "fk-drop-t" }, [el("b", { textContent: this.tr("dropTitleAccent") }), el("span", { textContent: this.tr("dropTitle") })]),
      el("div", { className: "fk-drop-s", textContent: this.tr("dropSub") }),
      this.fileChips,
      this.attachInput,
    ]);
    for (const event of ["dragenter", "dragover"]) media.addEventListener(event, (e) => { e.preventDefault(); media.classList.add("fk-dragover"); });
    for (const event of ["dragleave", "dragend"]) media.addEventListener(event, () => media.classList.remove("fk-dragover"));
    media.addEventListener("drop", (e) => {
      e.preventDefault();
      media.classList.remove("fk-dragover");
      this.acceptFiles((e as DragEvent).dataTransfer?.files);
    });
    this.mediaHint = el("p", { className: "fk-hint", hidden: true });
    const attachments = el("div", { className: "fk-attach" }, [contextChips, media, this.mediaHint]);

    const send = el("button", { className: "fk-btn", type: "button", textContent: this.tr("send") });
    send.addEventListener("click", () => this.h.onSubmit(this.activeType, this.textarea.value.trim(), this.shotEnabled));
    const foot = el("div", { className: "fk-foot" }, [el("span", { className: "fk-privacy", textContent: this.tr("privacy") }), send]);
    const view = el("div", { className: "fk-form" }, [types, this.guidanceEl, label, this.textarea, attachments, foot]);
    this.views["form"] = view;
    this.applyGuidance();
    return view;
  }

  private buildShotChip(): HTMLSpanElement {
    this.shotLabelEl = el("span", { className: "txt", textContent: this.tr("screenshotChip") });
    this.shotMarkupBtn = el("button", { className: "act", type: "button", textContent: this.tr("editShot"), title: this.tr("editShot") });
    this.shotMarkupBtn.setAttribute("aria-label", this.tr("editShot"));
    this.shotMarkupBtn.addEventListener("click", () => this.h.onEditScreenshot());
    this.shotToggleBtn = el("button", { className: "act icon", type: "button", textContent: "×", title: this.tr("removeShot") });
    this.shotToggleBtn.setAttribute("aria-label", this.tr("removeShot"));
    this.shotToggleBtn.addEventListener("click", () => this.toggleShot(this.shotToggleBtn));
    return el("span", { className: "fk-chip shot" }, [this.shotLabelEl, this.shotMarkupBtn, this.shotToggleBtn]);
  }

  private toggleShot(toggle: HTMLButtonElement) {
    this.shotEnabled = !this.shotEnabled;
    this.shotChip.classList.toggle("off", !this.shotEnabled);
    this.shotMarkupBtn.disabled = !this.shotEnabled;
    toggle.textContent = this.shotEnabled ? "×" : "+";
    const label = this.shotEnabled ? this.tr("removeShot") : this.tr("restoreShot");
    toggle.setAttribute("aria-label", label);
    toggle.title = label;
  }

  private acceptFiles(files: FileList | undefined | null) {
    for (const file of Array.from(files ?? [])) {
      const chip = el("span", { className: "fk-chip file", textContent: `… ${file.name}` });
      chip.dataset.status = "uploading";
      this.fileChips.appendChild(chip);
      void this.h.onAttach(file).then((status) => {
        chip.dataset.status = status;
        chip.textContent = status === "uploaded"
          ? `✓ ${file.name}`
          : `⚠ ${file.name} · ${this.tr(status === "limit" ? "uploadLimit" : "uploadFailed")}`;
      });
    }
  }

  setContext(ctx: UIContext) {
    this.ctxBrowserChip.hidden = !ctx.browser;
    this.ctxUrlChip.hidden = !ctx.url;
    this.ctxConsoleChip.hidden = !ctx.consoleErrors;
    if (ctx.browser) { this.ctxBrowserChip.textContent = ctx.browser; this.ctxBrowserChip.hidden = false; }
    if (ctx.url) { this.ctxUrlChip.textContent = `Page ${ctx.url}`; this.ctxUrlChip.hidden = false; }
    if (ctx.consoleErrors && ctx.consoleErrors > 0) {
      this.ctxConsoleChip.textContent = `console · ${ctx.consoleErrors}`;
      this.ctxConsoleChip.hidden = false;
    }
  }

  /** Patch the guidance line to the active type's hint (hidden when empty). */
  private applyGuidance() {
    const g = this.config.types.find((ty) => ty.type === this.activeType)?.guidance ?? "";
    this.guidanceEl.textContent = g;
    this.guidanceEl.hidden = !g;
  }

  private buildAnnotate() {
    this.annotator = new AnnotatorUI(this.config.locale, {
      onDone: (blob) => {
        this.shotEnabled = true;
        this.shotChip.classList.remove("off");
        this.shotMarkupBtn.disabled = false;
        this.shotLabelEl.textContent = `${this.tr("screenshotChip")} ${this.tr("shotReady")}`;
        this.closeAnnotator();
        this.h.onAnnotated(blob);
      },
      onCancel: () => this.closeAnnotator(),
    });
    this.annotator.root.hidden = true;
    this.annotator.root.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.closeAnnotator();
      if (e.key === "Tab") {
        const focusable = Array.from(this.annotator.root.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'));
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = this.shadow.activeElement;
        if (e.shiftKey && active === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && active === last) { e.preventDefault(); first?.focus(); }
      }
    });
  }

  /** Called by index once the page capture is ready. */
  openAnnotator(img: HTMLImageElement) {
    this.mediaHint.hidden = true;
    this.shotMarkupBtn.disabled = false;
    this.shotMarkupBtn.textContent = this.tr("editShot");
    this.panel.setAttribute("inert", "");
    this.backdrop.setAttribute("aria-hidden", "true");
    this.annotator.root.hidden = false;
    this.annotator.load(img);
    this.annotator.focusInitial();
    this.live.textContent = this.tr("annotateHint");
  }

  private closeAnnotator() {
    this.annotator.root.hidden = true;
    this.panel.removeAttribute("inert");
    this.backdrop.removeAttribute("aria-hidden");
    this.annotatorReturnFocus?.focus();
    this.annotatorReturnFocus = null;
  }

  captureStarted() {
    this.annotatorReturnFocus = this.shadow.activeElement as HTMLElement | null;
    this.mediaHint.textContent = this.tr("captureStarted");
    this.mediaHint.hidden = false;
    this.shotMarkupBtn.disabled = true;
    this.shotMarkupBtn.textContent = this.tr("capturing");
  }

  /** Capture failed — tell the user, feedback itself is never blocked. */
  captureFailed() {
    this.mediaHint.textContent = this.tr("captureFailed");
    this.mediaHint.hidden = false;
    this.shotMarkupBtn.disabled = false;
    this.shotMarkupBtn.textContent = this.tr("editShot");
  }

  /** New attempt → clear all transient form and media state without rebuilding DOM. */
  private resetShotUI() {
    this.shotEnabled = true;
    this.shotChip.classList.remove("off");
    this.shotLabelEl.textContent = this.tr("screenshotChip");
    this.shotMarkupBtn.disabled = false;
    this.shotMarkupBtn.textContent = this.tr("editShot");
    this.shotToggleBtn.textContent = "×";
    this.shotToggleBtn.setAttribute("aria-label", this.tr("removeShot"));
    this.shotToggleBtn.title = this.tr("removeShot");
    this.fileChips.replaceChildren();
    this.attachInput.value = "";
    this.mediaHint.hidden = true;
    this.annotator.root.hidden = true;
    this.panel.removeAttribute("inert");
    this.backdrop.removeAttribute("aria-hidden");
  }

  private buildExtracting(): HTMLElement {
    this.sendNowBtn = el("button", { className: "fk-btn fk-ghost", type: "button", textContent: this.tr("sendNow") });
    this.sendNowBtn.addEventListener("click", () => this.h.onSendNow());
    this.statusText = el("span", { textContent: this.tr("analyzing") });
    const view = el("div", { className: "fk-status" }, [el("span", { className: "fk-spinner" }), this.statusText, this.sendNowBtn]);
    this.views["extracting"] = view;
    return view;
  }

  // ONE conversational follow-up question + a single freetext answer (ADR-012).
  private buildAsking(): HTMLElement {
    this.questionEl = el("p", { className: "fk-question", id: "fk-question" });
    this.answerBox = el("textarea", { className: "fk-input", id: "fk-answer", placeholder: this.tr("followUpPlaceholder") });
    this.answerBox.rows = 3;
    const send = el("button", { className: "fk-btn", type: "button", textContent: this.tr("send") });
    send.addEventListener("click", () => this.h.onComplete(this.activeType, this.answerBox.value.trim()));
    const anyway = el("button", { className: "fk-link", type: "button", textContent: this.tr("sendAnyway") });
    anyway.addEventListener("click", () => this.h.onComplete(this.activeType, "")); // skip the answer
    const view = el("div", {}, [this.questionEl, this.answerBox, el("div", { className: "fk-actions" }, [send, anyway])]);
    this.views["asking"] = view;
    return view;
  }

  private buildDone(): HTMLElement {
    this.doneMsg = el("p", { className: "fk-hint" });
    const restart = el("button", { className: "fk-btn fk-ghost", type: "button", textContent: this.tr("sendAnother") });
    restart.addEventListener("click", () => this.h.onRestart());
    this.issueLink = el("a", { className: "fk-btn", textContent: this.tr("viewIssue"), target: "_blank", rel: "noopener noreferrer" });
    const view = el("div", { className: "fk-done" }, [el("div", { className: "fk-done-icon", textContent: "✓" }), el("h3", { className: "fk-title", textContent: this.tr("doneTitle") }), this.doneMsg, el("div", { className: "fk-actions", role: "group" }, [restart, this.issueLink])]);
    this.views["done"] = view;
    return view;
  }

  private buildFailed(): HTMLElement {
    const retry = el("button", { className: "fk-btn", type: "button", textContent: this.tr("retry") });
    retry.addEventListener("click", () => this.h.onRetry());
    const view = el("div", {}, [el("p", { className: "fk-hint", textContent: this.tr("failed") }), el("div", { className: "fk-actions" }, [retry])]);
    this.views["failed"] = view;
    return view;
  }

  private selectType(type: string) {
    this.activeType = type;
    this.config.types.forEach((ty, i) => this.typeButtons[i]?.setAttribute("aria-pressed", String(ty.type === type)));
    this.applyGuidance();
  }

  private show(name: string) {
    for (const [k, v] of Object.entries(this.views)) v.hidden = k !== name;
  }

  private lockScroll(lock: boolean) {
    const root = document.documentElement;
    if (lock) {
      if (this.locked) return; // capture the page's original overflow EXACTLY once
      this.scrollLock = root.style.overflow;
      root.style.overflow = "hidden";
      this.locked = true;
    } else {
      if (!this.locked) return; // never write overflow we didn't set (would wipe the host's)
      root.style.overflow = this.scrollLock;
      this.locked = false;
    }
  }

  render(state: WidgetState) {
    if (state.name === "closed") {
      this.backdrop.hidden = true;
      this.trigger.hidden = false;
      // Only on a genuine close (not the initial mount) do we unlock scroll and
      // restore focus — otherwise we'd steal the host page's initial focus and
      // wipe its inline overflow on every page load.
      if (this.hasOpened) {
        this.lockScroll(false);
        this.trigger.focus();
      }
      return;
    }
    this.hasOpened = true;
    this.trigger.hidden = true;
    this.backdrop.hidden = false;
    this.lockScroll(true);

    switch (state.name) {
      case "form":
        this.show("form");
        this.textarea.value = "";
        this.answerBox.value = "";
        this.selectType(this.config.types[0]?.type ?? "");
        this.resetShotUI(); // "form" is only entered on a fresh attempt (open/retry)
        this.title.textContent = this.tr("title");
        this.live.textContent = this.tr("title");
        this.textarea.focus();
        break;
      case "extracting":
        this.show("extracting");
        // After the 4s slow-hint, skipping the follow-up becomes a primary action.
        this.statusText.textContent = this.tr("analyzing");
        this.sendNowBtn.hidden = false;
        this.sendNowBtn.className = state.sendNow ? "fk-btn" : "fk-btn fk-ghost";
        this.live.textContent = this.tr("analyzing");
        break;
      case "asking":
        this.show("asking");
        this.questionEl.textContent = state.question;
        this.answerBox.value = "";
        this.live.textContent = state.question;
        this.answerBox.focus();
        break;
      case "submitting":
        this.show("extracting");
        this.statusText.textContent = this.tr("finalizing");
        this.sendNowBtn.hidden = true;
        this.live.textContent = this.tr("finalizing");
        break;
      case "done": {
        this.show("done");
        this.doneMsg.textContent = this.tr("doneMsg");
        // Only link an https URL — never trust a server value into href (a
        // javascript: URL would be click-XSS).
        const url = state.issueUrl && /^https:\/\//i.test(state.issueUrl) ? state.issueUrl : "";
        this.issueLink.hidden = !url;
        if (url) this.issueLink.href = url;
        this.live.textContent = this.tr("doneMsg");
        break;
      }
      case "failed":
        this.show("failed");
        this.live.textContent = this.tr("failed");
        break;
    }
  }
}
