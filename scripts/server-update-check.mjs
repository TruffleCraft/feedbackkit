// The check behind the admin notice for a newer release (journey J2). It runs in the
// standalone server only, for installs from a release tarball. The browser never calls
// GitHub: the admin asks the gateway, and the gateway asks GitHub with one plain GET.
//
// - At most one request per day (one per hour after a failure), answered from memory.
// - Nothing about the installation is sent: no version, no host, no data. The request
//   carries a fixed User-Agent and the Accept header, nothing else.
// - It never throws. A failure becomes the state "failed" with a fixed, short reason.
// - Releases are picked by the same rules as `feedbackkit-update`: stable installs see
//   stable releases only, dev installs see dev builds as well, drafts never.

const TAG = /^v?(\d+)\.(\d+)\.(\d+)(?:-dev\.(\d+))?$/;
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
export const DEFAULT_API = "https://api.github.com/repos/TruffleCraft/feedbackkit";
const NOTES = "https://github.com/TruffleCraft/feedbackkit/releases/tag/";

/** [major, minor, patch, dev] with dev = Infinity for a stable release, or null. */
export function parseVersion(text) {
  const m = TAG.exec(String(text));
  return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? Infinity : +m[4]] : null;
}

/** Negative, zero or positive. A dev build sorts below the stable release of its version. */
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) throw new Error("not a version");
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** The newest usable release of a GitHub releases answer for a channel, as a bare version, or null. */
export function pickLatest(releases, channel) {
  const usable = [].concat(releases).filter((r) => r && typeof r === "object" && !r.draft && typeof r.tag_name === "string" && parseVersion(r.tag_name));
  const ofChannel = usable.filter((r) => channel === "dev" || (!r.prerelease && !/-dev\./.test(r.tag_name)));
  ofChannel.sort((x, y) => compareVersions(y.tag_name, x.tag_name));
  return ofChannel[0] ? ofChannel[0].tag_name.replace(/^v/, "") : null;
}

/** "on" (default) or "off"; anything else is a mistake worth stopping for. */
export function readSwitch(value) {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "" || v === "on") return true;
  if (v === "off") return false;
  throw new Error("FK_UPDATE_CHECK must be on or off.");
}

/**
 * @param {{ release: string, channel: string, api?: string, fetchImpl?: typeof fetch, now?: () => number, timeoutMs?: number }} options
 * @returns {() => Promise<{ state: "available" | "current" | "failed", latest: string | null, url: string | null, checkedAt: number, reason?: string }>}
 */
export function createUpdateCheck({ release, channel, api, fetchImpl = fetch, now = Date.now, timeoutMs = 5000 }) {
  const base = (api || DEFAULT_API).replace(/\/+$/, "");
  const endpoint = channel === "dev" ? `${base}/releases?per_page=30` : `${base}/releases/latest`;
  let cached = null;
  let inflight = null;

  const failed = (reason) => ({ state: "failed", latest: null, url: null, checkedAt: now(), reason });

  async function ask() {
    try {
      if (!parseVersion(release)) return failed("this release has no version number");
      const res = await fetchImpl(endpoint, {
        headers: { "User-Agent": "feedbackkit-update-check", Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const limited = res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0");
        return failed(limited ? "GitHub rate limit reached" : `GitHub answered ${res.status}`);
      }
      const latest = pickLatest(await res.json(), channel);
      if (!latest) return failed("GitHub listed no release");
      return { state: compareVersions(latest, release) > 0 ? "available" : "current", latest, url: NOTES + "v" + latest, checkedAt: now() };
    } catch (e) {
      if (e && (e.name === "TimeoutError" || e.name === "AbortError")) return failed("GitHub did not answer in time");
      if (e instanceof SyntaxError) return failed("GitHub sent something unexpected");
      return failed("GitHub could not be reached");
    }
  }

  return async function status() {
    const t = now();
    if (cached && t - cached.checkedAt < (cached.state === "failed" ? HOUR : DAY)) return cached;
    inflight ??= ask().then((r) => (cached = r)).finally(() => { inflight = null; });
    return inflight;
  };
}
