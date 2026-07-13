import { toCanvas } from "html-to-image";

// Capture the page as a downscaled WebP for LLM vision extraction. Best-effort:
// any failure returns null and feedback proceeds without the image. The widget's
// own host is excluded so the panel isn't in the shot.

const MAX_WIDTH = 800; // token-thrift: the LLM reads a small image fine

export async function captureScreenshot(opts: { root?: Element; skip?: Element } = {}): Promise<Blob | null> {
  const root = (opts.root ?? document.body) as HTMLElement;
  try {
    const canvas = await toCanvas(root, {
      cacheBust: true,
      pixelRatio: 1,
      filter: opts.skip ? (node: HTMLElement) => node !== opts.skip : undefined,
    });
    const scale = Math.min(1, MAX_WIDTH / (canvas.width || MAX_WIDTH));
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(canvas.width * scale));
    out.height = Math.max(1, Math.round(canvas.height * scale));
    const ctx = out.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(canvas, 0, 0, out.width, out.height);
    return await new Promise<Blob | null>((resolve) => out.toBlob((b) => resolve(b), "image/webp", 0.8));
  } catch {
    return null;
  }
}
