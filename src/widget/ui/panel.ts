import type { WidgetState } from "../core/state.js";
import { STYLES } from "./styles.js";
import { AnnotatorUI } from "./annotate.js";
import { t, type Locale } from "./i18n.js";

// Shadow-DOM view, design "Gespräch": one composer, then a short thread (the
// user's text, how it was understood, ONE follow-up question), then a done card.
// Built ONCE; render() toggles view visibility and patches text (never
// innerHTML-replaces a subtree carrying user input — the re-render ban).
// Implements the four vanilla invariants: shadowRoot focus + restore, one
// persistent aria-live region, body-append + dvh + scroll-lock, no re-render.

export interface UIField {
  key: string;
  label: string;
  required: boolean;
}
export interface UIType {
  type: string;
  label: string;
  guidance?: string; // inline "what's needed" hint, shown under the type picker
  fields: UIField[];
}
export interface UIConfig {
  locale: Locale;
  triggerLabel?: string;
  /** data-trigger="none": no floating button, the host opens the panel itself. */
  hideTrigger?: boolean;
  /** false when the project switched the page capture off (capture.screenshot). */
  screenshot?: boolean;
  /** Host privacy policy, linked from the footer (https only, checked by caller). */
  privacyUrl?: string;
  /** The gateway classifies the feedback itself: no type picker. */
  autoType?: boolean;
  types: UIType[];
}
export interface UIHandlers {
  onOpen(): void;
  onClose(): void;
  /** type is "" when the gateway classifies (autoType). */
  onSubmit(type: string, text: string, screenshot: boolean): void;
  onSendNow(): void;
  onComplete(answer: string): void;
  onAttach(file: File): Promise<"uploaded" | "failed" | "limit">;
  onRetry(): void;
  onRestart(): void;
  /** "Mark up" clicked → index captures the page, then calls openAnnotator(). */
  onEditScreenshot(): void;
  /** Annotator finished → index uses this blob at submit instead of a fresh capture. */
  onAnnotated(blob: Blob): void;
}

export interface UIContext {
  browser?: string;
  url?: string;
  /** Console capture is on; the count is what would be sent now. */
  console?: boolean;
  consoleErrors?: number;
  /** Keys of the host's FeedbackKitContext (values stay out of the UI). */
  contextKeys?: string[];
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, kids: (Node | string)[] = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...kids);
  return node;
}

// Static, trusted SVG markup only (never user input).
// The FeedbackKit mark (two chat lines) for the trigger and the avatar; the panel head uses MARK in brand colours.
const LOGO = '<g fill="currentColor" stroke="none"><rect x="1.5" y="4" width="15" height="7" rx="3.5"/><rect x="7.5" y="13" width="15" height="7" rx="3.5" opacity=".6"/></g>';
const IC = {
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  shot: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  ext: '<path d="M15 3h6v6M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
  logo: LOGO,
};
function icon(name: keyof typeof IC, cls = "fk-ic"): HTMLSpanElement {
  const s = el("span", { className: cls });
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${IC[name]}</svg>`;
  return s;
}
// FeedbackKit mark: two chat lines, the message and the reply.
const MARK = '<svg viewBox="0 0 48 48"><rect x="3" y="8" width="30" height="14" rx="7" fill="#7c3aed"/><rect x="15" y="26" width="30" height="14" rx="7" fill="#a78bfa"/></svg>';

export class WidgetUI {
  private trigger!: HTMLButtonElement;
  private backdrop!: HTMLDivElement;
  private panel!: HTMLDivElement;
  private live!: HTMLDivElement;
  private views: Record<string, HTMLElement> = {};
  private typeButtons: HTMLButtonElement[] = [];
  private guidanceEl!: HTMLParagraphElement;
  private textarea!: HTMLTextAreaElement;
  private attachInput!: HTMLInputElement;
  private fileChips!: HTMLDivElement;
  private mediaHint!: HTMLParagraphElement;
  private shotBtn!: HTMLButtonElement;
  private shotLabelEl!: HTMLSpanElement;
  private shotMarkupBtn!: HTMLButtonElement;
  private discloseBtn!: HTMLButtonElement;
  private sentList!: HTMLUListElement;
  private sentShotLi!: HTMLLIElement;
  // thread view
  private meBubble!: HTMLDivElement;
  private botRow!: HTMLDivElement;
  private statusText!: HTMLSpanElement;
  private typeTag!: HTMLSpanElement;
  private questionEl!: HTMLParagraphElement;
  private answerWrap!: HTMLDivElement;
  private answerBox!: HTMLInputElement;
  private askFoot!: HTMLDivElement;
  private sendNowBtn!: HTMLButtonElement;
  // done view
  private card!: HTMLDivElement;
  private summaryEl!: HTMLParagraphElement;
  private doneTag!: HTMLSpanElement;
  private issueLink!: HTMLAnchorElement;
  private annotator!: AnnotatorUI;
  private shotOn = false; // opt-in: the page is only captured when the user asks for it
  private annotatorReturnFocus: HTMLElement | null = null;
  private hostReturnFocus: HTMLElement | null = null; // focus to restore when there is no trigger
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

  private get shotAllowed() {
    return this.config.screenshot !== false;
  }

  /** A type picker only when the user must choose (no auto-typing, several types). */
  private get showTypes() {
    return !this.config.autoType && this.config.types.length > 1;
  }

  private typeLabel(type?: string) {
    return this.config.types.find((ty) => ty.type === type)?.label ?? "";
  }

  private build() {
    this.shadow.appendChild(el("style", { textContent: STYLES }));

    const triggerLabel = this.config.triggerLabel || this.tr("trigger");
    this.trigger = el("button", { className: "fk-trigger", type: "button", ariaLabel: triggerLabel }, [icon("logo", "fk-trigger-icon"), el("span", { className: "fk-trigger-label", textContent: triggerLabel })]);
    this.trigger.setAttribute("aria-haspopup", "dialog");
    this.trigger.addEventListener("click", () => this.h.onOpen());

    // One persistent, always-mounted live region (conditional rendering swallows announcements).
    this.live = el("div", { className: "fk-sr" });
    this.live.setAttribute("aria-live", "polite");
    this.live.setAttribute("role", "status");

    const mark = el("span", { className: "fk-mark" });
    mark.setAttribute("aria-hidden", "true");
    mark.innerHTML = MARK;
    const closeBtn = el("button", { className: "fk-x", type: "button", ariaLabel: this.tr("close") }, [icon("close")]);
    closeBtn.addEventListener("click", () => this.h.onClose());
    const head = el("div", { className: "fk-head" }, [mark, el("span", { className: "fk-brand", id: "fk-title", textContent: this.tr("title") }), closeBtn]);

    this.panel = el("div", { className: "fk-panel", role: "dialog" }, [head, this.buildForm(), this.buildThread(), this.buildDone(), this.buildFailed()]);
    this.panel.setAttribute("aria-modal", "true");
    this.panel.setAttribute("aria-labelledby", "fk-title");
    this.panel.addEventListener("click", (e) => e.stopPropagation());

    this.backdrop = el("div", { className: "fk-backdrop", hidden: true }, [this.panel]);
    this.backdrop.addEventListener("click", () => this.h.onClose()); // click outside = close
    this.backdrop.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Escape") this.h.onClose();
    });

    this.buildAnnotate();
    this.trigger.hidden = !!this.config.hideTrigger;
    this.shadow.append(this.trigger, this.backdrop, this.annotator.root, this.live);
  }

  private submit() {
    const text = this.textarea.value.trim();
    if (!text) return this.textarea.focus(); // nothing to send yet
    this.h.onSubmit(this.config.autoType ? "" : this.activeType, text, this.shotAllowed && this.shotOn);
  }

  private buildForm(): HTMLElement {
    const types = el("div", { className: "fk-tabs", hidden: !this.showTypes });
    this.config.types.forEach((ty) => {
      const b = el("button", { className: "fk-type", type: "button", textContent: ty.label });
      b.addEventListener("click", () => this.selectType(ty.type));
      this.typeButtons.push(b);
      types.appendChild(b);
    });
    // Inline guidance for the active type ("what a good report needs"), picker only.
    this.guidanceEl = el("p", { className: "fk-guidance" });

    this.textarea = el("textarea", { className: "fk-text", id: "fk-text", placeholder: this.tr("textPlaceholder") });
    this.textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) this.submit();
    });

    this.attachInput = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", hidden: true, id: "fk-file", multiple: true });
    this.attachInput.addEventListener("change", () => {
      this.acceptFiles(this.attachInput.files);
      this.attachInput.value = "";
    });
    const addImages = el("button", { className: "fk-icon-btn", type: "button", ariaLabel: this.tr("addImages"), title: this.tr("addImages") }, [icon("image")]);
    addImages.addEventListener("click", () => this.attachInput.click());

    this.shotLabelEl = el("span", { className: "txt", textContent: this.tr("screenshotChip") });
    this.shotBtn = el("button", { className: "fk-pill fk-shot", type: "button", hidden: !this.shotAllowed }, [icon("shot"), this.shotLabelEl]);
    this.shotBtn.addEventListener("click", () => this.setShot(!this.shotOn));
    this.shotMarkupBtn = el("button", { className: "fk-pill", type: "button", textContent: this.tr("editShot"), hidden: true });
    this.shotMarkupBtn.addEventListener("click", () => this.h.onEditScreenshot());

    const send = el("button", { className: "fk-send", type: "button", ariaLabel: this.tr("send") }, [icon("up")]);
    send.addEventListener("click", () => this.submit());

    this.fileChips = el("div", { className: "fk-files" });
    this.mediaHint = el("p", { className: "fk-hint", hidden: true });
    const composer = el("div", { className: "fk-composer" }, [
      el("label", { className: "fk-sr", htmlFor: "fk-text", textContent: this.tr("textLabel") }),
      this.textarea,
      this.fileChips,
      this.mediaHint,
      el("div", { className: "fk-tools" }, [addImages, this.shotBtn, this.shotMarkupBtn, send]),
      this.attachInput,
    ]);
    for (const event of ["dragenter", "dragover"]) composer.addEventListener(event, (e) => { e.preventDefault(); composer.classList.add("fk-dragover"); });
    for (const event of ["dragleave", "dragend"]) composer.addEventListener(event, () => composer.classList.remove("fk-dragover"));
    composer.addEventListener("drop", (e) => {
      e.preventDefault();
      composer.classList.remove("fk-dragover");
      this.acceptFiles((e as DragEvent).dataTransfer?.files);
    });

    // "What gets sent?" — the auto-collected context, listed before sending.
    this.sentList = el("ul", { className: "fk-sent", id: "fk-sent", hidden: true });
    this.discloseBtn = el("button", { className: "fk-disclose", type: "button" }, [icon("eye"), this.tr("whatSent")]);
    this.discloseBtn.setAttribute("aria-controls", "fk-sent");
    this.discloseBtn.addEventListener("click", () => this.setDisclosure(this.sentList.hidden));
    const foot = el("div", { className: "fk-foot" }, [this.discloseBtn]);
    if (this.config.privacyUrl) foot.append(el("a", { className: "fk-privacy", href: this.config.privacyUrl, target: "_blank", rel: "noopener noreferrer", textContent: this.tr("privacyLink") }));

    const view = el("div", { className: "fk-view" }, [el("h2", { className: "fk-h", textContent: this.tr("heading") }), types, this.guidanceEl, composer, foot, this.sentList]);
    this.views["form"] = view;
    this.selectType(this.config.types[0]?.type ?? "");
    return view;
  }

  private setDisclosure(open: boolean) {
    this.sentList.hidden = !open;
    this.discloseBtn.setAttribute("aria-expanded", String(open));
  }

  private setShot(on: boolean) {
    this.shotOn = on;
    this.shotBtn.setAttribute("aria-pressed", String(on));
    this.shotMarkupBtn.hidden = !on;
    if (this.sentShotLi) this.sentShotLi.textContent = `${this.tr("sentShot")}: ${this.tr(on ? "yes" : "no")}`;
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

  /** Fill the "What gets sent?" list for this attempt (text only, no innerHTML). */
  setContext(ctx: UIContext) {
    const li = (k: Parameters<typeof t>[1], v: string) => el("li", { textContent: `${this.tr(k)}: ${v}` });
    const items = [el("li", { textContent: this.tr("sentText") })];
    if (ctx.url) items.push(li("sentPage", ctx.url));
    if (ctx.browser) items.push(li("sentBrowser", ctx.browser));
    if (ctx.console) items.push(li("sentConsole", String(ctx.consoleErrors ?? 0)));
    if (this.shotAllowed) items.push((this.sentShotLi = li("sentShot", this.tr(this.shotOn ? "yes" : "no"))));
    if (ctx.contextKeys?.length) items.push(li("sentContext", ctx.contextKeys.join(", ")));
    this.sentList.replaceChildren(...items);
  }

  private buildAnnotate() {
    this.annotator = new AnnotatorUI(this.config.locale, {
      onDone: (blob) => {
        this.setShot(true);
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
    this.setShot(false);
    this.shotLabelEl.textContent = this.tr("screenshotChip");
    this.shotMarkupBtn.disabled = false;
    this.shotMarkupBtn.textContent = this.tr("editShot");
    this.fileChips.replaceChildren();
    this.attachInput.value = "";
    this.mediaHint.hidden = true;
    this.annotator.root.hidden = true;
    this.panel.removeAttribute("inert");
    this.backdrop.removeAttribute("aria-hidden");
  }

  // The conversation: the user's text, how it was understood, ONE follow-up
  // question with a single freetext answer (ADR-012). Also hosts the busy states.
  private buildThread(): HTMLElement {
    this.meBubble = el("div", { className: "fk-me" });
    const avatar = icon("logo", "fk-avatar");
    this.statusText = el("span");
    this.typeTag = el("span", { className: "fk-tag" });
    this.botRow = el("div", { className: "fk-bot" }, [avatar, this.statusText, this.typeTag]);
    this.questionEl = el("p", { className: "fk-q", id: "fk-question" });

    this.answerBox = el("input", { id: "fk-answer", type: "text", placeholder: this.tr("followUpPlaceholder"), ariaLabel: this.tr("followUpPlaceholder") });
    this.answerBox.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.h.onComplete(this.answerBox.value.trim());
    });
    const send = el("button", { className: "fk-send", type: "button", ariaLabel: this.tr("send") }, [icon("up")]);
    send.addEventListener("click", () => this.h.onComplete(this.answerBox.value.trim()));
    this.answerWrap = el("div", { className: "fk-answer" }, [this.answerBox, send]);

    const anyway = el("button", { className: "fk-linkbtn", type: "button", textContent: this.tr("sendAnyway") });
    anyway.addEventListener("click", () => this.h.onComplete("")); // skip the answer
    this.askFoot = el("div", { className: "fk-foot" }, [el("span", { textContent: this.tr("oneQuestion") }), anyway]);

    this.sendNowBtn = el("button", { className: "fk-linkbtn", type: "button", textContent: this.tr("sendNow") });
    this.sendNowBtn.addEventListener("click", () => this.h.onSendNow());

    const view = el("div", { className: "fk-view" }, [el("div", { className: "fk-thread" }, [this.meBubble, this.botRow, this.questionEl]), this.answerWrap, this.askFoot, this.sendNowBtn]);
    this.views["thread"] = view;
    return view;
  }

  /** Patch the thread for a busy state (extracting/submitting) or the question. */
  private showThread(status: string, question?: string, type?: string) {
    this.show("thread");
    this.meBubble.textContent = this.textarea.value.trim();
    this.botRow.classList.toggle("fk-busy", !!status);
    this.statusText.textContent = status;
    this.statusText.hidden = !status;
    const label = this.typeLabel(type);
    this.typeTag.textContent = label ? this.tr("classified").replace("{type}", label) : "";
    this.typeTag.hidden = !label || !!status;
    this.questionEl.textContent = question ?? "";
    this.questionEl.hidden = this.answerWrap.hidden = this.askFoot.hidden = !question;
    this.sendNowBtn.hidden = true;
  }

  private buildDone(): HTMLElement {
    this.summaryEl = el("p", { className: "fk-summary" });
    this.doneTag = el("span", { className: "fk-tag" });
    this.card = el("div", { className: "fk-card" }, [el("span", { className: "fk-eyebrow", textContent: this.tr("understood") }), this.summaryEl, this.doneTag]);
    const restart = el("button", { className: "fk-btn fk-ghost", type: "button", textContent: this.tr("sendAnother") });
    restart.addEventListener("click", () => this.h.onRestart());
    this.issueLink = el("a", { className: "fk-btn", target: "_blank", rel: "noopener noreferrer" }, [this.tr("viewIssue"), icon("ext")]);
    const view = el("div", { className: "fk-view" }, [
      el("div", { className: "fk-done-head" }, [icon("check", "fk-check"), el("h2", { className: "fk-h", textContent: this.tr("doneTitle") })]),
      this.card,
      el("div", { className: "fk-row", role: "group" }, [restart, this.issueLink]),
    ]);
    this.views["done"] = view;
    return view;
  }

  private buildFailed(): HTMLElement {
    const retry = el("button", { className: "fk-btn", type: "button", textContent: this.tr("retry") });
    retry.addEventListener("click", () => this.h.onRetry());
    const view = el("div", { className: "fk-view" }, [el("p", { className: "fk-hint", textContent: this.tr("failed") }), el("div", { className: "fk-row" }, [retry])]);
    this.views["failed"] = view;
    return view;
  }

  private selectType(type: string) {
    this.activeType = type;
    this.config.types.forEach((ty, i) => this.typeButtons[i]?.setAttribute("aria-pressed", String(ty.type === type)));
    const g = this.showTypes ? (this.config.types.find((ty) => ty.type === type)?.guidance ?? "") : "";
    this.guidanceEl.textContent = g;
    this.guidanceEl.hidden = !g;
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
      this.trigger.hidden = !!this.config.hideTrigger;
      // Only on a genuine close (not the initial mount) do we unlock scroll and
      // restore focus — otherwise we'd steal the host page's initial focus and
      // wipe its inline overflow on every page load.
      if (this.hasOpened) {
        this.lockScroll(false);
        if (this.config.hideTrigger) this.hostReturnFocus?.focus(); // back to the host's own button
        else this.trigger.focus();
      }
      return;
    }
    if (this.backdrop.hidden) this.hostReturnFocus = document.activeElement as HTMLElement | null; // opening now
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
        this.setDisclosure(false);
        this.live.textContent = this.tr("heading");
        this.textarea.focus();
        break;
      case "extracting":
        this.showThread(this.tr("analyzing"));
        // After the 4s slow-hint, skipping the follow-up becomes available.
        this.sendNowBtn.hidden = !state.sendNow;
        this.live.textContent = this.tr("analyzing");
        break;
      case "asking":
        this.showThread("", state.question, state.typeUnclear ? undefined : state.type); // no "Filed as" while the question settles the type
        this.answerBox.value = "";
        this.live.textContent = state.question;
        this.answerBox.focus();
        break;
      case "submitting":
        this.showThread(this.tr("finalizing"));
        this.live.textContent = this.tr("finalizing");
        break;
      case "done": {
        this.show("done");
        const label = this.typeLabel(state.type);
        this.summaryEl.textContent = state.summary ?? "";
        this.doneTag.textContent = label;
        this.doneTag.hidden = !label;
        this.card.hidden = !state.summary; // nothing understood to show without the model
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
