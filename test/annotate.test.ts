// #54: pure annotation model — geometry, scaling, and the draw command stream
// (the DOM/canvas layer is covered by the Playwright annotate spec).
import { describe, it, expect } from "vitest";
import { normRect, clampPoint, strokeWidth, fontSize, validCrop, drawAnnotation, drawScene, ANNOT_COLOR, type Ctx2D, type Annotation } from "../src/widget/ui/annotate-model.js";

// Recorder fake: captures the command stream drawScene issues.
function recorder() {
  const calls: string[] = [];
  const ctx: Ctx2D = {
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 0,
    lineCap: "butt",
    lineJoin: "miter",
    font: "",
    beginPath: () => void calls.push("beginPath"),
    moveTo: (x, y) => void calls.push(`moveTo ${x},${y}`),
    lineTo: (x, y) => void calls.push(`lineTo ${x},${y}`),
    stroke: () => void calls.push("stroke"),
    fill: () => void calls.push("fill"),
    closePath: () => void calls.push("closePath"),
    strokeRect: (x, y, w, h) => void calls.push(`strokeRect ${x},${y},${w},${h}`),
    fillText: (t, x, y) => void calls.push(`fillText ${t} ${x},${y}`),
  };
  return { ctx, calls };
}

describe("normRect / clampPoint / validCrop", () => {
  it("normalizes a drag in any direction to a positive rect", () => {
    expect(normRect(10, 10, 50, 40)).toEqual({ x: 10, y: 10, w: 40, h: 30 });
    expect(normRect(50, 40, 10, 10)).toEqual({ x: 10, y: 10, w: 40, h: 30 });
    expect(normRect(50, 10, 10, 40)).toEqual({ x: 10, y: 10, w: 40, h: 30 });
  });

  it("clamps points into the image bounds", () => {
    expect(clampPoint(-5, 900, 800, 600)).toEqual([0, 600]);
    expect(clampPoint(400, 300, 800, 600)).toEqual([400, 300]);
  });

  it("rejects accidental-tap crops, accepts real ones", () => {
    expect(validCrop({ x: 0, y: 0, w: 9, h: 100 })).toBe(false);
    expect(validCrop({ x: 0, y: 0, w: 100, h: 9 })).toBe(false);
    expect(validCrop({ x: 0, y: 0, w: 10, h: 10 })).toBe(true);
  });
});

describe("stroke/font scaling", () => {
  it("scales with image width inside clamps (legible in preview AND export)", () => {
    expect(strokeWidth(200)).toBe(2.5); // floor
    expect(strokeWidth(800)).toBeCloseTo(3.2);
    expect(strokeWidth(10_000)).toBe(6); // ceiling
    expect(fontSize(200)).toBe(14);
    expect(fontSize(800)).toBe(25);
    expect(fontSize(10_000)).toBe(28);
  });
});

describe("drawAnnotation", () => {
  it("rect → one strokeRect in the accent color", () => {
    const { ctx, calls } = recorder();
    drawAnnotation(ctx, { tool: "rect", x: 5, y: 6, w: 100, h: 50 }, 800);
    expect(calls).toEqual(["strokeRect 5,6,100,50"]);
    expect(ctx.strokeStyle).toBe(ANNOT_COLOR);
  });

  it("arrow → shaft stroke + filled head at the tip", () => {
    const { ctx, calls } = recorder();
    drawAnnotation(ctx, { tool: "arrow", x1: 0, y1: 0, x2: 100, y2: 0 }, 800);
    expect(calls[0]).toBe("beginPath");
    expect(calls).toContain("lineTo 100,0");
    expect(calls).toContain("stroke");
    expect(calls).toContain("fill"); // the head
  });

  it("text → fillText at the anchor with a scaled font", () => {
    const { ctx, calls } = recorder();
    drawAnnotation(ctx, { tool: "text", x: 10, y: 20, text: "here!" }, 800);
    expect(calls).toEqual(["fillText here! 10,20"]);
    expect(ctx.font).toContain("25px");
  });

  it("pen → polyline through every point; a single point draws nothing", () => {
    const { ctx, calls } = recorder();
    drawAnnotation(ctx, { tool: "pen", points: [0, 0, 10, 10, 20, 5] }, 800);
    expect(calls).toEqual(["beginPath", "moveTo 0,0", "lineTo 10,10", "lineTo 20,5", "stroke"]);
    const single = recorder();
    drawAnnotation(single.ctx, { tool: "pen", points: [3, 3] }, 800);
    expect(single.calls).toEqual([]);
  });
});

describe("drawScene", () => {
  it("draws all annotations in insertion order (undo = pop → deterministic replay)", () => {
    const { ctx, calls } = recorder();
    const scene: Annotation[] = [
      { tool: "rect", x: 0, y: 0, w: 10, h: 10 },
      { tool: "text", x: 1, y: 2, text: "a" },
    ];
    drawScene(ctx, scene, 800);
    expect(calls).toEqual(["strokeRect 0,0,10,10", "fillText a 1,2"]);
  });
});
