// Pure annotation model (#54): geometry + canvas draw commands, no DOM. All
// coordinates live in IMAGE pixel space — the preview pre-scales its context,
// the export draws at native resolution, and both share drawScene(), so what
// the user sees is exactly what uploads.

export type Tool = "crop" | "rect" | "arrow" | "text" | "pen";

export type Annotation =
  | { tool: "rect"; x: number; y: number; w: number; h: number }
  | { tool: "arrow"; x1: number; y1: number; x2: number; y2: number }
  | { tool: "text"; x: number; y: number; text: string }
  | { tool: "pen"; points: number[] }; // [x0,y0,x1,y1,…]

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Normalize a drag (any direction) into a positive-size rect. */
export function normRect(x1: number, y1: number, x2: number, y2: number): Rect {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

/** Clamp a point into the image bounds. */
export function clampPoint(x: number, y: number, w: number, h: number): [number, number] {
  return [Math.min(Math.max(x, 0), w), Math.min(Math.max(y, 0), h)];
}

// Stroke width / font size scale with the image so annotations stay legible in
// the exported full-resolution flatten, not just in the fitted preview.
export function strokeWidth(imgW: number): number {
  return Math.min(6, Math.max(2.5, imgW / 250));
}
export function fontSize(imgW: number): number {
  return Math.min(28, Math.max(14, imgW / 32));
}

export const ANNOT_COLOR = "#e5484d"; // one deliberate accent — keeps UI + bundle lean

// The minimal 2D-context surface drawScene needs (testable with a recorder
// fake). Deliberately DOM-lib-free — this module is also type-checked by the
// worker tsconfig, which has no DOM types.
export interface Ctx2D {
  strokeStyle: unknown;
  fillStyle: unknown;
  lineWidth: number;
  lineCap: "butt" | "round" | "square";
  lineJoin: "round" | "bevel" | "miter";
  font: string;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  fill(): void;
  closePath(): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
}

export function drawAnnotation(ctx: Ctx2D, a: Annotation, imgW: number): void {
  const s = strokeWidth(imgW);
  ctx.strokeStyle = ANNOT_COLOR;
  ctx.fillStyle = ANNOT_COLOR;
  ctx.lineWidth = s;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  switch (a.tool) {
    case "rect":
      ctx.strokeRect(a.x, a.y, a.w, a.h);
      break;
    case "arrow": {
      ctx.beginPath();
      ctx.moveTo(a.x1, a.y1);
      ctx.lineTo(a.x2, a.y2);
      ctx.stroke();
      // Filled head, sized off the stroke so it scales with the image.
      const angle = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
      const head = s * 4;
      ctx.beginPath();
      ctx.moveTo(a.x2, a.y2);
      ctx.lineTo(a.x2 - head * Math.cos(angle - 0.5), a.y2 - head * Math.sin(angle - 0.5));
      ctx.lineTo(a.x2 - head * Math.cos(angle + 0.5), a.y2 - head * Math.sin(angle + 0.5));
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "text":
      ctx.font = `600 ${fontSize(imgW)}px -apple-system, sans-serif`;
      ctx.fillText(a.text, a.x, a.y);
      break;
    case "pen": {
      if (a.points.length < 4) break;
      ctx.beginPath();
      ctx.moveTo(a.points[0]!, a.points[1]!);
      for (let i = 2; i < a.points.length; i += 2) ctx.lineTo(a.points[i]!, a.points[i + 1]!);
      ctx.stroke();
      break;
    }
  }
}

/** Draw every committed annotation (the image itself is drawn by the caller). */
export function drawScene(ctx: Ctx2D, annotations: readonly Annotation[], imgW: number): void {
  for (const a of annotations) drawAnnotation(ctx, a, imgW);
}

const MIN_CROP = 10; // px in image space — below this a drag is treated as a no-op

/** A crop drag smaller than MIN_CROP (an accidental tap) yields no crop change. */
export function validCrop(r: Rect): boolean {
  return r.w >= MIN_CROP && r.h >= MIN_CROP;
}
