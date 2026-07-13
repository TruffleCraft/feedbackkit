import { parseUA } from "./ua-parse.js";
import type { DeviceInfoT } from "../../shared/contract.js";

// Collects the auto-context the design promises devs can't reconstruct post-hoc.
// Takes a window-like object so it's testable without a real browser.
export interface WindowLike {
  navigator: { userAgent: string; language?: string };
  innerWidth: number;
  innerHeight: number;
}

export function collectDeviceInfo(win: WindowLike): DeviceInfoT {
  const { browser, os } = parseUA(win.navigator.userAgent);
  return {
    browser,
    os,
    viewport: { w: win.innerWidth, h: win.innerHeight },
    language: win.navigator.language,
  };
}
