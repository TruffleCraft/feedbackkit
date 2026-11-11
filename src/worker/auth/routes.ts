import type { Context, Hono } from "hono";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { WIRE_VERSION } from "../../shared/contract.js";
import { adminGate, identityOf, isSameOriginRequest, sessionGate } from "../admin/auth.js";
import { AuthError, changeRole, cleanName, createInvitedAccount, getAccount, listAccounts, nameKey, ownerExists, removeAccount, type Role } from "./accounts.js";
import { sha256Hex } from "./crypto.js";
import { addPasskey, bootstrapAccountId, completeBootstrap, completeLinked, completeSignIn, defaultPasskeyName } from "./enroll.js";
import { issueLink, openLink, setupUrl } from "./links.js";
import { CSRF_HEADER, SESSION_ABSOLUTE_MS, clearedSessionCookie, csrfToken, listSessions, readSessionToken, sessionCookie, type NewSession } from "./sessions.js";
import { recordAuthFailure } from "./throttle.js";
import { createApiToken, listApiTokens, revokeApiToken, validateTokenInput } from "./tokens.js";
import { authenticationOptions, registrationOptions, relyingParty, verifyAuthentication, verifyRegistration } from "./webauthn.js";
import type { Env } from "../env.js";

// The account API. Public routes under /api/auth (the ceremonies, which cannot
// require a session because they create one), signed-in routes under
// /api/admin (the account page, accounts, tokens). Every state-changing route of
// a signed-in person goes through adminGate, which checks the CSRF token and the
// request origin; the public ones check the origin themselves.

type AppT = Hono<{ Bindings: Env }>;
type Ctx = Context<{ Bindings: Env }>;

const MAX_BODY = 32 * 1024;

async function readJson(c: Ctx): Promise<Record<string, unknown>> {
  const declared = Number(c.req.header("Content-Length") ?? "0");
  if (declared > MAX_BODY) throw new AuthError(400, "FK_BODY_INVALID", "The request body is too large.");
  let value: unknown;
  try {
    const text = await c.req.text();
    if (text.length > MAX_BODY) throw new Error("too large");
    value = text ? JSON.parse(text) : {};
  } catch {
    throw new AuthError(400, "FK_BODY_INVALID", "The request body must be JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AuthError(400, "FK_BODY_INVALID", "The request body must be a JSON object.");
  return value as Record<string, unknown>;
}

const fail = (c: Ctx, e: AuthError, retryAfter?: number) => {
  if (retryAfter) c.header("Retry-After", String(retryAfter));
  return c.json({ v: WIRE_VERSION, status: "error", error: e.message, code: e.code, ...e.extra }, e.status);
};

/** Runs a handler and turns AuthError into the API's error shape. Anything else is a 500 that says nothing about the cause. */
async function guarded(c: Ctx, run: () => Promise<Response>): Promise<Response> {
  c.header("Cache-Control", "no-store");
  try {
    return await run();
  } catch (e) {
    if (e instanceof AuthError) return fail(c, e);
    console.error(`[feedbackkit] auth route failed: ${(e as Error)?.message}`);
    return c.json({ v: WIRE_VERSION, status: "error", error: "internal error", code: "FK_INTERNAL" }, 500);
  }
}

const clientIp = (c: Ctx) => c.req.header("CF-Connecting-IP") ?? "unknown";

/** A refused attempt, counted: 429 with Retry-After when a counter is over its limit, otherwise the plain error. */
async function refused(c: Ctx, e: AuthError, accountId?: string | null): Promise<Response> {
  const f = await recordAuthFailure(c.env, clientIp(c), accountId);
  if (f.limited) return fail(c, new AuthError(429, "FK_AUTH_THROTTLED", "Too many failed attempts from here. Wait a while before you try again. A correct sign-in still works."), f.retryAfter);
  return fail(c, e);
}

function sameOriginOr403(c: Ctx): Response | null {
  return isSameOriginRequest(c.req.raw) ? null : c.json({ v: WIRE_VERSION, status: "error", error: "cross-origin request refused", code: "FK_CSRF" }, 403);
}

const asRegistration = (v: unknown): RegistrationResponseJSON => {
  if (!v || typeof v !== "object" || typeof (v as { id?: unknown }).id !== "string" || typeof (v as { response?: unknown }).response !== "object") throw new AuthError(400, "FK_BODY_INVALID", "The passkey response is missing.");
  return v as RegistrationResponseJSON;
};
const asAuthentication = (v: unknown): AuthenticationResponseJSON => {
  const id = (v as { id?: unknown } | null)?.id;
  if (!v || typeof v !== "object" || typeof id !== "string" || id.length > 1024 || typeof (v as { response?: unknown }).response !== "object" || (v as { response: unknown }).response === null) throw new AuthError(400, "FK_BODY_INVALID", "The passkey response is missing.");
  return v as AuthenticationResponseJSON;
};
const optionalName = (raw: unknown, fallback: string): string => {
  if (raw === undefined || raw === null || raw === "") return fallback;
  return cleanName(raw);
};

async function openSession(c: Ctx, session: NewSession): Promise<{ csrf: string }> {
  // A session cookie that came with the request is dropped: the new one replaces it, so nothing set in advance survives sign-in.
  const old = readSessionToken(c.req.raw);
  if (old) await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?1").bind(await sha256Hex(old)).run().catch(() => {});
  c.header("Set-Cookie", sessionCookie(c.req.raw, session.token, Math.floor(SESSION_ABSOLUTE_MS / 1000)));
  return { csrf: await csrfToken(session.token) };
}

const publicAccount = (a: { id: string; name: string; role: Role }) => ({ id: a.id, name: a.name, role: a.role });

export function registerAuthRoutes(app: AppT): void {
  // ── What a visitor of the admin needs to know before anyone is signed in ────
  app.get("/api/auth/state", (c) =>
    guarded(c, async () => {
      const rp = relyingParty(c.env, c.req.raw);
      return c.json({ v: WIRE_VERSION, ownerExists: await ownerExists(c.env), rpId: rp.rpID, origin: rp.origin });
    }),
  );

  // ── First owner, recovery and invitation: the same two steps ────────────────
  app.post("/api/auth/setup/begin", (c) =>
    guarded(c, async () => {
      const bad = sameOriginOr403(c);
      if (bad) return bad;
      const body = await readJson(c);
      const link = typeof body["token"] === "string" ? await openLink(c.env, body["token"]) : null;
      if (!link) return refused(c, new AuthError(410, "FK_SETUP_LINK_INVALID", "This link is invalid, was already used or has expired. Ask for a new one."));
      const who = await subjectOf(c, link, body["name"]);
      const options = await registrationOptions(c.env, c.req.raw, { purpose: "setup", subject: link.id, accountId: who.accountId, userName: who.name, exclude: [] });
      return c.json({ v: WIRE_VERSION, purpose: link.purpose, name: who.name, expiresAt: link.expiresAt, options });
    }),
  );

  app.post("/api/auth/setup/finish", (c) =>
    guarded(c, async () => {
      const bad = sameOriginOr403(c);
      if (bad) return bad;
      const body = await readJson(c);
      const link = typeof body["token"] === "string" ? await openLink(c.env, body["token"]) : null;
      if (!link) return refused(c, new AuthError(410, "FK_SETUP_LINK_INVALID", "This link is invalid, was already used or has expired. Ask for a new one."));
      const who = await subjectOf(c, link, body["name"]);
      const passkeyName = optionalName(body["passkeyName"], defaultPasskeyName(Date.now()));
      let registration;
      try {
        registration = await verifyRegistration(c.env, c.req.raw, asRegistration(body["response"]), { purpose: "setup", subject: link.id });
      } catch (e) {
        if (e instanceof AuthError && e.code === "FK_PASSKEY_REJECTED") return refused(c, e);
        throw e;
      }
      const userAgent = c.req.header("User-Agent") ?? null;
      const enrolled =
        link.purpose === "bootstrap"
          ? await completeBootstrap(c.env, { link, accountId: who.accountId, name: who.name, nameKey: nameKey(who.name), registration, passkeyName, userAgent })
          : await completeLinked(c.env, { link, account: { id: who.accountId, name: who.name, role: who.role }, registration, passkeyName, userAgent });
      const { csrf } = await openSession(c, enrolled.session);
      console.log("feedbackkit auth", { event: link.purpose === "bootstrap" ? "owner_created" : link.purpose === "recovery" ? "recovered" : "invitation_accepted", accountId: enrolled.account.id });
      return c.json({ v: WIRE_VERSION, status: "signed_in", purpose: link.purpose, account: publicAccount(enrolled.account), csrf }, 201);
    }),
  );

  // ── Passkey sign-in (discoverable credential, no username) ──────────────────
  app.post("/api/auth/signin/begin", (c) =>
    guarded(c, async () => {
      const bad = sameOriginOr403(c);
      if (bad) return bad;
      return c.json({ v: WIRE_VERSION, options: await authenticationOptions(c.env, c.req.raw) });
    }),
  );

  app.post("/api/auth/signin/finish", (c) =>
    guarded(c, async () => {
      const bad = sameOriginOr403(c);
      if (bad) return bad;
      const body = await readJson(c);
      const response = asAuthentication(body["response"]);
      const row = await c.env.DB.prepare(
        `SELECT p.id, p.account_id, p.public_key, p.counter, p.transports, a.name, a.role
         FROM passkeys p JOIN accounts a ON a.id = p.account_id WHERE p.id = ?1 AND a.state = 'active'`,
      )
        .bind(response.id)
        .first<{ id: string; account_id: string; public_key: string; counter: number; transports: string | null; name: string; role: Role }>();
      const refusal = new AuthError(401, "FK_SIGNIN_FAILED", "Sign-in failed. Use a passkey registered for this site.");
      if (!row) return refused(c, refusal);
      let verified;
      try {
        verified = await verifyAuthentication(c.env, c.req.raw, response, {
          id: row.id,
          accountId: row.account_id,
          publicKey: row.public_key,
          counter: Number(row.counter),
          transports: row.transports ? (JSON.parse(row.transports) as string[]) : null,
        });
      } catch (e) {
        if (e instanceof AuthError && e.code === "FK_SIGNIN_FAILED") return refused(c, e, row.account_id);
        throw e;
      }
      let session;
      try {
        session = await completeSignIn(c.env, { passkeyId: row.id, accountId: row.account_id, newCounter: verified.newCounter, challenge: verified.challenge, userAgent: c.req.header("User-Agent") ?? null });
      } catch (e) {
        if (e instanceof AuthError && e.code === "FK_SIGNIN_FAILED") return refused(c, e, row.account_id);
        throw e;
      }
      const { csrf } = await openSession(c, session);
      return c.json({ v: WIRE_VERSION, status: "signed_in", account: publicAccount({ id: row.account_id, name: row.name, role: row.role }), csrf });
    }),
  );

  app.post("/api/auth/signout", (c) =>
    guarded(c, async () => {
      const bad = sameOriginOr403(c);
      if (bad) return bad;
      const token = readSessionToken(c.req.raw);
      if (token) {
        // The session is ended only for the holder of its CSRF token, so a cross-site page cannot sign someone out.
        if (c.req.header(CSRF_HEADER) === (await csrfToken(token))) await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?1").bind(await sha256Hex(token)).run();
        else return c.json({ v: WIRE_VERSION, status: "error", error: "missing or wrong CSRF token", code: "FK_CSRF" }, 403);
      }
      c.header("Set-Cookie", clearedSessionCookie(c.req.raw));
      return c.json({ v: WIRE_VERSION, status: "signed_out" });
    }),
  );

  // ── The signed-in person's own account ──────────────────────────────────────
  app.get("/api/admin/account", (c) =>
    guarded(c, async () => {
      const s = await sessionGate(c);
      if ("res" in s) return s.res;
      const me = s.identity;
      const [passkeys, sessions] = await Promise.all([
        c.env.DB.prepare("SELECT id, name, created_at, last_used_at, device_type, backed_up FROM passkeys WHERE account_id = ?1 ORDER BY created_at, id").bind(me.accountId).all<{ id: string; name: string; created_at: number; last_used_at: number | null; device_type: string | null; backed_up: number }>(),
        listSessions(c.env, me.accountId),
      ]);
      return c.json({
        v: WIRE_VERSION,
        account: { id: me.accountId, name: me.name, role: me.role },
        csrf: me.csrf,
        passkeys: (passkeys.results ?? []).map((p) => ({ id: p.id, name: p.name, createdAt: Number(p.created_at), lastUsedAt: p.last_used_at === null ? null : Number(p.last_used_at), deviceType: p.device_type, backedUp: Boolean(p.backed_up) })),
        sessions: sessions.map((x) => ({ id: x.publicId, current: x.sessionId === me.sessionId, createdAt: x.createdAt, lastSeenAt: x.lastSeenAt, expiresAt: x.expiresAt, userAgent: x.userAgent })),
      });
    }),
  );

  app.post("/api/admin/account/passkeys/begin", (c) =>
    guarded(c, async () => {
      const s = await sessionGate(c);
      if ("res" in s) return s.res;
      const rows = await c.env.DB.prepare("SELECT id FROM passkeys WHERE account_id = ?1").bind(s.identity.accountId).all<{ id: string }>();
      const options = await registrationOptions(c.env, c.req.raw, { purpose: "passkey-add", subject: s.identity.accountId, accountId: s.identity.accountId, userName: s.identity.name, exclude: (rows.results ?? []).map((r) => r.id) });
      return c.json({ v: WIRE_VERSION, options });
    }),
  );

  app.post("/api/admin/account/passkeys/finish", (c) =>
    guarded(c, async () => {
      const s = await sessionGate(c);
      if ("res" in s) return s.res;
      const body = await readJson(c);
      const registration = await verifyRegistration(c.env, c.req.raw, asRegistration(body["response"]), { purpose: "passkey-add", subject: s.identity.accountId });
      const name = optionalName(body["name"], defaultPasskeyName(Date.now()));
      await addPasskey(c.env, { accountId: s.identity.accountId, registration, passkeyName: name });
      console.log("feedbackkit auth", { event: "passkey_added", accountId: s.identity.accountId });
      return c.json({ v: WIRE_VERSION, status: "added", passkey: { id: registration.credentialId, name } }, 201);
    }),
  );

  app.delete("/api/admin/account/passkeys/:id", (c) =>
    guarded(c, async () => {
      const s = await sessionGate(c);
      if ("res" in s) return s.res;
      const id = c.req.param("id");
      // One statement: the delete only happens while the account keeps at least one other passkey.
      const res = await c.env.DB.prepare("DELETE FROM passkeys WHERE id = ?1 AND account_id = ?2 AND (SELECT COUNT(*) FROM passkeys WHERE account_id = ?2) > 1").bind(id, s.identity.accountId).run();
      if (!res.meta?.changes) {
        const exists = await c.env.DB.prepare("SELECT id FROM passkeys WHERE id = ?1 AND account_id = ?2").bind(id, s.identity.accountId).first();
        if (!exists) throw new AuthError(404, "FK_PASSKEY_NOT_FOUND", "No such passkey.");
        throw new AuthError(409, "FK_LAST_PASSKEY", "This is your only passkey. Add another one first, or you could not sign in again.");
      }
      return c.json({ v: WIRE_VERSION, status: "removed" });
    }),
  );

  app.delete("/api/admin/account/sessions/:id", (c) =>
    guarded(c, async () => {
      const s = await sessionGate(c);
      if ("res" in s) return s.res;
      const res = await c.env.DB.prepare("DELETE FROM sessions WHERE public_id = ?1 AND account_id = ?2").bind(c.req.param("id"), s.identity.accountId).run();
      if (!res.meta?.changes) throw new AuthError(404, "FK_SESSION_NOT_FOUND", "No such session.");
      if (c.req.param("id") === s.identity.publicId) c.header("Set-Cookie", clearedSessionCookie(c.req.raw));
      return c.json({ v: WIRE_VERSION, status: "revoked" });
    }),
  );

  app.post("/api/admin/account/sessions/revoke-others", (c) =>
    guarded(c, async () => {
      const s = await sessionGate(c);
      if ("res" in s) return s.res;
      const res = await c.env.DB.prepare("DELETE FROM sessions WHERE account_id = ?1 AND id != ?2").bind(s.identity.accountId, s.identity.sessionId).run();
      return c.json({ v: WIRE_VERSION, status: "revoked", count: Number(res.meta?.changes ?? 0) });
    }),
  );

  // ── Accounts (owners) ────────────────────────────────────────────────────────
  app.get("/api/admin/accounts", (c) =>
    guarded(c, async () => {
      const denied = await adminGate(c, { owner: true });
      if (denied) return denied;
      const accounts = await listAccounts(c.env);
      return c.json({ v: WIRE_VERSION, accounts: accounts.map((a) => ({ id: a.id, name: a.name, role: a.role, state: a.state, passkeys: a.passkeys, createdAt: a.createdAt, lastSeenAt: a.lastSeenAt, linkExpiresAt: a.linkExpiresAt })) });
    }),
  );

  app.post("/api/admin/accounts", (c) =>
    guarded(c, async () => {
      const denied = await adminGate(c, { owner: true });
      if (denied) return denied;
      const me = identityOf(c);
      const body = await readJson(c);
      const name = cleanName(body["name"]);
      const role = body["role"];
      if (role !== "owner" && role !== "member") throw new AuthError(400, "FK_ROLE_INVALID", "Role must be owner or member.");
      const account = await createInvitedAccount(c.env, { name, role, createdBy: me?.via === "session" ? me.accountId : null });
      const link = await issueLink(c.env, { purpose: "invite", accountId: account.id, createdBy: me?.via === "session" ? me.accountId : "owner" });
      console.log("feedbackkit auth", { event: "account_invited", accountId: account.id, by: me?.via === "session" ? me.accountId : null });
      return c.json({ v: WIRE_VERSION, status: "invited", account: { id: account.id, name: account.name, role: account.role, state: account.state }, link: { url: setupUrl(new URL(c.req.url).origin, link.token), expiresAt: link.expiresAt } }, 201);
    }),
  );

  app.post("/api/admin/accounts/:id/link", (c) =>
    guarded(c, async () => {
      const denied = await adminGate(c, { owner: true });
      if (denied) return denied;
      const me = identityOf(c);
      const account = await getAccount(c.env, c.req.param("id"));
      if (!account || account.state === "removed") throw new AuthError(404, "FK_ACCOUNT_NOT_FOUND", "No such account.");
      if (account.state === "active" && account.role === "owner") throw new AuthError(403, "FK_HOST_REQUIRED", "An owner is recovered with the host command (feedbackkit-admin recovery-link, or pnpm admin:link on Cloudflare), not from the admin.");
      const purpose = account.state === "invited" ? "invite" : "recovery";
      const link = await issueLink(c.env, { purpose, accountId: account.id, createdBy: me?.via === "session" ? me.accountId : "owner" });
      console.log("feedbackkit auth", { event: purpose === "invite" ? "invitation_renewed" : "recovery_link_issued", accountId: account.id, by: me?.via === "session" ? me.accountId : null });
      return c.json({ v: WIRE_VERSION, status: "issued", purpose, link: { url: setupUrl(new URL(c.req.url).origin, link.token), expiresAt: link.expiresAt } }, 201);
    }),
  );

  app.patch("/api/admin/accounts/:id", (c) =>
    guarded(c, async () => {
      const denied = await adminGate(c, { owner: true });
      if (denied) return denied;
      const body = await readJson(c);
      if (body["role"] !== "owner" && body["role"] !== "member") throw new AuthError(400, "FK_ROLE_INVALID", "Role must be owner or member.");
      const account = await changeRole(c.env, c.req.param("id"), body["role"]);
      console.log("feedbackkit auth", { event: "role_changed", accountId: account.id, role: body["role"] });
      return c.json({ v: WIRE_VERSION, status: "updated", account: { id: account.id, name: account.name, role: body["role"], state: account.state } });
    }),
  );

  app.delete("/api/admin/accounts/:id", (c) =>
    guarded(c, async () => {
      const denied = await adminGate(c, { owner: true });
      if (denied) return denied;
      await removeAccount(c.env, c.req.param("id"));
      console.log("feedbackkit auth", { event: "account_removed", accountId: c.req.param("id") });
      return c.json({ v: WIRE_VERSION, status: "removed" });
    }),
  );

  // ── API tokens (owners) ──────────────────────────────────────────────────────
  app.get("/api/admin/tokens", (c) =>
    guarded(c, async () => {
      const denied = await adminGate(c, { owner: true });
      if (denied) return denied;
      const now = Date.now();
      const tokens = await listApiTokens(c.env);
      return c.json({
        v: WIRE_VERSION,
        tokens: tokens.map((t) => ({ id: t.id, prefix: t.prefix, name: t.name, access: t.access, projects: t.projects, createdAt: t.createdAt, createdBy: t.createdByName, expiresAt: t.expiresAt, lastUsedAt: t.lastUsedAt, state: t.revokedAt !== null ? "revoked" : t.expiresAt <= now ? "expired" : "active" })),
      });
    }),
  );

  app.post("/api/admin/tokens", (c) =>
    guarded(c, async () => {
      const denied = await adminGate(c, { owner: true });
      if (denied) return denied;
      const me = identityOf(c);
      if (me?.via !== "session") throw new AuthError(403, "FK_SESSION_REQUIRED", "Sign in with a passkey to create a token.");
      const input = validateTokenInput(await readJson(c));
      if (input.projects) {
        const known = await c.env.DB.prepare(`SELECT id FROM projects WHERE id IN (${input.projects.map((_, i) => `?${i + 1}`).join(", ")})`).bind(...input.projects).all<{ id: string }>();
        const have = new Set((known.results ?? []).map((r) => r.id));
        const unknown = input.projects.filter((p) => !have.has(p));
        if (unknown.length) throw new AuthError(400, "FK_TOKEN_INVALID", `Unknown project: ${unknown.join(", ")}.`, { unknown });
      }
      const created = await createApiToken(c.env, { accountId: me.accountId, name: input.name, access: input.access, projects: input.projects, days: input.days });
      console.log("feedbackkit auth", { event: "token_created", tokenId: created.row.id, accountId: me.accountId, access: input.access });
      return c.json({ v: WIRE_VERSION, status: "created", token: created.token, id: created.row.id, prefix: created.row.prefix, name: created.row.name, access: created.row.access, projects: created.row.projects, expiresAt: created.row.expiresAt }, 201);
    }),
  );

  app.delete("/api/admin/tokens/:id", (c) =>
    guarded(c, async () => {
      const denied = await adminGate(c, { owner: true });
      if (denied) return denied;
      await revokeApiToken(c.env, c.req.param("id"));
      console.log("feedbackkit auth", { event: "token_revoked", tokenId: c.req.param("id") });
      return c.json({ v: WIRE_VERSION, status: "revoked" });
    }),
  );
}

/** Who a setup link is for: a new owner (bootstrap) or the existing account it names. */
async function subjectOf(c: Ctx, link: { id: string; purpose: "bootstrap" | "recovery" | "invite"; accountId: string | null }, rawName: unknown): Promise<{ accountId: string; name: string; role: Role }> {
  if (link.purpose === "bootstrap") {
    if (await ownerExists(c.env)) throw new AuthError(409, "FK_OWNER_EXISTS", "This instance already has an owner. Sign in, or ask for a recovery link.");
    return { accountId: await bootstrapAccountId(link.id), name: cleanName(rawName), role: "owner" };
  }
  const account = link.accountId ? await getAccount(c.env, link.accountId) : null;
  const wanted = link.purpose === "invite" ? "invited" : "active";
  if (!account || account.state !== wanted) throw new AuthError(410, "FK_SETUP_LINK_INVALID", "This link is invalid, was already used or has expired. Ask for a new one.");
  return { accountId: account.id, name: account.name, role: account.role };
}
