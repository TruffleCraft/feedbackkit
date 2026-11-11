// Whether the standalone server serves MCP (ADR-015, amendment of 2026-11-11), decided
// from FK_PUBLIC_URL, FK_MCP and the address the server listens on.
//
//   FK_MCP unset   on when FK_PUBLIC_URL is an https origin, else off
//   FK_MCP=on      on; an http FK_PUBLIC_URL is accepted only for localhost (a local test)
//   FK_MCP=off     off, whatever FK_PUBLIC_URL says
//
// MCP asks the operator to type the ADMIN_TOKEN into a consent page, so it never runs
// where that page would travel in clear text. Anything that would is refused at start
// with the reason, instead of starting and being unsafe.

const LOOPBACK = /^(localhost|\[?::1\]?|127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

export const isLoopbackHost = (hostname) => LOOPBACK.test(hostname);

export const MCP_OFF_BODY = {
  error: "not_found",
  error_description:
    "MCP is not enabled on this server. Set FK_PUBLIC_URL to the public https address of this server (or FK_MCP=on for a test on localhost), then restart. See docs/SELF_HOSTING.md, section MCP for agents.",
};

/**
 * @param {{ origin: URL, setting?: string, host?: string }} input origin is the parsed FK_PUBLIC_URL, host the HOST the server binds to
 * @returns {{ enabled: boolean, note: string }}
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
      throw new Error(`FK_MCP=on needs an https FK_PUBLIC_URL: the consent page asks for the admin token, and ${origin.origin} would send it in clear text. Use the public https address, or FK_MCP=off.`);
    }
    if (!isLoopbackHost(host)) {
      throw new Error(`FK_MCP=on with FK_PUBLIC_URL ${origin.origin} is for a test on this machine only, but HOST=${host} listens on other addresses, where the admin token would cross the network in clear text. Set HOST=127.0.0.1, or put the server behind https and set FK_PUBLIC_URL to that address.`);
    }
  }
  return { enabled: true, note: `on (issuer ${origin.origin}, resource ${origin.origin}/mcp)` };
}
