import { toCanvas } from "html-to-image";

// Capture the page as a downscaled WebP for LLM vision extraction. Best-effort:
// any failure returns null and feedback proceeds without the image. The widget's
// own host is excluded so the panel isn't in the shot.

const MAX_WIDTH = 800; // token-thrift: the LLM reads a small image fine
// Bound very tall pages: the server rejects uploads over 2 MB, and that rejection
// is a silent drop (uploadScreenshot → null). Full-page captures have no natural
// height limit, so scale by whichever dimension binds first — the shot stays
// under the cap instead of vanishing on a very long page.
const MAX_HEIGHT = 4000;

export async function captureScreenshot(opts: { root?: Element; skip?: Element; maxWidth?: number } = {}): Promise<Blob | null> {
  const root = (opts.root ?? document.body) as HTMLElement;
  const maxW = opts.maxWidth ?? MAX_WIDTH;
  try {
    const canvas = await toCanvas(root, {
      pixelRatio: 1,
      filter: opts.skip ? (node: HTMLElement) => node !== opts.skip : undefined,
    });
    const scale = Math.min(1, maxW / (canvas.width || maxW), MAX_HEIGHT / (canvas.height || MAX_HEIGHT));
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
