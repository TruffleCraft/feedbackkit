// The account screens (Gate 2): sign-in, setup, your account, users and API
// tokens. One module for the five static shells in src/worker/admin/auth-pages.ts,
// loaded by them only, so the admin module keeps its budget (ADR-014). It calls
// the account API (src/worker/auth/routes.ts) and the browser's own WebAuthn
// JSON helpers; no library. Every API value reaches the page through
// textContent or a value property, never as HTML. The wording is the approved
// mock's (docs/design/mockups/accounts.md).

import { fillProjects, initShell, markCurrent } from "../admin/shell.js";

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Reply {
  status: number;
  json: J;
  retryAfter: number;
}

const TOKEN_KEY = "fk-admin-token";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const show = (id: string, on = true) => {
  $(id).hidden = !on;
};
const setText = (id: string, s: string) => {
  $(id).textContent = s;
};
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, string> | null, ...kids: Array<string | Node | null | false>): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]!);
  for (const k of kids) if (k) e.append(k);
  return e;
}

// ── storage and theme (wrapped: private windows and blocked storage throw) ───
function store(kind: "session" | "local", key: string, value?: string): string | null {
  try {
    const s = kind === "session" ? sessionStorage : localStorage;
    if (value === undefined) return s.getItem(key);
    s.setItem(key, value);
  } catch {
    /* storage unavailable: the page still works for this load */
  }
  return null;
}

// ── the API ──────────────────────────────────────────────────────────────────
let csrf = "";
async function call(method: string, path: string, body?: unknown): Promise<Reply> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && csrf) headers["X-CSRF-Token"] = csrf;
  try {
    const res = await fetch(path, { method, headers, cache: "no-store", credentials: "same-origin", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    let json: J = {};
    try {
      json = (await res.json()) as J;
    } catch {
      /* not JSON */
    }
    return { status: res.status, json, retryAfter: Number(res.headers.get("Retry-After") ?? 0) };
  } catch {
    return { status: 0, json: {}, retryAfter: 0 };
  }
}
const errText = (r: Reply) => (r.status === 0 ? MSG.offline : typeof r.json["error"] === "string" ? (r.json["error"] as string) : `The gateway answered ${r.status}.`);

const MSG = {
  cancelled: "Sign-in was cancelled. Select Sign in with a passkey to try again.",
  notfound: "No passkey for this site was found on this device. Try the device or password manager where you created it. If you lost it, recover access on the server.",
  rejected: "This passkey was not accepted. Try another passkey, or recover access on the server.",
  offline: "The server did not answer. Check that it is running, then try again.",
  setupCancelled: "Passkey creation was cancelled and nothing was saved. Select Create passkey to try again.",
  setupFailed: "The passkey could not be saved. Try again. The link keeps working until you finish or it expires.",
};
const limited = (r: Reply) => `Too many failed attempts from your network. Try again in ${Math.max(1, Math.ceil(r.retryAfter / 60))} minutes. No account is locked, and a valid passkey is never blocked.`;

// ── WebAuthn (the browser's JSON helpers) ────────────────────────────────────
const secure = () => window.isSecureContext;
const supported = () => typeof PublicKeyCredential !== "undefined" && "parseCreationOptionsFromJSON" in PublicKeyCredential && "parseRequestOptionsFromJSON" in PublicKeyCredential && "toJSON" in PublicKeyCredential.prototype;
const cancelled = (e: unknown) => e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "AbortError");

async function createPasskey(options: J): Promise<J> {
  const c = (await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options as never) })) as PublicKeyCredential;
  return c.toJSON() as J;
}
async function getPasskey(options: J): Promise<J> {
  const c = (await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options as never) })) as PublicKeyCredential;
  return c.toJSON() as J;
}

/** Button label and busy state while the browser asks for the passkey. */
function busy(btn: HTMLButtonElement, on: boolean, idle: string) {
  btn.disabled = on;
  btn.textContent = on ? "Waiting for your passkey…" : idle;
  if (on) btn.setAttribute("aria-busy", "true");
  else btn.removeAttribute("aria-busy");
}
function message(id: string, s: string | null) {
  const m = $(id);
  m.textContent = s ?? "";
  m.hidden = !s;
}

// ── dates and labels ─────────────────────────────────────────────────────────
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (t: number) => {
  const d = new Date(t);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};
const sameDay = (t: number) => new Date(t).toDateString() === new Date().toDateString();
function ago(t: number | null): string {
  if (t === null) return "never";
  const m = Math.floor((Date.now() - t) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  if (m < 1440) return `${Math.floor(m / 60)} hour${m < 120 ? "" : "s"} ago`;
  if (m < 43_200) return `${Math.floor(m / 1440)} day${m < 2880 ? "" : "s"} ago`;
  return day(t);
}
function agent(ua: string | null): string {
  if (!ua) return "Unknown browser";
  const b = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const o = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return o ? `${b} on ${o}` : b;
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ── dialogs and copy buttons ─────────────────────────────────────────────────
function resetDialog(d: HTMLDialogElement) {
  d.querySelectorAll("form").forEach((f) => f.reset());
  d.querySelectorAll<HTMLElement>("[data-pane]").forEach((p) => (p.hidden = p.dataset["pane"] !== "form" && !!d.querySelector('[data-pane="form"]')));
  d.querySelectorAll<HTMLElement>(".err").forEach((m) => (m.hidden = true));
  // A new token or link must not stay in the page after the dialog closes.
  d.querySelectorAll<HTMLInputElement>("input[readonly]").forEach((i) => (i.value = ""));
  d.querySelectorAll<HTMLButtonElement>("button[type=submit], button[id$=-go]").forEach((b) => (b.disabled = false));
}
function pane(d: HTMLElement, name: string) {
  d.querySelectorAll<HTMLElement>("[data-pane]").forEach((p) => (p.hidden = p.dataset["pane"] !== name));
}
function wireDialogs() {
  document.querySelectorAll<HTMLDialogElement>("dialog").forEach((d) => d.addEventListener("close", () => resetDialog(d)));
  document.addEventListener("click", (e) => {
    const t = (e.target as Element).closest<HTMLElement>("[data-dialog],[data-close],[data-copy]");
    if (!t) return;
    if (t.dataset["dialog"]) return void $<HTMLDialogElement>(t.dataset["dialog"]!).showModal();
    if (t.hasAttribute("data-close")) return void t.closest("dialog")?.close();
    const input = $<HTMLInputElement>(t.dataset["copy"]!);
    const label = t.textContent;
    const done = () => {
      t.textContent = "Copied";
      setTimeout(() => (t.textContent = label), 1800);
    };
    input.select();
    if (navigator.clipboard) navigator.clipboard.writeText(input.value).then(done, () => undefined);
    else done();
  });
}

// ── signed-in chrome ─────────────────────────────────────────────────────────
interface Me {
  id: string;
  name: string;
  role: string;
}
function chrome(me: Me, view: string) {
  show("nav");
  show("side-owner", me.role === "owner");
  const who = $("who");
  who.replaceChildren(el("span", { class: "sr" }, "Signed in as "), el("a", { href: "/admin/account", title: "Your account" }, me.name));
  who.hidden = false;
  show("signout");
  markCurrent(view);
  $("signout").addEventListener("click", async () => {
    await call("POST", "/api/auth/signout");
    location.replace("/admin/sign-in");
  });
  // The projects in the sidebar. A failure here is not the page's failure.
  void call("GET", "/api/admin/projects").then((r) => {
    if (r.status === 200) fillProjects((r.json["projects"] as Array<{ id: string }> | undefined) ?? [], null);
  });
}
function notice(s: string) {
  const n = $("notice");
  n.textContent = s;
  n.hidden = false;
}

// ── sign-in ──────────────────────────────────────────────────────────────────
async function signInPage() {
  show("v-signin");
  const me = await call("GET", "/api/admin/me");
  if (me.status === 200) return location.replace("/admin");
  if (me.status !== 401) {
    show("signin-form");
    message("signin-msg", errText(me));
    return;
  }
  if (!me.json["ownerExists"]) {
    show("preowner");
    show("legacy-form");
    $("legacy-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const v = $<HTMLInputElement>("token").value.trim();
      if (!v) return;
      store("session", TOKEN_KEY, v);
      location.assign("/admin");
    });
    return;
  }
  show("signin-form");
  show("signin-locked");
  show("signin-ended", location.hash === "#ended");
  const btn = $<HTMLButtonElement>("signin-btn");
  if (!secure() || !supported()) {
    btn.disabled = true;
    show(!secure() ? "signin-insecure" : "signin-unsupported");
    show("signin-help", false);
    return;
  }
  $("signin-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    message("signin-msg", null);
    show("signin-ended", false);
    busy(btn, true, "Sign in with a passkey");
    const fail = (s: string) => {
      busy(btn, false, "Sign in with a passkey");
      message("signin-msg", s);
    };
    const begin = await call("POST", "/api/auth/signin/begin");
    if (begin.status !== 200) return fail(begin.status === 429 ? limited(begin) : errText(begin));
    const asked = Date.now();
    let response: J;
    try {
      response = await getPasskey(begin.json["options"]);
    } catch (err) {
      // A browser with nothing to offer answers at once; one that showed a prompt and was closed takes a while.
      return fail(cancelled(err) && Date.now() - asked > 800 ? MSG.cancelled : MSG.notfound);
    }
    const fin = await call("POST", "/api/auth/signin/finish", { response });
    if (fin.status === 200) return location.replace("/admin");
    fail(fin.status === 429 ? limited(fin) : fin.status === 401 || fin.status === 400 ? MSG.rejected : errText(fin));
  });
}

// ── setup, invitation and recovery ───────────────────────────────────────────
const SETUP_COPY: Record<string, { h: string; p: string; btn: string }> = {
  bootstrap: { h: "Set up the first owner", p: "You opened a setup link from the server. Choose your name and create a passkey. This account becomes the owner of this gateway.", btn: "Create passkey" },
  invite: { h: "Join FeedbackKit", p: "", btn: "Create passkey" },
  recovery: { h: "Recover access", p: "", btn: "Create new passkey" },
};
const SETUP_STATES = ["st-wait", "st-form", "st-done", "st-bad", "st-exists", "st-nolink"];
const setupState = (id: string) => SETUP_STATES.forEach((s) => show(s, s === id));

async function setupPage() {
  // Pasting a new link into the tab that already shows this page only changes the fragment; start over with it.
  addEventListener("hashchange", () => location.reload());
  const token = location.hash.slice(1);
  // The token sits after the #, so no server or proxy log ever saw it. It leaves the address bar now.
  history.replaceState(null, "", location.pathname);
  if (!token) return setupState("st-nolink");
  const probe = await call("POST", "/api/auth/setup/begin", { token });
  let kind = "bootstrap";
  let who = "";
  if (probe.status === 200) {
    kind = String(probe.json["purpose"]);
    who = String(probe.json["name"]);
  } else if (probe.status === 400 && probe.json["code"] === "FK_NAME_INVALID") kind = "bootstrap"; // the link is good; the first owner still has to choose a name
  else if (probe.status === 409) return setupState("st-exists");
  else if (probe.status === 410) return setupState("st-bad");
  else {
    setupState("st-form");
    message("st-msg", probe.status === 429 ? limited(probe) : errText(probe));
    show("st-btn", false);
    return;
  }
  const copy = SETUP_COPY[kind]!;
  setText("st-h", copy.h);
  setText("st-p", kind === "invite" ? `You were invited to FeedbackKit. Create a passkey to finish the account for ${who}.` : kind === "recovery" ? `Create a new passkey for ${who}.` : copy.p);
  show("st-warn", kind === "recovery");
  setText("st-who", who);
  show("st-name-field", kind === "bootstrap");
  setText("st-btn", copy.btn);
  setupState("st-form");
  const btn = $<HTMLButtonElement>("st-btn");
  if (!secure() || !supported()) {
    btn.disabled = true;
    show(!secure() ? "st-insecure" : "st-unsupported");
    return;
  }
  $("st-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    message("st-msg", null);
    const name = $<HTMLInputElement>("st-name").value.trim();
    busy(btn, true, copy.btn);
    const fail = (s: string) => {
      busy(btn, false, copy.btn);
      message("st-msg", s);
    };
    const route = (r: Reply): boolean => {
      if (r.status === 410) return void setupState("st-bad"), true;
      if (r.status === 409 && r.json["code"] === "FK_OWNER_EXISTS") return void setupState("st-exists"), true;
      return false;
    };
    const begin = await call("POST", "/api/auth/setup/begin", { token, name });
    if (route(begin)) return;
    if (begin.status !== 200) return fail(begin.status === 429 ? limited(begin) : errText(begin));
    let response: J;
    try {
      response = await createPasskey(begin.json["options"]);
    } catch (err) {
      return fail(cancelled(err) ? MSG.setupCancelled : MSG.setupFailed);
    }
    const fin = await call("POST", "/api/auth/setup/finish", { token, name, response });
    if (route(fin)) return;
    if (fin.status !== 201) return fail(fin.status === 429 ? limited(fin) : fin.json["code"] === "FK_PASSKEY_REJECTED" || fin.json["code"] === "FK_PASSKEY_EXISTS" ? MSG.setupFailed : errText(fin));
    const account = fin.json["account"] as Me;
    setText("st-done-who", `${account.name}, ${account.role}`);
    const revoked = Number(fin.json["tokensRevoked"] ?? 0);
    const note = $("st-done-note");
    if (kind === "recovery") note.textContent = revoked ? `${plural(revoked, "API token")} you created ${revoked === 1 ? "was" : "were"} revoked. Create new ones under API tokens.` : "";
    else note.textContent = "Add a second passkey in Your account, so that losing this one does not lock you out.";
    note.hidden = !note.textContent;
    setupState("st-done");
  });
}

// ── the account area ─────────────────────────────────────────────────────────
let me: Me;
let reload: () => Promise<void> = async () => undefined;

async function areaPage(view: string) {
  const r = await call("GET", "/api/admin/me");
  if (r.status === 401) return location.replace("/admin/sign-in");
  if (r.status !== 200) return notice(errText(r));
  if (r.json["via"] !== "session") return notice("This page needs a signed-in account. You are signed in another way. Sign in with a passkey to continue.");
  csrf = String(r.json["csrf"]);
  me = r.json["account"] as Me;
  chrome(me, view);
  show("area");
  // A 401 later in the page means the session ended: back to sign-in, with the reason.
  const guard = (x: Reply) => {
    if (x.status === 401) location.replace("/admin/sign-in#ended");
    return x;
  };
  const loaders: Record<string, (g: typeof guard) => Promise<void>> = { account: accountPage, users: usersPage, tokens: tokensPage };
  reload = () => loaders[view]!(guard);
  await reload();
}

const tag = (t: string) => el("span", { class: "t" }, t);
const smallBtn = (label: string, on: () => void, opts: { danger?: boolean; off?: string } = {}) => {
  const b = el("button", { class: `b text${opts.danger ? " danger" : ""}`, type: "button" }, label);
  if (opts.off) {
    b.disabled = true;
    b.setAttribute("aria-describedby", opts.off);
  } else b.addEventListener("click", on);
  return b;
};
function open(id: string) {
  $<HTMLDialogElement>(id).showModal();
}
function close(id: string) {
  $<HTMLDialogElement>(id).close();
}
/** Runs a confirmed change: shows the server's reason in the dialog when it is refused, closes it and reloads when it worked. */
async function commit(dialog: string, msg: string, run: () => Promise<Reply>, ok = 200): Promise<boolean> {
  message(msg, null);
  const r = await run();
  if (r.status === 401) return void location.replace("/admin/sign-in#ended"), false;
  if (r.status !== ok) return void message(msg, errText(r)), false;
  close(dialog);
  await reload();
  return true;
}

// Your account
async function accountPage(guard: (r: Reply) => Reply) {
  const r = guard(await call("GET", "/api/admin/account"));
  if (r.status !== 200) return notice(`Couldn't load your account. ${errText(r)} Reload the page to try again.`);
  const passkeys = r.json["passkeys"] as J[];
  const sessions = r.json["sessions"] as J[];
  setText("acct-sub", `${me.name} · ${me.role}`);
  const one = passkeys.length === 1;
  show("one-pk", one);
  show("pk-last", one);
  $("pk-list").replaceChildren(
    ...passkeys.map((p) => {
      const used = p["lastUsedAt"] === null ? "Never used" : sameDay(p["lastUsedAt"]) ? "Last used today" : `Last used ${day(p["lastUsedAt"])}`;
      return el(
        "div",
        { class: "item" },
        el("div", { class: "pk" }, el("div", { class: "ttl" }, p["name"]), el("div", { class: "meta" }, tag(p["backedUp"] ? "Synced" : "Device-bound"), tag(`Created ${day(p["createdAt"])}`), tag(used))),
        smallBtn("Remove", () => {
          setText("rm-pk-name", p["name"]);
          $("rm-pk-go").onclick = () => void commit("rm-pk", "rm-pk-msg", () => call("DELETE", `/api/admin/account/passkeys/${encodeURIComponent(p["id"])}`));
          open("rm-pk");
        }, one ? { danger: true, off: "pk-last" } : { danger: true }),
      );
    }),
  );
  $("ses-list").replaceChildren(
    ...sessions.map((s) =>
      el(
        "div",
        { class: "item" },
        el(
          "div",
          { class: "pk" },
          el("div", { class: "ttl" }, s["current"] ? "This browser" : agent(s["userAgent"])),
          el("div", { class: "meta" }, s["current"] ? tag("This session") : null, tag(`${s["current"] ? `${agent(s["userAgent"])} · ` : ""}Signed in ${day(s["createdAt"])}`), tag(s["current"] ? "Active now" : `Last active ${day(s["lastSeenAt"])}`)),
        ),
        smallBtn(s["current"] ? "Sign out" : "Revoke", async () => {
          if (s["current"]) return void $("signout").click();
          guard(await call("DELETE", `/api/admin/account/sessions/${encodeURIComponent(s["id"])}`));
          await reload();
        }),
      ),
    ),
  );
  $<HTMLButtonElement>("revoke-others").disabled = sessions.length < 2;
}

function wireAccountDialogs() {
  $("revoke-others").onclick = async () => {
    await call("POST", "/api/admin/account/sessions/revoke-others");
    await reload();
  };
  $("add-pk-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $<HTMLButtonElement>("add-pk-btn");
    message("add-pk-msg", null);
    if (!secure() || !supported()) return message("add-pk-msg", secure() ? "This browser cannot use passkeys. Update it, or switch to Chrome 129, Edge 129, Firefox 119 or Safari 18.4 or newer." : "Passkeys need a secure connection. Open this page over HTTPS, or at http://localhost.");
    btn.disabled = true;
    show("add-pk-wait");
    const fail = (s: string) => {
      btn.disabled = false;
      show("add-pk-wait", false);
      message("add-pk-msg", s);
    };
    const begin = await call("POST", "/api/admin/account/passkeys/begin");
    if (begin.status !== 200) return fail(errText(begin));
    let response: J;
    try {
      response = await createPasskey(begin.json["options"]);
    } catch (err) {
      return fail(cancelled(err) ? MSG.setupCancelled : MSG.setupFailed);
    }
    const name = $<HTMLInputElement>("pk-name").value.trim();
    const fin = await call("POST", "/api/admin/account/passkeys/finish", { response, ...(name ? { name } : {}) });
    if (fin.status !== 201) return fail(fin.json["code"] === "FK_PASSKEY_EXISTS" ? "This passkey is already registered." : fin.json["code"] === "FK_PASSKEY_REJECTED" ? MSG.setupFailed : errText(fin));
    close("add-pk");
    await reload();
  });
}

// Users (the people who can sign in; the API still calls them accounts)
let showRemoved = false;
async function usersPage(guard: (r: Reply) => Reply) {
  const r = guard(await call("GET", `/api/admin/accounts${showRemoved ? "?removed=1" : ""}`));
  if (r.status === 403) {
    show("accts-body", false);
    show("inv-open", false);
    return show("accts-denied");
  }
  if (r.status !== 200) return notice(`Couldn't load users. ${errText(r)} Reload the page to try again.`);
  const all = r.json["accounts"] as J[];
  const live = all.filter((a) => a["state"] !== "removed");
  const owners = live.filter((a) => a["role"] === "owner" && a["state"] === "active");
  setText("accts-sub", `${plural(live.length, "user")} · ${plural(live.filter((a) => a["role"] === "owner").length, "owner")}`);
  $("acct-list").replaceChildren(
    ...all.map((a) => {
      const you = a["id"] === me.id;
      const removed = a["state"] === "removed";
      const invited = a["state"] === "invited";
      const lastOwner = a["role"] === "owner" && a["state"] === "active" && owners.length === 1;
      const stateLabel = removed ? "Removed" : invited ? "Invited" : "Active";
      const meta = removed ? `Removed ${day(a["removedAt"])} · Signed out everywhere` : invited ? `No passkey yet · ${a["linkExpiresAt"] ? `Invitation expires ${day(a["linkExpiresAt"])}` : "Invitation expired"}` : `${plural(a["passkeys"], "passkey")} · Last seen ${a["lastSeenAt"] === null ? "never" : ago(a["lastSeenAt"])}`;
      const helpId = `lo-${a["id"]}`;
      const acts = removed
        ? []
        : [
            invited
              ? smallBtn("New link", async () => {
                  const l = guard(await call("POST", `/api/admin/accounts/${a["id"]}/link`));
                  if (l.status !== 201) return notice(errText(l));
                  linkDialog(a["name"], l.json["link"]);
                })
              : smallBtn(a["role"] === "owner" ? "Make member" : "Make owner", () => roleDialog(a), lastOwner ? { off: helpId } : {}),
            smallBtn("Remove", () => removeDialog(a), { danger: true, ...(lastOwner ? { off: helpId } : {}) }),
          ];
      return el(
        "li",
        { class: `item${removed ? " gone" : ""}` },
        el(
          "div",
          { class: "main" },
          el("div", { class: "ttl" }, a["name"], you ? el("span", { class: "muted" }, " (you)") : null),
          el("div", { class: "meta" }, tag(a["role"] === "owner" ? "Owner" : "Member"), tag(stateLabel), tag(meta)),
          lastOwner ? el("p", { class: "help mt4", id: helpId }, `${a["name"]} is the only owner, so this user cannot be demoted or removed. Make another user an owner first.`) : null,
        ),
        el("div", { class: "acts" }, ...acts),
      );
    }),
  );
}
function names(cls: string, name: string) {
  document.querySelectorAll(`.${cls}`).forEach((n) => (n.textContent = name));
}
function linkDialog(name: string, link: J) {
  names("inv-who", name);
  names("inv-exp", day(link["expiresAt"]));
  $<HTMLInputElement>("inv-link-out2").value = link["url"];
  open("inv-link");
}
function roleDialog(a: J) {
  const toMember = a["role"] === "owner";
  names("mo-who", a["name"]);
  setText("mo-role", toMember ? "a member" : "an owner");
  setText("mo-text", toMember ? `${a["name"]} can no longer manage users or API tokens. ${a["name"]} stays signed in.` : `${a["name"]} can manage users and API tokens, and remove other owners.`);
  setText("mo-go", toMember ? "Make member" : "Make owner");
  $("mo-go").onclick = () => void commit("mk-role", "mo-msg", () => call("PATCH", `/api/admin/accounts/${a["id"]}`, { role: toMember ? "member" : "owner" }));
  open("mk-role");
}
function removeDialog(a: J) {
  names("ra-who", a["name"]);
  $("ra-go").onclick = () => void commit("rm-acct", "ra-msg", () => call("DELETE", `/api/admin/accounts/${a["id"]}`));
  open("rm-acct");
}
function wireUsersDialogs() {
  $("show-removed").addEventListener("click", async (e) => {
    showRemoved = !showRemoved;
    (e.currentTarget as HTMLElement).setAttribute("aria-pressed", String(showRemoved));
    await reload();
  });
  $("inv-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    message("inv-msg", null);
    const name = $<HTMLInputElement>("inv-name").value.trim();
    const role = (document.querySelector<HTMLInputElement>('input[name="role"]:checked')?.value ?? "member") as string;
    if (!name) return message("inv-msg", "Enter a name of 1 to 64 characters.");
    $<HTMLButtonElement>("inv-go").disabled = true;
    const r = await call("POST", "/api/admin/accounts", { name, role });
    $<HTMLButtonElement>("inv-go").disabled = false;
    if (r.status === 401) return location.replace("/admin/sign-in#ended");
    if (r.status !== 201) return message("inv-msg", errText(r));
    names("inv-who", name);
    names("inv-exp", day(r.json["link"]["expiresAt"]));
    $<HTMLInputElement>("inv-link-out").value = r.json["link"]["url"];
    pane($("inv"), "done");
    await reload();
  });
}

// API tokens
async function tokensPage(guard: (r: Reply) => Reply) {
  const r = guard(await call("GET", "/api/admin/tokens"));
  if (r.status === 403) {
    show("tok-body", false);
    show("tok-open", false);
    return show("tok-denied");
  }
  if (r.status !== 200) return notice(`Couldn't load API tokens. ${errText(r)} Reload the page to try again.`);
  const tokens = r.json["tokens"] as J[];
  show("tok-empty", tokens.length === 0);
  $("tok-list").replaceChildren(
    ...tokens.map((t) => {
      const active = t["state"] === "active";
      const meta = active ? `Created by ${t["createdBy"] ?? "a removed user"} ${day(t["createdAt"])} · Expires ${day(t["expiresAt"])} · Last used ${ago(t["lastUsedAt"])}` : t["state"] === "revoked" ? `Revoked ${t["revokedAt"] ? day(t["revokedAt"]) : ""}`.trim() : `Expired ${day(t["expiresAt"])}`;
      return el(
        "li",
        { class: `item${active ? "" : " gone"}` },
        el(
          "div",
          { class: "main" },
          el("div", { class: "ttl" }, t["name"]),
          el("div", { class: "meta" }, tag(t["access"] === "write" ? "Write" : "Read"), tag(t["projects"] ? (t["projects"] as string[]).join(", ") : "All projects"), tag(active ? "Active" : t["state"] === "revoked" ? "Revoked" : "Expired")),
          el("div", { class: "meta" }, el("span", { class: "mono" }, `${t["prefix"]}…`), ` · ${meta}`),
        ),
        el(
          "div",
          { class: "acts" },
          active
            ? smallBtn("Revoke", () => {
                setText("rev-name", t["name"]);
                $("rev-go").onclick = () => void commit("rev", "rev-msg", () => call("DELETE", `/api/admin/tokens/${t["id"]}`));
                open("rev");
              }, { danger: true })
            : null,
        ),
      );
    }),
  );
}
function wireTokenDialogs() {
  const some = () => document.querySelector<HTMLInputElement>('input[name="tk-pr"]:checked')?.value === "some";
  document.querySelectorAll('input[name="tk-pr"]').forEach((r) => r.addEventListener("change", () => show("tk-projects", some())));
  $("tok-open").addEventListener("click", async () => {
    // The project list comes from the admin API when the dialog opens, so it is current.
    const p = await call("GET", "/api/admin/projects");
    const box = $("tk-projects");
    box.replaceChildren(...((p.json["projects"] as J[] | undefined) ?? []).map((x) => el("label", null, el("input", { type: "checkbox", value: x["id"] }), x["id"])));
  });
  $("tok-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    message("tok-msg", null);
    const name = $<HTMLInputElement>("tk-name").value.trim();
    if (!name) return message("tok-msg", "Give the token a name of 1 to 64 characters.");
    const projects = some() ? [...document.querySelectorAll<HTMLInputElement>("#tk-projects input:checked")].map((i) => i.value) : null;
    if (projects && !projects.length) return message("tok-msg", "Choose at least one project, or select All projects.");
    $<HTMLButtonElement>("tok-go").disabled = true;
    const r = await call("POST", "/api/admin/tokens", { name, access: document.querySelector<HTMLInputElement>('input[name="tk-acc"]:checked')?.value, projects, expiresInDays: Number($<HTMLSelectElement>("tk-exp").value) });
    $<HTMLButtonElement>("tok-go").disabled = false;
    if (r.status === 401) return location.replace("/admin/sign-in#ended");
    if (r.status !== 201) return message("tok-msg", errText(r));
    $<HTMLInputElement>("tok-out").value = r.json["token"];
    pane($("tok"), "shown");
    await reload();
  });
}

// ── boot ─────────────────────────────────────────────────────────────────────
function boot() {
  initShell();
  wireDialogs();
  const view = document.body.dataset["view"] ?? "";
  if (view === "sign-in") void signInPage();
  else if (view === "setup") void setupPage();
  else {
    if (view === "account") wireAccountDialogs();
    if (view === "users") wireUsersDialogs();
    if (view === "tokens") wireTokenDialogs();
    void areaPage(view);
  }
}
boot();
