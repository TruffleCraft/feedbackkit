// Whether the standalone server serves MCP (ADR-015, amendments of 2026-11-11), decided
// from FK_MCP, FK_PUBLIC_URL and the address the server listens on.
//
//   FK_MCP unset   on when FK_PUBLIC_URL is an https origin, else off
//   FK_MCP=on      on; an http FK_PUBLIC_URL is accepted only for localhost (a local test)
//   FK_MCP=off     off, whatever FK_PUBLIC_URL says
//
// MCP is safe to have on without further setup: a connection needs an account's session
// or a scoped API token an owner created, so before the first owner exists nothing can
// connect, and a failed attempt is counted and answered with 429 once it is over its
// limit. It is still refused where the sign-in would travel in clear text, with the reason.

const LOOPBACK = /^(localhost|\[?::1\]?|127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

export const isLoopbackHost = (hostname) => LOOPBACK.test(hostname);

export const MCP_OFF_BODY = {
  error: "not_found",
  error_description:
    "MCP is not enabled on this server. Set FK_PUBLIC_URL to the public https address of this server (or FK_MCP=on for a test on localhost), then restart. See docs/SELF_HOSTING.md, section MCP for agents.",
};

/**
 * @param {{ origin: URL, setting?: string, host?: string }} input origin is the parsed FK_PUBLIC_URL, host the HOST the server binds to
 * @returns {{ enabled: boolean, note: string }} note is the one line the start log and /diag show
 */
export function planMcp({ origin, setting, host = "127.0.0.1" }) {
  const value = (setting ?? "").trim().toLowerCase();
  if (!["", "on", "off"].includes(value)) throw new Error("FK_MCP must be on, off or unset.");
  if (value === "off") return { enabled: false, note: "off (FK_MCP=off)" };
  if (value === "" && origin.protocol !== "https:") {
    return { enabled: false, note: "off (FK_PUBLIC_URL is not an https address; set it, or FK_MCP=on for a local test)" };
  }
  if (origin.protocol !== "https:") {
    if (!isLoopbackHost(origin.hostname)) {
      throw new Error(`FK_MCP=on needs an https FK_PUBLIC_URL: ${origin.origin} would carry the sign-in in clear text. Use the public https address, or FK_MCP=off.`);
    }
    if (!isLoopbackHost(host)) {
      throw new Error(`FK_MCP=on with FK_PUBLIC_URL ${origin.origin} is for a test on this machine only, but HOST=${host} listens on other addresses, where a sign-in would cross the network in clear text. Set HOST=127.0.0.1, or put the server behind https and set FK_PUBLIC_URL to that address.`);
    }
  }
  return { enabled: true, note: `on (issuer ${origin.origin}, resource ${origin.origin}/mcp)` };
}
