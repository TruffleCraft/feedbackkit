import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { captureScreenshot } from "../src/widget/lib/screenshot.js";

// html-to-image's toCanvas is the only external dependency; mock it so we can
// assert the OPTIONS we pass (regression guard) without a real browser canvas.
const { toCanvas } = vi.hoisted(() => ({ toCanvas: vi.fn() }));
vi.mock("html-to-image", () => ({ toCanvas }));

// Minimal DOM stubs: the capture path uses document.body, a scratch <canvas>,
// its 2d context, and toBlob. The unit env is `node` (no DOM), so we fake them.
const origDocument = (globalThis as { document?: unknown }).document;
const origWindow = (globalThis as { window?: unknown }).window;
// A single scratch <canvas> the code writes its output dimensions onto, so tests
// can read back what size the final image was scaled to.
let outCanvas: { width: number; height: number; getContext: () => unknown; toBlob: (cb: (b: Blob | null) => void) => void };
function makeOutCanvas() {
  outCanvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: () => {} }),
    toBlob: (cb: (b: Blob | null) => void) => cb(new Blob([new Uint8Array([1])], { type: "image/webp" })),
  };
  return outCanvas;
}

describe("captureScreenshot", () => {
  beforeEach(() => {
    toCanvas.mockReset();
    toCanvas.mockResolvedValue({ width: 1600, height: 1200 });
    (globalThis as { document?: unknown }).document = { body: {}, createElement: () => makeOutCanvas() };
    (globalThis as { window?: unknown }).window = { innerWidth: 1440, innerHeight: 900, scrollX: 20, scrollY: 300 };
  });
  afterEach(() => {
    (globalThis as { document?: unknown }).document = origDocument;
    (globalThis as { window?: unknown }).window = origWindow;
  });

  // Root cause of issue #297: cacheBust:true forces html-to-image to re-fetch
  // every image over the network, which blew the capture timeout on real pages
  // → null → screenshot silently dropped. Guard against it coming back.
  it("captures WITHOUT cacheBust (guards the #297 screenshot-drop regression)", async () => {
    const blob = await captureScreenshot();
    expect(toCanvas).toHaveBeenCalledOnce();
    const opts = (toCanvas.mock.calls[0]![1] ?? {}) as Record<string, unknown>;
    expect(opts.cacheBust).toBeFalsy();
    expect(blob).not.toBeNull();
  });

  it("passes the skip filter so the widget's own host isn't in the shot", async () => {
    const host = { tag: "fk-host" } as unknown as Element;
    await captureScreenshot({ skip: host });
    const opts = (toCanvas.mock.calls[0]![1] ?? {}) as { filter?: (n: unknown) => boolean };
    expect(typeof opts.filter).toBe("function");
    expect(opts.filter!(host)).toBe(false); // host excluded
    expect(opts.filter!({ other: true })).toBe(true); // everything else kept
  });

  it("clips interactive captures to the visible viewport", async () => {
    await captureScreenshot({ viewport: true, maxWidth: 1600 });
    const opts = (toCanvas.mock.calls[0]![1] ?? {}) as { width?: number; height?: number; style?: Record<string, string> };
    expect(opts.width).toBe(1440);
    expect(opts.height).toBe(900);
    expect(opts.style?.transform).toBe("translate(-20px, -300px)");
  });

  // A very tall full-page capture must stay bounded, else the webp can exceed the
  // server's 2 MB cap and get silently dropped (the #297 symptom, relocated).
  it("bounds a very tall page's output height (keeps the webp under the 2MB cap)", async () => {
    toCanvas.mockResolvedValue({ width: 1000, height: 20000 });
    await captureScreenshot();
    expect(outCanvas.height).toBeLessThanOrEqual(4000); // height-capped
    expect(outCanvas.width).toBe(200); // aspect preserved: 1000 * (4000/20000)
  });

  it("returns null when rasterization fails (best-effort — never blocks feedback)", async () => {
    toCanvas.mockRejectedValue(new Error("tainted canvas"));
    expect(await captureScreenshot()).toBeNull();
  });
});
