// Turnstile for projects that enable it (PublicConfig.turnstileSiteKey). The API
// script is loaded only when the panel is first used, rendered explicitly into a
// light-DOM container (outside our shadow root) with appearance
// "interaction-only": invisible unless Cloudflare needs the visitor to click.
// Every POST needs its own token (they are single-use), so token() resets and
// re-executes the same widget. Failure → undefined; the gateway then answers 403
// and the panel shows its normal retry state.

const API = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const ACTION = "feedback"; // must match the gateway's TURNSTILE_ACTION
const TOKEN_TIMEOUT_MS = 30_000; // an interactive check needs the visitor's click

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  execute(id: string): void;
  reset(id: string): void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi | null> | null = null;
function loadApi(): Promise<TurnstileApi | null> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = API;
    s.async = true;
    s.onload = () => resolve(window.turnstile ?? null);
    s.onerror = () => {
      loading = null; // allow a later retry
      resolve(null);
    };
    document.head.appendChild(s);
  });
  return loading;
}

export class TurnstileGate {
  private id: string | null = null;
  private waiter: ((token: string | undefined) => void) | null = null;
  private box: HTMLDivElement | null = null;

  constructor(private siteKey: string) {}

  /** Warm up (load the script) without asking for a token. */
  preload(): void {
    void loadApi();
  }

  async token(): Promise<string | undefined> {
    const api = await loadApi();
    if (!api) return undefined;
    const result = new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => this.settle(undefined), TOKEN_TIMEOUT_MS);
      this.waiter = (t) => {
        clearTimeout(timer);
        resolve(t);
      };
    });
    try {
      if (this.id === null) {
        this.box = document.createElement("div");
        this.box.setAttribute("data-feedbackkit", "turnstile");
        // Above the panel, bottom-centre; empty (0×0) unless a check is shown.
        this.box.style.cssText = "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483647;";
        document.body.appendChild(this.box);
        this.id = api.render(this.box, {
          sitekey: this.siteKey,
          action: ACTION,
          appearance: "interaction-only",
          execution: "execute",
          callback: (t: string) => this.settle(t),
          "error-callback": () => this.settle(undefined),
          "expired-callback": () => this.settle(undefined),
        });
      } else {
        api.reset(this.id); // the previous token was redeemed
      }
      api.execute(this.id);
    } catch {
      this.settle(undefined);
    }
    return result;
  }

  private settle(token: string | undefined) {
    const w = this.waiter;
    this.waiter = null;
    w?.(token);
  }
}
