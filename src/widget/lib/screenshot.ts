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

export async function captureScreenshot(opts: { root?: Element; skip?: Element } = {}): Promise<Blob | null> {
  const root = (opts.root ?? document.body) as HTMLElement;
  try {
    // No cacheBust: it appends a unique query string to every image URL, forcing
    // html-to-image to RE-FETCH every already-loaded image over the network to
    // inline it. On image-heavy pages that adds 1-2s of highly variable latency
    // (measured 1.3-2.7s on sctt.eu vs ~0.6s without) — enough to lose the
    // caller's capture-timeout race and silently drop the screenshot (bug:
    // sctt-website #297). Tradeoff: an image the host loaded cross-origin without
    // a `crossorigin` attribute may inline as blank in the shot. A partial
    // screenshot beats none, and the common same-origin case is a clean ~4x win.
    const canvas = await toCanvas(root, {
      pixelRatio: 1,
      filter: opts.skip ? (node: HTMLElement) => node !== opts.skip : undefined,
    });
    const scale = Math.min(1, MAX_WIDTH / (canvas.width || MAX_WIDTH), MAX_HEIGHT / (canvas.height || MAX_HEIGHT));
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
