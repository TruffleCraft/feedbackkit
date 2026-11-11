// Gate 2 screens: the five static shells (src/worker/admin/auth-pages.ts). Like the
// other admin pages (admin-pages.test.ts) they are public, carry a strict nonce CSP
// and never contain data: no D1 access, and nothing from the URL in the markup.
// The behavior is clicked in a real browser (e2e/accounts-ui.spec.ts); this file
// holds what a unit test can pin down cheaply.
import { describe, it, expect } from "vitest";
import source from "../src/auth/main.ts?raw";
import { app } from "../src/worker/app.js";
import { ADMIN_CSP } from "../src/worker/admin/pages.js";
import { fakeD1 } from "./helpers.js";
import type { Env } from "../src/worker/env.js";

let dbCalls = 0;
const env = () =>
  ({
    DB: fakeD1(() => {
      dbCalls++;
      return null;
    }),
    UPLOADS: {} as R2Bucket,
  }) as unknown as Env;

const VIEWS: Record<string, string> = {
  "/admin/sign-in": "sign-in",
  "/admin/setup": "setup",
  "/admin/account": "account",
  "/admin/users": "users",
  "/admin/tokens": "tokens",
};

describe("account screen shells", () => {
  it.each(Object.entries(VIEWS))("%s answers 200 with the strict headers and the %s view", async (path, view) => {
    dbCalls = 0;
    const res = await app.request(path, {}, env());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/^text\/html/);
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    const nonce = /'nonce-([0-9a-f]{32})'/.exec(csp)?.[1];
    expect(nonce).toBeDefined();
    expect(csp).toBe(ADMIN_CSP(nonce!));
    expect(csp).not.toContain("unsafe-inline");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const html = await res.text();
    expect(html).toContain(`<body data-view="${view}">`);
    expect(html).toContain('<meta name="robots" content="noindex,nofollow">');
    expect(html).toContain(`<script src="/auth.js" nonce="${nonce}" defer></script>`);
    expect(html).not.toContain("/admin.js"); // the account screens load their own module only
    for (const tag of html.match(/<(script|style)\b[^>]*>/gi) ?? []) expect(tag).toContain(`nonce="${nonce}"`);
    expect(html).not.toMatch(/\sstyle="/i);
    expect(html).not.toMatch(/\son[a-z]+="/i);
    expect(html).not.toContain("\u2014"); // no em dashes in the product text
    expect(dbCalls).toBe(0); // a static shell: no data, so no D1 access
  });

  it("uses a fresh nonce per response and reflects nothing from the URL", async () => {
    const a = await app.request("/admin/setup?x=%3Cscript%3Ealert(1)%3C/script%3E&name=Robin", {}, env());
    const b = await app.request("/admin/setup", {}, env());
    const nonce = (r: Response) => /'nonce-([0-9a-f]{32})'/.exec(r.headers.get("Content-Security-Policy") ?? "")?.[1];
    expect(nonce(a)).not.toBe(nonce(b));
    const html = await a.text();
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("Robin");
  });

  it("redirects the old /admin/accounts to /admin/users", async () => {
    // The page was called Accounts until 2026-11-11; docs, bookmarks and an Access application still point at it.
    const res = await app.request("/admin/accounts", { redirect: "manual" }, env());
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("/admin/users");
    expect(dbCalls).toBe(0);
  });

  it("names the page Users and the own page Your account", async () => {
    const users = await (await app.request("/admin/users", {}, env())).text();
    expect(users).toContain("<title>Users · FeedbackKit admin</title>");
    expect(users).toContain("<h1>Users</h1>");
    expect(users).toContain(">Invite user</button>");
    expect(users).toContain('<a class="b" href="/admin/users" data-nav="users">Users</a>');
    expect(users).not.toContain("Accounts");
    expect(users).not.toContain("Invite someone");
    const own = await (await app.request("/admin/account", {}, env())).text();
    expect(own).toContain("<h1>Your account</h1>");
  });

  it("only answers GET", async () => {
    for (const path of Object.keys(VIEWS)) expect([404, 405]).toContain((await app.request(path, { method: "POST" }, env())).status);
  });

  it("has every element that dist/auth.js looks up by ID", async () => {
    // A typo in an ID would make the page throw while it loads and stay blank, so the IDs the module uses by
    // name ($("…"), show, setText, message) must exist in one of the shells.
    const used = new Set<string>();
    for (const m of source.matchAll(/\b(?:\$|\$<[^>]+>|show|setText|message)\(\s*"([a-z][a-z0-9-]*)"/g)) used.add(m[1]!);
    expect(used.size).toBeGreaterThan(40);
    const htmls = await Promise.all(Object.keys(VIEWS).map(async (p) => (await app.request(p, {}, env())).text()));
    const present = new Set(htmls.flatMap((h) => [...h.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!)));
    expect([...used].filter((id) => !present.has(id))).toEqual([]);
  });

  it("gives every dialog a label and every button a type", async () => {
    for (const path of ["/admin/account", "/admin/users", "/admin/tokens"]) {
      const html = await (await app.request(path, {}, env())).text();
      for (const d of html.matchAll(/<dialog id="([^"]+)" aria-labelledby="([^"]+)"/g)) expect(html, `${path} ${d[1]}`).toContain(`id="${d[2]}"`);
      for (const b of html.matchAll(/<button\b[^>]*>/g)) expect(b[0], `${path} ${b[0]}`).toMatch(/\stype="(button|submit)"/);
    }
  });
});
