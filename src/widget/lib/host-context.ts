import { CONTEXT_KEY_RE, MAX_CONTEXT_KEYS, MAX_CONTEXT_VALUE } from "../../shared/limits.js";
import type { HostContextT } from "../../shared/contract.js";

// Debug context the embedding app hands over, e.g. for a signed-in user:
//   window.FeedbackKitContext = () => ({ userId: me.id, appVersion: "1.4.2" });
// An object works too; a function is read at submit time, so it is always
// current. Anything outside the contract (nested values, odd keys, too many
// keys) is dropped here rather than failing the whole submission.
export function readHostContext(source: unknown): HostContextT | undefined {
  let raw: unknown = source;
  try {
    if (typeof raw === "function") raw = (raw as () => unknown)();
  } catch {
    return undefined; // a throwing host callback must never block feedback
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: HostContextT = {};
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= MAX_CONTEXT_KEYS) break;
    if (!CONTEXT_KEY_RE.test(k)) continue;
    if (typeof v === "string") out[k] = v.slice(0, MAX_CONTEXT_VALUE);
    else if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) out[k] = v;
    else continue;
    n++;
  }
  return n > 0 ? out : undefined;
}
