// The account system's public surface. Other code (the admin routes, the MCP
// consent step) imports from here and never from the files behind it.
export { authenticateAccount, csrfToken, csrfValid, CSRF_HEADER } from "./sessions.js";
export { registerAuthRoutes } from "./routes.js";
export { ownerExists } from "./accounts.js";
export type { Role } from "./accounts.js";
