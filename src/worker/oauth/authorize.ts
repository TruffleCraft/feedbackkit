import { AuthorizationError, CimdFetchError, type AuthRequest, type ConsentDescription } from "@cloudflare/workers-oauth-provider";
import type { Context, Hono } from "hono";
import { verifyAccess } from "../admin/access.js";
import { sameOrigin } from "../admin/auth.js";
import { CSS, FAVICON } from "../admin/pages.js";
import { DEFAULT_SCOPES, SCOPE_TEXT, isScope, type AuthProps, type Scope } from "../mcp/scopes.js";
import { OAUTH_PATHS, mcpDisabledResponse } from "./provider.js";
import type { Env } from "../env.js";

// /oauth/authorize (ADR-015): the one OAuth route the gateway owns. The provider
// has already checked the client, redirect URI, PKCE and resource by the time
// parseAuthRequest() returns; this code answers two questions: who is the user,
// and do they allow this app.
//
// Who: a Cloudflare Access sign-in, nothing else. The operator puts this path
// behind the same Access application as /admin, and verifyAccess() checks the
// JWT Access adds. There is no ADMIN_TOKEN fallback: a consent page with a token
// field would teach people to paste the admin token into a page an app sent
// them to.
//
// Allow: an explicit click on a form that carries a single-use handle bound to
// this browser (beginConsent / approveConsent of workers-oauth-provider), posted
// from this origin. Nothing is granted without both an identity and that click.

type AppT = Hono<{ Bindings: Env }>;
type Ctx = Context<{ Bindings: Env }>;

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** The scopes a request gets: the ones it asks for that we know, else the default. */
export function grantedScopes(requested: readonly string[]): Scope[] {
  const known = [...new Set(requested.filter(isScope))];
  return known.length ? known : [...DEFAULT_SCOPES];
}

// Same tokens and font as the admin (pages.ts); no script at all. form-action
// names the client's redirect origin too: browsers apply it to the redirect
// that follows the form post, and that redirect goes back to the app.
function consentCsp(nonce: string, redirectOrigin: string | null): string {
  return [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    "font-src 'self'",
    "img-src data:",
    redirectOrigin ? `form-action 'self' ${redirectOrigin}` : "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");
}

const PAGE_CSS = `
.consent{max-width:460px;margin:0 auto;padding:56px 20px 48px}
.consent .c{padding:28px;display:flex;flex-direction:column;gap:18px}
.consent .mark{display:flex;align-items:center;gap:8px;font-weight:800;font-size:15px;color:var(--ink-2)}
.consent .lead{color:var(--ink-2);margin-top:-8px}
.consent .lbl{font-size:12px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:8px}
.consent ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.consent li{padding:12px 14px;border:1px solid var(--line);border-radius:14px;font-weight:600}
.consent .warn{padding:12px 14px;border-radius:14px;background:var(--danger-soft);color:var(--danger);font-weight:600;font-size:14px}
.consent .actions{display:flex;gap:10px;flex-wrap:wrap}
.consent .actions .b{flex:1}
@media (max-width:640px){.consent{padding-top:24px}.consent .c{padding:20px}}
`;

function page(title: string, inner: string, nonce: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)} · FeedbackKit</title>
<link rel="icon" href="${FAVICON}">
<style nonce="${nonce}">${CSS}${PAGE_CSS}</style>
</head><body>
<main class="consent"><div class="c">
<p class="mark"><svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><rect x="3" y="8" width="30" height="14" rx="7" fill="#7c3aed"/><rect x="15" y="26" width="30" height="14" rx="7" fill="#a78bfa"/></svg>FeedbackKit</p>
${inner}
</div></main>
</body></html>`;
}

function respond(status: number, html: string, nonce: string, redirectOrigin: string | null, base?: Headers): Response {
  const headers = new Headers(base);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Security-Policy", consentCsp(nonce, redirectOrigin));
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cache-Control", "no-store");
  return new Response(html, { status, headers });
}

/** A short page that only says what happened. Nothing on it can grant anything. */
function message(status: number, title: string, text: string): Response {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  return respond(status, page(title, `<h1>${esc(title)}</h1><p class="lead">${esc(text)}</p>`, nonce), nonce, null);
}

const SIGN_IN_REQUIRED = [
  "Sign-in required",
  "Connecting an app takes a Cloudflare Access sign-in, and this request arrived without one. The operator has to put /oauth/authorize behind the Access application of this gateway. Then start again from the app. Nothing was granted.",
] as const;
const EXPIRED = ["This page has expired", "Start again from the app that asked to connect. Nothing was granted."] as const;
const BLOCKED = ["Request blocked", "The form was not sent from this page. Start again from the app that asked to connect. Nothing was granted."] as const;

function redirectOriginOf(uri: string): string | null {
  try {
    const u = new URL(uri);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

function consentPage(details: ConsentDescription, scopes: Scope[], email: string, handle: string, nonce: string): string {
  const name = esc(details.clientName);
  const who = details.clientDomain
    ? `Published by <b>${esc(details.clientDomain)}</b>.`
    : "The app picked this name itself; FeedbackKit can't check it.";
  return page(
    `Connect ${details.clientName}`,
    `<h1 class="wrapany">Connect ${name}</h1>
<p class="lead">${name} wants to read data from this FeedbackKit gateway.</p>
<div><h2 class="lbl">It will be able to</h2>
<ul>${scopes.map((s) => `<li>${esc(SCOPE_TEXT[s])}</li>`).join("")}</ul></div>
<p class="sm muted wrapany">${who} Access goes to <b>${esc(details.redirectHost)}</b>.</p>
${details.redirectIsLoopback ? `<p class="warn">This hands access to an app on your computer. Continue only if you just started connecting from it.</p>` : ""}
<p class="sm wrapany">Signed in as <b>${esc(email)}</b></p>
<form method="post" action="${OAUTH_PATHS.authorize}">
<input type="hidden" name="handle" value="${esc(handle)}">
<div class="actions"><button class="b violet" type="submit" name="decision" value="allow">Allow</button><button class="b ghost" type="submit" name="decision" value="cancel">Cancel</button></div>
</form>`,
    nonce,
  );
}

/** Errors from parseAuthRequest: back to the client only when its redirect URI is trusted. */
function authorizationErrorResponse(e: unknown): Response {
  if (e instanceof AuthorizationError) {
    if (e.redirectTo) return new Response(null, { status: 302, headers: { Location: e.redirectTo, "Cache-Control": "no-store" } });
    return message(400, "Can't connect this app", e.description);
  }
  // A Client ID Metadata Document that could not be fetched or did not validate.
  if (e instanceof CimdFetchError) return message(400, "Can't connect this app", "FeedbackKit couldn't load this app's description. Nothing was granted.");
  throw e;
}

/** The name the consent page showed (the client ID when the client gave none), capped. */
async function clientNameOf(env: Env, request: AuthRequest): Promise<string> {
  const { clientName } = await env.OAUTH_PROVIDER!.describeConsent(request);
  return clientName.trim().slice(0, 80) || "an app";
}

export function registerOAuthRoutes(app: AppT): void {
  // GET: Access identity, then the consent page.
  app.get(OAUTH_PATHS.authorize, async (c: Ctx) => {
    const oauth = c.env.OAUTH_PROVIDER;
    if (!oauth) return mcpDisabledResponse();
    const identity = await verifyAccess(c.env, c.req.raw);
    if (!identity) return message(403, ...SIGN_IN_REQUIRED);

    let authReq: AuthRequest;
    let details: ConsentDescription;
    try {
      authReq = await oauth.parseAuthRequest(c.req.raw);
      // Before beginConsent: a failed client lookup then leaves nothing in KV.
      details = await oauth.describeConsent(authReq);
    } catch (e) {
      return authorizationErrorResponse(e);
    }
    const consent = await oauth.beginConsent(authReq);
    const nonce = crypto.randomUUID().replace(/-/g, "");
    const html = consentPage(details, grantedScopes(authReq.scope), identity.email, consent.handle, nonce);
    return respond(200, html, nonce, redirectOriginOf(authReq.redirectUri), consent.headers);
  });

  // POST: the click. Allow completes the grant; anything else declines it.
  app.post(OAUTH_PATHS.authorize, async (c: Ctx) => {
    const oauth = c.env.OAUTH_PROVIDER;
    if (!oauth) return mcpDisabledResponse();
    // Access sends its cookie cross-site (SameSite=None), so check where the
    // form came from before trusting the Access identity on a POST.
    if (!sameOrigin(c)) return message(403, ...BLOCKED);
    const identity = await verifyAccess(c.env, c.req.raw);
    if (!identity) return message(403, ...SIGN_IN_REQUIRED);

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
      const approved = await oauth.approveConsent(c.req.raw, handle);
      // What the stored request asked for decides, never a form field: it is
      // the same request the page was built from.
      const scopes = grantedScopes(approved.request.scope);
      const clientName = await clientNameOf(c.env, approved.request);
      const props: AuthProps = { email: identity.email, sub: identity.sub, clientId: approved.request.clientId, clientName, scopes };
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        // The provider forbids ":" in user ids; encoding keeps any email valid.
        userId: encodeURIComponent(identity.email),
        metadata: { clientName, email: identity.email, grantedAt: new Date().toISOString() },
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
