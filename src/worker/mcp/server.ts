// The MCP endpoint (/mcp, ADR-015). It sits behind
// @cloudflare/workers-oauth-provider, which has already checked the OAuth access
// token (audience, expiry) and decrypted the grant's props into ctx.props before
// this code runs. OAuth 2.1 is the only way in: no ADMIN_TOKEN, no Access JWT.
//
// Transport: the Agents SDK's stateless createMcpHandler over MCP SDK v2, one
// McpServer per request, no session ids. responseMode stays "auto": the tools
// emit no progress, so modern clients get one JSON body ("json" would log a
// warning on every request). `legacy` stays at its
// default ("stateless"), so clients still speaking 2025-11-25 are served on the
// same endpoint.
import { McpServer } from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { createMcpHandler } from "agents/mcp/server";
import { hitRateLimit, hourWindow, ipKey } from "../security/ratelimit.js";
import { VERSION, releaseOf } from "../status.js";
import { isScope, type AuthProps } from "./scopes.js";
import { UNTRUSTED, registerTools } from "./tools.js";
import type { Env } from "../env.js";

/** MCP requests allowed per grant (user and client) and hour. */
export const MCP_CALLS_PER_HOUR = 1000;

const INSTRUCTIONS =
  "FeedbackKit turns user feedback from the operator's websites into GitHub issues. This server reads it: " +
  "projects, feedback items, the widget funnel and project config. Start with whoami to see the scopes and tools " +
  "of this grant, then list_projects. Page list_feedback with nextCursor; get_feedback has the full item. " +
  UNTRUSTED +
  " The same goes for hostContext, which the gateway never verifies.";

const detail = (status: number, text: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: text }), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });

/** The grant's props, or null when the token carries none of ours. */
function principalOf(props: Partial<AuthProps> | undefined): AuthProps | null {
  if (!props || typeof props.email !== "string" || !props.email) return null;
  return {
    email: props.email,
    sub: String(props.sub ?? ""),
    clientId: String(props.clientId ?? ""),
    clientName: String(props.clientName ?? "an app"),
    scopes: (Array.isArray(props.scopes) ? props.scopes : []).filter(isScope),
  };
}

/** Builds the McpServer for one request: only the tools the grant's scopes allow. */
export function buildMcpServer(env: Env, principal: AuthProps, origin: string): McpServer {
  const server = new McpServer(
    { name: "feedbackkit", version: releaseOf(env).version || VERSION },
    {
      capabilities: { tools: {} },
      // Ajv (the SDK's Node default) compiles with `new Function`, which workerd
      // forbids; this validator interprets instead.
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
      instructions: INSTRUCTIONS,
    },
  );
  registerTools(server, { env, principal, origin });
  return server;
}

/** The protected API handler for `apiRoute: "/mcp"`. */
export const mcpApi = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const principal = principalOf((ctx as ExecutionContext & { props?: Partial<AuthProps> }).props);
    // The provider only calls us with a valid token; a token without our props
    // was minted for something else.
    if (!principal) return detail(401, "This token carries no FeedbackKit grant. Connect again.");
    if (request.method !== "POST") return detail(405, "MCP endpoint: POST JSON-RPC only", { Allow: "POST" });

    // Per grant: one grant per user, client and resource (workers-oauth-provider 1.x).
    // Hashed like the IP limiter keys, so the counters table holds no email.
    const key = await ipKey(env, "mcp", `${principal.email}|${principal.clientId}`);
    const rl = await hitRateLimit(env, key, hourWindow(), MCP_CALLS_PER_HOUR);
    if (!rl.allowed) {
      const retry = hourWindow() + 3600 - Math.floor(Date.now() / 1000);
      return detail(429, "Too many MCP calls for this connection. Try again later.", { "Retry-After": String(Math.max(1, retry)) });
    }

    const origin = new URL(request.url).origin;
    return createMcpHandler(() => buildMcpServer(env, principal, origin), { route: "/mcp" })(request, env, ctx);
  },
};
