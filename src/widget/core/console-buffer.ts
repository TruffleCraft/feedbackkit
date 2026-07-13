import { redactPII } from "../lib/pii-filter.js";
import type { ConsoleEntryT } from "../../shared/contract.js";

// Ring buffer of the most recent console errors/warnings, PII-filtered. The
// buffer LOGIC is pure + testable; installConsoleBuffer() is the thin wiring to
// the real console. We capture only error/warn (not log/info) — the point is
// failures the user hit, not noise.

const CAPTURED = ["error", "warn"] as const;
type Level = (typeof CAPTURED)[number];

export interface ConsoleBuffer {
  push(level: Level, args: unknown[], ts: number): void;
  snapshot(): ConsoleEntryT[];
}

function stringifyArg(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return `${a.name}: ${a.message}`;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

export function createConsoleBuffer(max = 10): ConsoleBuffer {
  const entries: ConsoleEntryT[] = [];
  return {
    push(level, args, ts) {
      const msg = redactPII(args.map(stringifyArg).join(" ")).slice(0, 2000);
      entries.push({ level, msg, ts });
      if (entries.length > max) entries.shift();
    },
    snapshot: () => entries.slice(),
  };
}

/** Wire the buffer to `console` (browser). Returns a restore fn + the buffer. */
export function installConsoleBuffer(target: Console = console, max = 10): { buffer: ConsoleBuffer; restore: () => void } {
  const buffer = createConsoleBuffer(max);
  const originals = new Map<Level, (...a: unknown[]) => void>();
  for (const level of CAPTURED) {
    const orig = target[level].bind(target) as (...a: unknown[]) => void;
    originals.set(level, orig);
    target[level] = (...args: unknown[]) => {
      try {
        buffer.push(level, args, Date.now());
      } catch {
        /* never let capture break the page's own logging */
      }
      orig(...args);
    };
  }
  return {
    buffer,
    restore: () => {
      for (const level of CAPTURED) {
        const orig = originals.get(level);
        if (orig) target[level] = orig as Console[Level];
      }
    },
  };
}
