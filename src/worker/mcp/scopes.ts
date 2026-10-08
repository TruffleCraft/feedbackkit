// OAuth scopes an MCP grant can carry (ADR-015). Read-only for now; write
// scopes come in a later step. The consent page shows them in these words.

export const SCOPES = ["feedback:read", "config:read"] as const;
export type Scope = (typeof SCOPES)[number];

/** What the user allows, one line per scope on the consent page. */
export const SCOPE_TEXT: Record<Scope, string> = {
  "feedback:read": "Read projects, feedback and funnel numbers",
  "config:read": "Read project configuration",
};

/** Granted when a client asks for none of ours: the smallest useful grant. */
export const DEFAULT_SCOPES: readonly Scope[] = ["feedback:read"];

export const isScope = (s: unknown): s is Scope => typeof s === "string" && (SCOPES as readonly string[]).includes(s);

/** What consent stores in the grant; the provider hands it back on every /mcp request. */
export interface AuthProps {
  /** The Cloudflare Access email of the person who clicked Allow. */
  email: string;
  /** The Access subject (stable user id) of that person. */
  sub: string;
  clientId: string;
  /** The client's name as shown on the consent page. */
  clientName: string;
  scopes: Scope[];
}
