import type { PublicConfig, FeedbackPayload, FeedbackResponse, EventName } from "../../shared/contract.js";

// Thin transport to the gateway. Type-only contract imports → zod is NOT bundled
// into the browser. Transports are injectable for tests.
export interface ApiDeps {
  fetchImpl?: typeof fetch;
  sendBeacon?: (url: string, data: BodyInit) => boolean;
}

export class Api {
  private f: typeof fetch;
  private beacon?: (url: string, data: BodyInit) => boolean;

  constructor(
    private base: string,
    private project: string,
    deps: ApiDeps = {},
  ) {
    this.f = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.beacon = deps.sendBeacon ?? (typeof navigator !== "undefined" && navigator.sendBeacon ? navigator.sendBeacon.bind(navigator) : undefined);
  }

  private url(path: string, params: Record<string, string> = {}): string {
    const q = new URLSearchParams({ project: this.project, ...params }).toString();
    return `${this.base}${path}?${q}`;
  }

  async config(): Promise<PublicConfig | null> {
    try {
      const r = await this.f(this.url("/api/config"), { credentials: "omit" });
      return r.ok ? ((await r.json()) as PublicConfig) : null;
    } catch {
      return null;
    }
  }

  /** Upload one screenshot; returns its key or null (never throws — attachments
   * are best-effort, feedback proceeds without them). */
  async uploadScreenshot(feedbackId: string, blob: Blob): Promise<string | null> {
    try {
      const r = await this.f(this.url("/api/upload", { feedbackId, kind: "screenshot" }), {
        method: "POST",
        headers: { "Content-Type": blob.type || "image/webp" },
        body: blob,
        credentials: "omit",
      });
      if (!r.ok) return null;
      const j = (await r.json()) as { key?: string };
      return j.key ?? null;
    } catch {
      return null;
    }
  }

  async submit(payload: FeedbackPayload): Promise<FeedbackResponse> {
    try {
      const r = await this.f(this.url("/api/feedback"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        credentials: "omit",
      });
      return (await r.json()) as FeedbackResponse;
    } catch (e) {
      return { v: 1, status: "error", error: `network: ${(e as Error).message}` };
    }
  }

  /** Fire-and-forget funnel event (sendBeacon → text/plain, no preflight). */
  event(name: EventName): void {
    if (!this.beacon) return;
    try {
      this.beacon(`${this.base}/api/events`, new Blob([JSON.stringify({ v: 1, project: this.project, name })], { type: "text/plain" }));
    } catch {
      /* best-effort */
    }
  }
}
