// Response headers of the consent page and its message pages (authorize.ts).
// Kept free of imports so the E2E server can serve a page with exactly these
// headers and let a real browser post its form.

// Same tokens and font as the admin (pages.ts); no script at all. form-action
// names the client's redirect origin too: browsers apply it to the redirect
// that follows the form post, and that redirect goes back to the app.
export function consentCsp(nonce: string, redirectOrigin: string | null): string {
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

// Not "no-referrer": with it, browsers send `Origin: null` on the page's own
// form POST (Fetch standard, "append a request Origin header"), and the POST
// handler's same-origin check then refuses every click on Allow. "same-origin"
// keeps the Origin on that POST and still sends no Referer to any other site,
// including the client the grant redirects to.
export const CONSENT_REFERRER_POLICY = "same-origin";

export function consentHeaders(nonce: string, redirectOrigin: string | null): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": consentCsp(nonce, redirectOrigin),
    "X-Frame-Options": "DENY",
    "Referrer-Policy": CONSENT_REFERRER_POLICY,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  };
}
