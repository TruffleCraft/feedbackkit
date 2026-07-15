// Screenshot annotator (#54): preview + crop + rect/arrow/text/pen on a canvas
// inside the Shadow DOM. Built ONCE as a persistent element (re-render ban);
// load() re-targets it at a new image. Pointer Events only (mouse+touch+pen —
// iOS Safari included): touch-action:none + setPointerCapture, coordinates are
// mapped display→image space so devicePixelRatio and CSS scaling never skew a
// drawing. Export flattens image + annotations at native resolution, cropped.
import { type Annotation, type Tool, type Rect, normRect, clampPoint, drawScene, drawAnnotation, validCrop, ANNOT_COLOR, fontSize } from "./annotate-model.js";
import { t, type Locale } from "./i18n.js";

export interface AnnotatorHandlers {
  onDone(blob: Blob, thumbUrl: string): void;
  onCancel(): void;
}

function btn(className: string, textContent: string, ariaLabel: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.textContent = textContent;
  b.setAttribute("aria-label", ariaLabel);
  return b;
}

export class AnnotatorUI {
  readonly root: HTMLDivElement;
  private canvas!: HTMLCanvasElement;
  private wrap!: HTMLDivElement;
  private textInput!: HTMLInputElement;
  private toolBtns = new Map<Tool, HTMLButtonElement>();
  private undoBtn!: HTMLButtonElement;
  private clearBtn!: HTMLButtonElement;

  private img: HTMLImageElement | null = null;
  private tool: Tool = "crop";
  private annotations: Annotation[] = [];
  private crop: Rect | null = null;
  private drag: { x: number; y: number; a: Annotation | null } | null = null;
  private scale = 1; // image px → CSS px

  constructor(
    private locale: Locale,
    private h: AnnotatorHandlers,
  ) {
    this.root = document.createElement("div");
    this.root.className = "fk-editor";
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.hidden = true;
    this.build();
  }

  private tr(k: Parameters<typeof t>[1]) {
    return t(this.locale, k);
  }

  private build() {
    const title = document.createElement("h2");
    title.textContent = this.tr("annotateTitle");
    const hint = document.createElement("span");
    hint.className = "fk-editor-hint";
    hint.textContent = this.tr("annotateHint");
    const close = btn("fk-x", "×", this.tr("close"));
    close.addEventListener("click", () => this.h.onCancel());
    const head = document.createElement("div");
    head.className = "fk-editor-head";
    head.append(title, hint, close);

    const bar = document.createElement("div");
    bar.className = "fk-toolbar";
    const tools: [Tool, string, Parameters<typeof t>[1]][] = [
      ["crop", "⛶", "toolCrop"],
      ["rect", "▭", "toolRect"],
      ["arrow", "↗", "toolArrow"],
      ["text", "T", "toolText"],
      ["pen", "✎", "toolPen"],
    ];
    for (const [tool, glyph, key] of tools) {
      const b = btn("fk-tool", glyph, this.tr(key));
      b.title = this.tr(key);
      b.addEventListener("click", () => this.setTool(tool));
      this.toolBtns.set(tool, b);
      bar.appendChild(b);
    }
    const sep = document.createElement("span");
    sep.className = "fk-tool-sep";
    this.undoBtn = btn("fk-tool", "↶", this.tr("undo"));
    this.undoBtn.title = this.tr("undo");
    this.undoBtn.addEventListener("click", () => {
      if (this.annotations.length) this.annotations.pop();
      else this.crop = null; // nothing drawn → undo releases the crop
      this.redraw();
    });
    this.clearBtn = btn("fk-tool", "⌫", this.tr("clear"));
    this.clearBtn.title = this.tr("clear");
    this.clearBtn.addEventListener("click", () => {
      this.annotations = [];
      this.crop = null;
      this.redraw();
    });
    bar.append(sep, this.undoBtn, this.clearBtn);

    this.canvas = document.createElement("canvas");
    this.canvas.className = "fk-canvas";
    this.textInput = document.createElement("input");
    this.textInput.className = "fk-canvas-text";
    this.textInput.type = "text";
    this.textInput.hidden = true;
    this.wrap = document.createElement("div");
    this.wrap.className = "fk-canvas-wrap";
    this.wrap.append(this.canvas, this.textInput);

    const cancel = btn("fk-btn fk-ghost", this.tr("cancel"), this.tr("cancel"));
    cancel.addEventListener("click", () => this.h.onCancel());
    const use = btn("fk-btn", this.tr("useShot"), this.tr("useShot"));
    use.addEventListener("click", () => void this.flatten());
    const foot = document.createElement("div");
    foot.className = "fk-editor-foot";
    foot.append(cancel, use);

    this.root.append(head, bar, this.wrap, foot);

    this.canvas.addEventListener("pointerdown", (e) => this.pointerDown(e));
    this.canvas.addEventListener("pointermove", (e) => this.pointerMove(e));
    this.canvas.addEventListener("pointerup", (e) => this.pointerUp(e));
    this.canvas.addEventListener("pointercancel", () => (this.drag = null));
    this.textInput.addEventListener("keydown", (e) => {
      e.stopPropagation(); // Escape must close the text input, not the whole panel
      if (e.key === "Enter") this.commitText();
      if (e.key === "Escape") this.hideTextInput();
    });
    this.textInput.addEventListener("blur", () => this.commitText());
  }

  /** (Re)target the editor at a freshly captured image and reset all state. */
  load(img: HTMLImageElement) {
    this.img = img;
    this.annotations = [];
    this.crop = null;
    this.drag = null;
    this.setTool("crop");
    this.fit();
    this.redraw();
  }

  /** Size the canvas: CSS-fit into the panel, backing store at devicePixelRatio. */
  private fit() {
    if (!this.img) return;
    const availW = this.wrap.clientWidth || 640;
    const availH = this.wrap.clientHeight || 480;
    this.scale = Math.min(1, availW / this.img.naturalWidth, availH / this.img.naturalHeight);
    const cssW = Math.round(this.img.naturalWidth * this.scale);
    const cssH = Math.round(this.img.naturalHeight * this.scale);
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
  }

  /** Pointer position in IMAGE pixel space (clamped). */
  private pos(e: PointerEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    // Divide by the LIVE rect scale (not this.scale): a panel resize between
    // fit() and the event would otherwise skew every coordinate.
    const kx = this.img ? this.img.naturalWidth / r.width : 1;
    const ky = this.img ? this.img.naturalHeight / r.height : 1;
    return clampPoint((e.clientX - r.left) * kx, (e.clientY - r.top) * ky, this.img?.naturalWidth ?? 0, this.img?.naturalHeight ?? 0);
  }

  private setTool(tool: Tool) {
    this.tool = tool;
    for (const [k, b] of this.toolBtns) b.setAttribute("aria-pressed", String(k === tool));
    this.canvas.style.cursor = tool === "text" ? "text" : "crosshair";
  }

  private pointerDown(e: PointerEvent) {
    if (!this.img) return;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    const [x, y] = this.pos(e);
    if (this.tool === "text") {
      this.showTextInput(x, y);
      return;
    }
    const a: Annotation | null =
      this.tool === "rect" ? { tool: "rect", x, y, w: 0, h: 0 } : this.tool === "arrow" ? { tool: "arrow", x1: x, y1: y, x2: x, y2: y } : this.tool === "pen" ? { tool: "pen", points: [x, y] } : null;
    this.drag = { x, y, a };
  }

  private pointerMove(e: PointerEvent) {
    if (!this.drag || !this.img) return;
    e.preventDefault();
    const [x, y] = this.pos(e);
    const d = this.drag;
    if (d.a?.tool === "rect") {
      const r = normRect(d.x, d.y, x, y);
      Object.assign(d.a, r);
    } else if (d.a?.tool === "arrow") {
      d.a.x2 = x;
      d.a.y2 = y;
    } else if (d.a?.tool === "pen") {
      const p = d.a.points;
      const lx = p[p.length - 2]!;
      const ly = p[p.length - 1]!;
      if ((x - lx) ** 2 + (y - ly) ** 2 > 9) p.push(x, y); // ≥3px in image space: bounds point count
    } else if (this.tool === "crop") {
      this.crop = normRect(d.x, d.y, x, y);
    }
    this.redraw(d.a);
  }

  private pointerUp(e: PointerEvent) {
    if (!this.drag) return;
    const d = this.drag;
    this.drag = null;
    if (d.a) {
      // Discard accidental taps (a zero-size rect / arrow / single-point pen).
      const keep = (d.a.tool === "rect" && validCrop(d.a)) || (d.a.tool === "arrow" && (d.a.x1 !== d.a.x2 || d.a.y1 !== d.a.y2)) || (d.a.tool === "pen" && d.a.points.length >= 4);
      if (keep) this.annotations.push(d.a);
    } else if (this.tool === "crop" && this.crop && !validCrop(this.crop)) {
      this.crop = null;
    }
    this.canvas.releasePointerCapture(e.pointerId);
    this.redraw();
  }

  private showTextInput(x: number, y: number) {
    this.textInput.hidden = false;
    this.textInput.value = "";
    this.textInput.style.left = `${x * this.scale}px`;
    this.textInput.style.top = `${y * this.scale}px`;
    this.textInput.style.font = `600 ${Math.max(12, fontSize(this.img?.naturalWidth ?? 800) * this.scale)}px inherit`;
    this.textInput.dataset["x"] = String(x);
    this.textInput.dataset["y"] = String(y);
    this.textInput.focus();
  }

  private hideTextInput() {
    this.textInput.hidden = true;
    this.textInput.value = "";
  }

  private commitText() {
    const text = this.textInput.value.trim();
    if (!this.textInput.hidden && text) {
      this.annotations.push({ tool: "text", x: Number(this.textInput.dataset["x"]), y: Number(this.textInput.dataset["y"]), text });
    }
    this.hideTextInput();
    this.redraw();
  }

  /** Repaint: image → annotations (+ in-progress one) → crop dim overlay. */
  private redraw(inProgress: Annotation | null = null) {
    const ctx = this.canvas.getContext("2d");
    if (!ctx || !this.img) return;
    const k = this.canvas.width / this.img.naturalWidth; // display scale incl. dpr
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.clearRect(0, 0, this.img.naturalWidth, this.img.naturalHeight);
    ctx.drawImage(this.img, 0, 0);
    drawScene(ctx, this.annotations, this.img.naturalWidth);
    if (inProgress) drawAnnotation(ctx, inProgress, this.img.naturalWidth);
    if (this.crop) {
      const { x, y, w, h } = this.crop;
      const W = this.img.naturalWidth;
      const H = this.img.naturalHeight;
      ctx.fillStyle = "rgba(0,0,0,.45)";
      ctx.fillRect(0, 0, W, y);
      ctx.fillRect(0, y, x, h);
      ctx.fillRect(x + w, y, W - x - w, h);
      ctx.fillRect(0, y + h, W, H - y - h);
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5 / this.scale;
      ctx.setLineDash?.([6 / this.scale, 4 / this.scale]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash?.([]);
    }
    this.undoBtn.disabled = this.annotations.length === 0 && !this.crop;
    this.clearBtn.disabled = this.undoBtn.disabled;
  }

  /** Flatten image + annotations at native resolution, cropped, → WebP. */
  private async flatten() {
    if (!this.img) return;
    const region: Rect = this.crop ?? { x: 0, y: 0, w: this.img.naturalWidth, h: this.img.naturalHeight };
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(region.w));
    out.height = Math.max(1, Math.round(region.h));
    const ctx = out.getContext("2d");
    if (!ctx) return this.h.onCancel();
    ctx.translate(-region.x, -region.y);
    ctx.drawImage(this.img, 0, 0);
    drawScene(ctx, this.annotations, this.img.naturalWidth);
    const blob = await new Promise<Blob | null>((r) => out.toBlob((b) => r(b), "image/webp", 0.8));
    if (!blob) return this.h.onCancel();
    this.h.onDone(blob, out.toDataURL("image/webp", 0.5));
  }
}
