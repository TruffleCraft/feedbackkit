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

// html-to-image clones the DOM, and a clone starts unscrolled: a page that
// scrolls inside its own container (an app shell with a fixed sidebar) came out
// showing the top of that container, not what the user saw. While capturing,
// each scrolled container is set back to 0 and its children shifted by the
// same amount, which looks identical on screen and survives the clone.
function freezeScroll(root: Element, skip?: Element): () => void {
  const undo: Array<() => void> = [];
  if (typeof document.createTreeWalker !== "function") return () => {};
  // 1 = SHOW_ELEMENT / FILTER_ACCEPT, 2 = FILTER_REJECT (no NodeFilter global needed)
  const walker = document.createTreeWalker(root, 1, { acceptNode: (n) => (n === skip ? 2 : 1) });
  for (let n = walker.nextNode() as HTMLElement | null; n && undo.length < 25; n = walker.nextNode() as HTMLElement | null) {
    const { scrollTop: top, scrollLeft: left } = n;
    if (!top && !left) continue;
    const kids = Array.from(n.children) as HTMLElement[];
    const before = kids.map((k) => k.style.transform);
    n.scrollTop = 0;
    n.scrollLeft = 0;
    kids.forEach((k, i) => (k.style.transform = `translate(${-left}px, ${-top}px) ${before[i]}`.trim()));
    undo.push(() => {
      kids.forEach((k, i) => (k.style.transform = before[i]!));
      n.scrollTop = top;
      n.scrollLeft = left;
    });
  }
  return () => undo.reverse().forEach((f) => f());
}

export async function captureScreenshot(opts: { root?: Element; skip?: Element; maxWidth?: number; viewport?: boolean } = {}): Promise<Blob | null> {
  const root = (opts.root ?? document.body) as HTMLElement;
  const maxW = opts.maxWidth ?? MAX_WIDTH;
  const unfreeze = opts.viewport ? freezeScroll(root, opts.skip) : () => {};
  try {
    const viewport = opts.viewport
      ? {
          width: window.innerWidth,
          height: window.innerHeight,
          style: {
            transform: `translate(${-window.scrollX}px, ${-window.scrollY}px)`,
            transformOrigin: "top left",
          },
        }
      : {};
    const canvas = await toCanvas(root, {
      pixelRatio: 1,
      filter: opts.skip ? (node: HTMLElement) => node !== opts.skip : undefined,
      ...viewport,
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
  } finally {
    unfreeze();
  }
}
