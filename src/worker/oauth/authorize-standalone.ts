import type { AuthRequest, ConsentDescription } from "@cloudflare/workers-oauth-provider";
import { AuthorizationError, CimdFetchError } from "@cloudflare/workers-oauth-provider";
import { checkAdminToken, sameOrigin } from "../admin/auth.js";
import { hitRateLimit, hourWindow, ipKey } from "../security/ratelimit.js";
import type { AuthProps } from "../mcp/scopes.js";
import { OAUTH_PATHS, mcpDisabledResponse } from "./provider.js";
import {
  BLOCKED,
  EXPIRED,
  authorizationErrorResponse,
  clientNameOf,
  consentPage,
  esc,
  grantedScopes,
  message,
  redirectOriginOf,
  respond,
  type AppT,
  type Ctx,
} from "./authorize.js";

// /oauth/authorize on the standalone server (ADR-015, amendment of 2026-11-11).
//
// The Worker proves who the user is with Cloudflare Access. A standalone server
// has no Access, and accounts (Gate 2 in docs/design/scope.md) do not exist yet,
// so for now the one identity there is, the operator, is proved by typing the
// ADMIN_TOKEN into the consent form. The rest of the flow is the Worker's: the
// provider checks client, redirect URI, PKCE and resource, the form carries a
// single-use handle bound to this browser, and nothing is granted without the
// explicit click on Allow.
//
// The token travels in the POST body only. It is never read from a URL or a
// header here, never logged, compared in constant time, and every wrong try is
// counted by the same lockout as the admin API (admin/auth.ts checkAdminToken).

/** Consent pages one client address may open per hour (each one writes a transaction). */
export const AUTHORIZE_VIEWS_PER_HOUR = 60;
/** The longest token the form accepts; the admin token is far shorter. */
const TOKEN_FIELD_MAX = 512;

/** The identity every grant of this runtime carries, until accounts replace it. */
export const STANDALONE_IDENTITY = { email: "admin", sub: "admin-token" } as const;

const clientIp = (c: Ctx) => c.req.header("CF-Connecting-IP") ?? "unknown";

function limited(): Response {
  return message(429, "Too many attempts", "This address has used up its tries for the hour. Wait, then start again from the app. Nothing was granted.");
}

function tokenField(origin: string): string {
  return `<div class="field"><label for="admin-token">Admin token</label>
<input class="in mono" id="admin-token" name="admin_token" type="password" autocomplete="current-password" autocapitalize="off" spellcheck="false" maxlength="${TOKEN_FIELD_MAX}" required>
<p class="sm muted wrapany">The ADMIN_TOKEN of this gateway proves you are the operator. Type it only if the address bar shows <b>${esc(origin)}</b>.</p></div>`;
}

export function registerStandaloneOAuthRoutes(app: AppT): void {
  // GET: the consent page. It grants nothing and shows nothing private, so it
  // needs no sign-in; each view is counted because it stores a transaction.
  app.get(OAUTH_PATHS.authorize, async (c: Ctx) => {
    const oauth = c.env.OAUTH_PROVIDER;
    if (!oauth) return mcpDisabledResponse();
    const views = await hitRateLimit(c.env, await ipKey(c.env, "oauthview", clientIp(c)), hourWindow(), AUTHORIZE_VIEWS_PER_HOUR);
    if (!views.allowed) return limited();

    let authReq: AuthRequest;
    let details: ConsentDescription;
    try {
      authReq = await oauth.parseAuthRequest(c.req.raw);
      // Before beginConsent: a failed client lookup then leaves nothing stored.
      details = await oauth.describeConsent(authReq);
    } catch (e) {
      return authorizationErrorResponse(e);
    }
    const consent = await oauth.beginConsent(authReq);
    const nonce = crypto.randomUUID().replace(/-/g, "");
    const html = consentPage(details, grantedScopes(authReq.scope), "", consent.handle, nonce, tokenField(new URL(c.req.url).origin));
    return respond(200, html, nonce, redirectOriginOf(authReq.redirectUri), consent.headers);
  });

  // POST: the click. Cancel declines and needs no token. Allow needs the token,
  // then completes the grant.
  app.post(OAUTH_PATHS.authorize, async (c: Ctx) => {
    const oauth = c.env.OAUTH_PROVIDER;
    if (!oauth) return mcpDisabledResponse();
    if (!sameOrigin(c)) return message(403, ...BLOCKED);

    let form: FormData;
    try {
      form = await c.req.raw.formData();
    } catch {
      return message(400, ...EXPIRED);
    }
    const handle = String(form.get("handle") ?? "");
    if (!handle || handle.length > 256) return message(400, ...EXPIRED);

    try {
      if (form.get("decision") !== "allow") {
        const denied = await oauth.denyConsent(c.req.raw, handle, { description: "The user declined" });
        return new Response(null, { status: 302, headers: denied.headers });
      }
      // The token first: a wrong one burns neither the handle nor the grant, so
      // a typo can be retried, and every wrong try counts toward the lockout.
      const typed = form.get("admin_token");
      const verdict = await checkAdminToken(c.env, clientIp(c), typeof typed === "string" && typed.length <= TOKEN_FIELD_MAX ? typed : "");
      if (verdict === "limited") return limited();
      if (verdict === "unauthorized") {
        return message(403, "That is not the admin token", "Nothing was granted. Go back and type it again, or start again from the app.");
      }

      const approved = await oauth.approveConsent(c.req.raw, handle);
      // What the stored request asked for decides, never a form field.
      const scopes = grantedScopes(approved.request.scope);
      const clientName = await clientNameOf(c.env, approved.request);
      const props: AuthProps = { ...STANDALONE_IDENTITY, clientId: approved.request.clientId, clientName, scopes };
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: encodeURIComponent(STANDALONE_IDENTITY.email),
        metadata: { clientName, email: STANDALONE_IDENTITY.email, grantedAt: new Date().toISOString() },
        scope: scopes,
        props,
      });
      approved.headers.set("Location", redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    } catch (e) {
      // Expired, already used, or opened in another browser.
      if (e instanceof AuthorizationError) return message(400, ...EXPIRED);
      if (e instanceof CimdFetchError) return authorizationErrorResponse(e);
      throw e;
    }
  });
}
