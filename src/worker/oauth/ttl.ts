// Token lifetimes of the gateway's OAuth server, in seconds. Read by the
// provider config and reported by the MCP tool `whoami`, so a client knows when
// to refresh instead of running into a 401.
export const ACCESS_TOKEN_TTL_S = 60 * 60;
export const REFRESH_TOKEN_TTL_S = 30 * 24 * 60 * 60;
