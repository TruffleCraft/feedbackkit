// Whether the standalone server serves MCP (ADR-015, amendment of 2026-11-11), decided
// from FK_MCP, FK_PUBLIC_URL and the address the server listens on.
//
//   FK_MCP unset   off. The server has no sign-in for approving a connection yet (accounts, Gate 2),
//                  so there is nothing to turn on. The accounts change makes this "on when
//                  FK_PUBLIC_URL is an https origin"
//   FK_MCP=on      the plumbing is served: the OAuth endpoints and /mcp answer, and /oauth/authorize
//                  refuses every connection because no identity exists. A preview for people who
//                  build on it, not a feature. Needs https, or localhost for a test
//   FK_MCP=off     off
//
// Where a sign-in would travel in clear text, the server does not start with MCP on.

const LOOPBACK = /^(localhost|\[?::1\]?|127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

export const isLoopbackHost = (hostname) => LOOPBACK.test(hostname);

export const MCP_OFF_BODY = {
  error: "not_found",
  error_description:
    "MCP is not available on this server yet: approving a connection needs an account sign-in, and accounts are not built. See docs/SELF_HOSTING.md, section MCP for agents.",
};

/**
 * @param {{ origin: URL, setting?: string, host?: string }} input origin is the parsed FK_PUBLIC_URL, host the HOST the server binds to
 * @returns {{ enabled: boolean, note: string }} note is the one line the start log and /diag show
 */
export function planMcp({ origin, setting, host = "127.0.0.1" }) {
  const value = (setting ?? "").trim().toLowerCase();
  if (!["", "on", "off"].includes(value)) throw new Error("FK_MCP must be on, off or unset.");
  if (value === "off") return { enabled: false, note: "off (FK_MCP=off)" };
  if (value === "") return { enabled: false, note: "off (approving a connection needs accounts, which are not built yet)" };
  if (origin.protocol !== "https:") {
    if (!isLoopbackHost(origin.hostname)) {
      throw new Error(`FK_MCP=on needs an https FK_PUBLIC_URL: ${origin.origin} would carry the sign-in in clear text. Use the public https address, or unset FK_MCP.`);
    }
    if (!isLoopbackHost(host)) {
      throw new Error(`FK_MCP=on with FK_PUBLIC_URL ${origin.origin} is for a test on this machine only, but HOST=${host} listens on other addresses, where a sign-in would cross the network in clear text. Set HOST=127.0.0.1, or put the server behind https and set FK_PUBLIC_URL to that address.`);
    }
  }
  return { enabled: true, note: `on, but no connection can be approved yet: accounts are not built (issuer ${origin.origin}, resource ${origin.origin}/mcp)` };
}
