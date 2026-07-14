import type { WidgetState } from "../core/state.js";
import { STYLES } from "./styles.js";
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
  onAttach(file: File): void;
  onRetry(): void;
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
  private textarea!: HTMLTextAreaElement;
  private shotCheck!: HTMLInputElement;
  private attachInput!: HTMLInputElement;
  private attachName!: HTMLSpanElement;
  private questionEl!: HTMLParagraphElement;
  private answerBox!: HTMLTextAreaElement;
  private sendNowBtn!: HTMLButtonElement;
  private issueLink!: HTMLAnchorElement;
  private doneMsg!: HTMLParagraphElement;
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
    const icon = el("span", { className: "fk-trigger-icon", textContent: "✎" });
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

    const panel = el("div", { className: "fk-panel", role: "dialog" }, [head, this.buildForm(), this.buildExtracting(), this.buildAsking(), this.buildDone(), this.buildFailed()]);
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "fk-title");
    panel.addEventListener("click", (e) => e.stopPropagation());

    this.backdrop = el("div", { className: "fk-backdrop", hidden: true }, [panel]);
    this.backdrop.addEventListener("click", () => this.h.onClose()); // click outside = close
    this.backdrop.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Escape") this.h.onClose();
    });

    this.shadow.append(this.trigger, this.backdrop, this.live);
  }

  private buildForm(): HTMLElement {
    const types = el("div", { className: "fk-types" });
    this.config.types.forEach((ty, i) => {
      const b = el("button", { className: "fk-type", type: "button", textContent: ty.label });
      b.setAttribute("aria-pressed", String(i === 0));
      b.addEventListener("click", () => this.selectType(ty.type));
      this.typeButtons.push(b);
      types.appendChild(b);
    });
    this.activeType = this.config.types[0]?.type ?? "";

    const label = el("label", { className: "fk-label", htmlFor: "fk-text", textContent: this.tr("textLabel") });
    this.textarea = el("textarea", { className: "fk-input", id: "fk-text", placeholder: this.tr("textPlaceholder") });

    // Media row: visible, opt-out screenshot + a simple image attach.
    this.shotCheck = el("input", { className: "fk-check-input", type: "checkbox", id: "fk-shot", checked: true });
    const shotLabel = el("label", { className: "fk-check", htmlFor: "fk-shot" }, [this.shotCheck, el("span", { textContent: this.tr("attachScreenshot") })]);
    this.attachInput = el("input", { type: "file", accept: "image/*", hidden: true, id: "fk-file" });
    this.attachName = el("span", { className: "fk-attach-name" });
    const attachBtn = el("label", { className: "fk-attach", htmlFor: "fk-file" }, [el("span", { textContent: `📎 ${this.tr("attachFile")}` }), this.attachName, this.attachInput]);
    this.attachInput.addEventListener("change", () => {
      const f = this.attachInput.files?.[0];
      if (f) {
        this.attachName.textContent = f.name;
        this.h.onAttach(f);
      }
    });
    const media = el("div", { className: "fk-media" }, [shotLabel, attachBtn]);

    const send = el("button", { className: "fk-btn", type: "button", textContent: this.tr("send") });
    send.addEventListener("click", () => this.h.onSubmit(this.activeType, this.textarea.value.trim(), this.shotCheck.checked));
    const view = el("div", {}, [types, label, this.textarea, media, el("div", { className: "fk-actions" }, [send])]);
    this.views["form"] = view;
    return view;
  }

  private buildExtracting(): HTMLElement {
    this.sendNowBtn = el("button", { className: "fk-btn fk-ghost", type: "button", textContent: this.tr("sendNow") });
    this.sendNowBtn.addEventListener("click", () => this.h.onSendNow());
    const view = el("div", { className: "fk-status" }, [el("span", { className: "fk-spinner" }), el("span", { textContent: this.tr("analyzing") }), this.sendNowBtn]);
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
    this.issueLink = el("a", { className: "fk-btn", textContent: this.tr("viewIssue"), target: "_blank", rel: "noopener noreferrer" });
    const view = el("div", { className: "fk-done" }, [el("div", { className: "fk-done-icon", textContent: "✓" }), el("h3", { className: "fk-title", textContent: this.tr("doneTitle") }), this.doneMsg, el("div", { className: "fk-actions", role: "group" }, [this.issueLink])]);
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
        this.title.textContent = this.tr("title");
        this.live.textContent = this.tr("title");
        this.textarea.focus();
        break;
      case "extracting":
        this.show("extracting");
        // After the 4s slow-hint, "Send now" becomes a primary action.
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
        this.sendNowBtn.className = "fk-btn fk-ghost";
        this.live.textContent = this.tr("analyzing");
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
