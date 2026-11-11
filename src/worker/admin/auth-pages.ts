import type { Hono } from "hono";
import type { Env } from "../env.js";
import { CSS, FAVICON, SIDEBAR, SPRITE, adminHeaders } from "./pages.js";

// The account screens (Gate 2): /admin/sign-in, /admin/setup, /admin/account,
// /admin/users and /admin/tokens. Static shells like the other admin pages
// (ADR-014): no data, nothing from the URL in the markup, the same nonce CSP.
// dist/auth.js reads /api/auth/state and /api/admin/me, shows the right state
// of the page and fills the lists with textContent. The wording is the approved
// mock's (docs/design/mockups/accounts.md, variants C, A, A) and the layout is
// the Settings layout. No inline style attributes: the CSP allows styles only
// with the nonce.

export type AuthView = "sign-in" | "setup" | "account" | "users" | "tokens";

// The rules the account pages add to the admin stylesheet. They live in these shells only; the
// other admin pages do not load them.
const AUTH_CSS = `
.rows .item .top-line,.pk .top-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pk{min-width:0}
.pk .help{margin-top:2px}
.head-actions{display:flex;gap:8px;flex-wrap:wrap}
@media (max-width:859px){.rows .item .acts{justify-self:start}}
`;

const logo = `<svg width="32" height="32" aria-hidden="true"><use href="#mark"/></svg>`;
const term = (text: string) => `<pre class="term">${text}</pre>`;
const CMD_SETUP = term("feedbackkit-admin setup-link");
const CMD_RECOVER = term("feedbackkit-admin recovery-link");
const CMD_CF_RECOVER = term("pnpm admin:link --recovery");
const CMD_SSH = term("ssh -L 8787:127.0.0.1:8787 user@server");
const CLOUDFLARE_SETUP = `<p class="help">On Cloudflare, run <code class="mono">pnpm admin:link</code> from your checkout. The link works once and expires.</p>`;
const INSECURE = `<p>Passkeys need a secure connection. Open this page over HTTPS, or at <code class="mono">http://localhost</code>. Operators can put a TLS proxy in front of the server, or forward the port with SSH and open <code class="mono">http://localhost:8787</code>:</p>${CMD_SSH}`;
const UNSUPPORTED = `<p>This browser cannot use passkeys. Update it, or switch to Chrome 129, Edge 129, Firefox 119 or Safari 18.4 or newer.</p>`;
const PASSKEY_HELP = `Your device asks you to confirm. The passkey stays with you. The server keeps only its public half.`;

const SIGN_IN = `<section class="login" id="v-signin" hidden>
  <form class="login-card" id="signin-form" novalidate hidden>
    ${logo}
    <h1>Sign in</h1>
    <p>Use a passkey saved on this device, in your password manager or on a security key.</p>
    <button class="b violet full" type="submit" id="signin-btn">Sign in with a passkey</button>
    <p class="help err" id="signin-msg" role="alert" hidden></p>
    <p class="help" id="signin-ended" role="status" hidden>Your session ended. Sign in again.</p>
    <div class="note stack" id="signin-insecure" hidden>${INSECURE}</div>
    <div class="note" id="signin-unsupported" hidden>${UNSUPPORTED}</div>
    <p class="help" id="signin-help">Your device asks you to confirm with a fingerprint, your face, a PIN or a security key.</p>
  </form>
  <div class="hint" id="signin-locked" hidden><details class="lo"><summary>Locked out? Recover access on the server.</summary>
    <p>Anyone with access to the server can issue a recovery link. Run this on the server:</p>${CMD_RECOVER}
    <p>On Cloudflare, run this from your checkout, signed in to your own Cloudflare account:</p>${CMD_CF_RECOVER}
    <p class="help">The link works once and replaces your old passkeys.</p></details></div>
  <div class="login-card" id="preowner" hidden>
    ${logo}
    <h1>Set up the first owner</h1>
    <p>This gateway has no users yet. Run this on the server, then open the link it prints:</p>${CMD_SETUP}
    ${CLOUDFLARE_SETUP}
  </div>
  <form class="login-card" id="legacy-form" novalidate hidden>
    <h2>Sign in with the admin token</h2>
    <p>Paste the admin token from the server environment. It stops working when the first owner exists.</p>
    <div class="field">
      <label for="token">Admin token</label>
      <input class="in mono" id="token" name="token" type="password" autocomplete="off" spellcheck="false" placeholder="Paste token">
    </div>
    <button class="b violet full" type="submit">Sign in</button>
    <p class="help">The token stays in this tab and is gone once you close it.</p>
  </form>
</section>`;

const SETUP = `<section class="login" id="v-setup">
  <p class="help" id="st-wait" role="status">Checking the link…</p>
  <form class="login-card" id="st-form" novalidate hidden>
    ${logo}
    <h1 id="st-h"></h1>
    <p id="st-p"></p>
    <div class="note" id="st-warn" hidden><b>Your old passkeys and sessions will be replaced.</b> Every browser signed in as <span id="st-who"></span> is signed out, and the API tokens you created are revoked. Create new ones afterwards.</div>
    <div class="field" id="st-name-field" hidden>
      <label for="st-name">Your name</label>
      <input class="in" id="st-name" name="name" autocomplete="name" maxlength="64">
      <p class="help">Other users see this name. No email address is needed.</p>
    </div>
    <button class="b violet full" type="submit" id="st-btn">Create passkey</button>
    <p class="help err" id="st-msg" role="alert" hidden></p>
    <div class="note stack" id="st-insecure" hidden>${INSECURE}</div>
    <div class="note" id="st-unsupported" hidden>${UNSUPPORTED}</div>
    <p class="help">${PASSKEY_HELP}</p>
  </form>
  <div class="login-card" id="st-done" hidden>
    ${logo}
    <h1>Passkey created</h1>
    <p>You are signed in as <span id="st-done-who"></span>.</p>
    <div class="note" id="st-done-note" role="status"></div>
    <a class="b violet full" href="/admin">Open the admin</a>
  </div>
  <div class="login-card" id="st-bad" hidden>
    ${logo}
    <h1>This link no longer works</h1>
    <p>Setup, invitation and recovery links work once and expire. This one was used, has expired or is not valid.</p>
    <p>Run <code class="mono">feedbackkit-admin setup-link</code> or <code class="mono">feedbackkit-admin recovery-link</code> on the server for a new link, or ask an owner for a new invitation.</p>
    <a class="b ghost full" href="/admin/sign-in">Go to sign in</a>
  </div>
  <div class="login-card" id="st-exists" hidden>
    ${logo}
    <h1>This gateway already has an owner</h1>
    <p>Setup links only work before the first owner exists. Sign in with your passkey instead.</p>
    <a class="b violet full" href="/admin/sign-in">Go to sign in</a>
  </div>
  <div class="login-card" id="st-nolink" hidden>
    ${logo}
    <h1>Open the setup link</h1>
    <p>This page needs a one-time link from the server. Run this on the server and open the link it prints:</p>${CMD_SETUP}
    ${CLOUDFLARE_SETUP}
  </div>
</section>`;

const dlg = (id: string, labelled: string, inner: string) => `<dialog id="${id}" aria-labelledby="${labelled}">${inner}</dialog>`;
const closeBtn = (text: string, primary = false, autofocus = false) => `<button class="b ${primary ? "violet" : "ghost"}" type="button" data-close${autofocus ? " autofocus" : ""}>${text}</button>`;

const ACCOUNT = `<div class="pagehead"><div><h1>Your account</h1><p id="acct-sub"></p></div></div>
<div class="note" id="one-pk" role="status" hidden>You have one passkey. Add a second, for example on a security key, so that losing this one does not lock you out.</div>
<div class="grp-label">Passkeys</div>
<p class="help">Passkeys sign you in. Keep at least two, on different devices or on a security key.</p>
<div class="kv acct rows" id="pk-list"></div>
<p class="help mt10" id="pk-last" hidden>This is your only passkey, so it cannot be removed. Add another one first.</p>
<div class="head-actions mt10"><button class="b" type="button" data-dialog="add-pk" id="add-pk-open">Add a passkey</button></div>
<div class="grp-label">Sessions</div>
<p class="help">A session is a browser where you are signed in.</p>
<div class="kv acct rows" id="ses-list"></div>
<div class="head-actions mt10"><button class="b" type="button" id="revoke-others">Revoke all other sessions</button></div>
${dlg("add-pk", "add-pk-h", `<form class="stack" id="add-pk-form" novalidate><h2 id="add-pk-h">Add a passkey</h2><div class="field"><label for="pk-name">Name</label><input class="in" id="pk-name" autocomplete="off" maxlength="64"><p class="help">Helps you tell passkeys apart, for example Laptop or Security key.</p></div><p class="help err" id="add-pk-msg" role="alert" hidden></p><p class="help" id="add-pk-wait" role="status" hidden>Your device asks you to confirm.</p><div class="dlg-actions"><button class="b violet" type="submit" id="add-pk-btn">Create passkey</button>${closeBtn("Cancel")}</div></form>`)}
${dlg("rm-pk", "rm-pk-h", `<div class="stack"><h2 id="rm-pk-h">Remove <span id="rm-pk-name"></span>?</h2><p>You can no longer sign in with this passkey. Delete it from your password manager or device as well.</p><p class="help err" id="rm-pk-msg" role="alert" hidden></p><div class="dlg-actions"><button class="b violet" type="button" id="rm-pk-go">Remove passkey</button>${closeBtn("Cancel", false, true)}</div></div>`)}`;

const USERS = `<div class="pagehead"><div><h1>Users</h1><p id="accts-sub"></p></div><button class="b violet" type="button" data-dialog="inv" id="inv-open">Invite user</button></div>
<div id="accts-body">
  <ul class="list rows" id="acct-list"></ul>
  <p class="mt10"><button class="b text" type="button" id="show-removed" aria-pressed="false">Show removed</button></p>
</div>
<div class="note" id="accts-denied" hidden><h3>Only owners can manage Users</h3><p class="help mt4">You do not have access to this page. Ask an owner if you need something changed.</p></div>
${dlg(
  "inv",
  "inv-h",
  `<div data-pane="form"><form class="stack" id="inv-form" novalidate><h2 id="inv-h">Invite user</h2><p class="help">You send the invitation link yourself. The server sends nothing.</p>
<div class="field"><label for="inv-name">Name</label><input class="in" id="inv-name" autocomplete="off" maxlength="64"><p class="help">Other users see this name. No email address is needed.</p></div>
<fieldset><legend>Role</legend><div class="opts"><label class="opt"><input type="radio" name="role" value="member" checked><b>Member</b><span class="help">Can use the whole admin except users and API tokens. Project access arrives in a later release.</span></label>
<label class="opt"><input type="radio" name="role" value="owner"><b>Owner</b><span class="help">Can also manage users and API tokens, and remove other owners.</span></label></div></fieldset>
<p class="help err" id="inv-msg" role="alert" hidden></p>
<div class="dlg-actions"><button class="b violet" type="submit" id="inv-go">Create invitation</button>${closeBtn("Cancel")}</div></form></div>
<div data-pane="done" hidden><div class="stack"><h2 id="inv-h2">Invitation for <span class="inv-who"></span></h2><p>Send this link to <span class="inv-who"></span>. It works once and expires on <span class="inv-exp"></span>.</p>
<div class="copybox"><input class="in mono" readonly id="inv-link-out" aria-label="Invitation link"><button class="b ghost" type="button" data-copy="inv-link-out">Copy link</button></div>
<div class="note">The server keeps no copy of this link, so it cannot be shown again. If it gets lost, create a new link.</div>
<div class="dlg-actions">${closeBtn("Done", true)}</div></div></div>`,
)}
${dlg("inv-link", "il-h", `<div class="stack"><h2 id="il-h">New link for <span class="inv-who"></span></h2><p>Send this link to <span class="inv-who"></span>. It works once and expires on <span class="inv-exp"></span>. The earlier link stops working.</p><div class="copybox"><input class="in mono" readonly id="inv-link-out2" aria-label="Invitation link"><button class="b ghost" type="button" data-copy="inv-link-out2">Copy link</button></div><div class="dlg-actions">${closeBtn("Done", true)}</div></div>`)}
${dlg("rm-acct", "ra-h", `<div class="stack"><h2 id="ra-h">Remove <span class="ra-who"></span>?</h2><p><span class="ra-who"></span> is signed out everywhere and loses their passkeys. API tokens <span class="ra-who"></span> created stop working. Reports and settings stay as they are.</p><p class="help err" id="ra-msg" role="alert" hidden></p><div class="dlg-actions"><button class="b violet" type="button" id="ra-go">Remove <span class="ra-who"></span></button>${closeBtn("Cancel", false, true)}</div></div>`)}
${dlg("mk-role", "mo-h", `<div class="stack"><h2 id="mo-h">Make <span class="mo-who"></span> <span id="mo-role"></span>?</h2><p id="mo-text"></p><p class="help err" id="mo-msg" role="alert" hidden></p><div class="dlg-actions"><button class="b violet" type="button" id="mo-go"></button>${closeBtn("Cancel", false, true)}</div></div>`)}`;

const TOKEN_FIELDS = `<div class="field"><label for="tk-name">Name</label><input class="in" id="tk-name" autocomplete="off" maxlength="64"><p class="help">What will use it, for example Setup agent.</p></div>
<fieldset><legend>Access</legend><div class="opts"><label class="opt"><input type="radio" name="tk-acc" value="read" checked><b>Read</b><span class="help">Read reports, projects and settings.</span></label>
<label class="opt"><input type="radio" name="tk-acc" value="write"><b>Write</b><span class="help">Everything Read can do, plus change settings and triage, retry or delete reports. Never users or tokens.</span></label></div></fieldset>
<fieldset><legend>Projects</legend><div class="opts"><label class="opt"><input type="radio" name="tk-pr" value="all" checked><b>All projects</b></label>
<label class="opt"><input type="radio" name="tk-pr" value="some"><b>Only these projects</b><span class="help">A token limited to some projects cannot create projects or open System.</span></label></div>
<div class="checks" id="tk-projects" hidden></div></fieldset>
<div class="field"><label for="tk-exp">Expires</label><select class="in" id="tk-exp"><option value="30">In 30 days</option><option value="90" selected>In 90 days</option><option value="365">In 365 days</option></select><p class="help">Create a new token before this one expires. An expired token is refused.</p></div>`;

const TOKENS = `<div class="pagehead"><div><h1>API tokens</h1><p>For scripts and agents. A token cannot manage users or tokens.</p></div><button class="b violet" type="button" data-dialog="tok" id="tok-open">Create token</button></div>
<div id="tok-body">
  <div class="empty-msg" id="tok-empty" hidden><b>No API tokens yet</b><p class="help mt4">Create one when a script or an agent needs access. They use a token instead of the old admin token.</p></div>
  <ul class="list rows" id="tok-list"></ul>
</div>
<div class="note" id="tok-denied" hidden><h3>Only owners can manage API tokens</h3><p class="help mt4">You do not have access to this page. Ask an owner if you need something changed.</p></div>
${dlg(
  "tok",
  "tok-h",
  `<div data-pane="form"><form class="stack" id="tok-form" novalidate><h2 id="tok-h">Create an API token</h2>${TOKEN_FIELDS}<p class="help err" id="tok-msg" role="alert" hidden></p><div class="dlg-actions"><button class="b violet" type="submit" id="tok-go">Create token</button>${closeBtn("Cancel")}</div></form></div>
<div data-pane="shown" hidden><div class="stack"><h2 id="tok-h2">Copy your token</h2><p>This is the only time you see it. Store it in your password manager or in the secret store of the script or agent.</p>
<div class="copybox"><input class="in mono" readonly id="tok-out" aria-label="New API token"><button class="b ghost" type="button" data-copy="tok-out">Copy token</button></div>
<div class="note">If you lose it, create a new token and revoke this one.</div><div class="dlg-actions">${closeBtn("Done", true)}</div></div></div>`,
)}
${dlg("rev", "rev-h", `<div class="stack"><h2 id="rev-h">Revoke <span id="rev-name"></span>?</h2><p>Anything that uses this token is refused right away. This cannot be undone.</p><p class="help err" id="rev-msg" role="alert" hidden></p><div class="dlg-actions"><button class="b violet" type="button" id="rev-go">Revoke token</button>${closeBtn("Cancel", false, true)}</div></div>`)}`;

const area = (inner: string) => `<div id="area" hidden>${inner}</div>`;

const TITLES: Record<AuthView, string> = { "sign-in": "Sign in", setup: "Set up", account: "Your account", users: "Users", tokens: "API tokens" };

export function renderAuthPage(view: AuthView, nonce: string): string {
  const bare = view === "sign-in" || view === "setup";
  const body = view === "sign-in" ? SIGN_IN : view === "setup" ? SETUP : area(view === "account" ? ACCOUNT : view === "users" ? USERS : TOKENS);
  const main = `<main id="main" class="content">
<div class="notice" id="notice" role="alert" hidden></div>
<noscript><p class="notice">The admin pages need JavaScript.</p></noscript>
${body}
</main>`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${TITLES[view]} · FeedbackKit admin</title>
<link rel="icon" href="${FAVICON}">
<style nonce="${nonce}">${CSS}${AUTH_CSS}</style>
</head><body data-view="${view}"${bare ? ' class="bare"' : ""}>
${SPRITE}
<div class="app">
${SIDEBAR}
${main}
</div>
<script src="/auth.js" nonce="${nonce}" defer></script>
</body></html>`;
}

type AppT = Hono<{ Bindings: Env }>;

/** GET /admin/sign-in, /admin/setup, /admin/account, /admin/users and /admin/tokens: static shells, no D1 access. /admin/accounts redirects to /admin/users. */
export function registerAuthPages(app: AppT): void {
  const serve = (view: AuthView) => (c: import("hono").Context<{ Bindings: Env }>) => {
    const nonce = crypto.randomUUID().replace(/-/g, "");
    for (const [k, v] of Object.entries(adminHeaders(nonce))) c.header(k, v);
    return c.html(renderAuthPage(view, nonce));
  };
  for (const [path, view] of [["/admin/sign-in", "sign-in"], ["/admin/setup", "setup"], ["/admin/account", "account"], ["/admin/users", "users"], ["/admin/tokens", "tokens"]] as const) app.get(path, serve(view));
  // The page was called Accounts until 2026-11-11. Links in docs, bookmarks and an Access application still point at it.
  app.get("/admin/accounts", (c) => c.redirect("/admin/users", 301));
}
