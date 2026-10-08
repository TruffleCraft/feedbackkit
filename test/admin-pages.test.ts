// P2 step 3: the admin shell pages (src/worker/admin/pages.ts). They are
// public, carry a strict nonce CSP and never contain data: no D1 access, and
// nothing from the URL is reflected into the markup.
import { describe, it, expect } from "vitest";
import { app } from "../src/worker/app.js";
import { adminViewFor, ADMIN_CSP } from "../src/worker/admin/pages.js";
import { fakeD1 } from "./helpers.js";
import type { Env } from "../src/worker/env.js";

let dbCalls = 0;
function env(): Env {
  return {
    DB: fakeD1(() => {
      dbCalls++;
      return { id: "secret-project", public_key: "fk_pub_leakleak", config: "{}", config_version: 1, updated_at: 0 };
    }),
    UPLOADS: {} as R2Bucket,
    ADMIN_TOKEN: "adm1n-s3cret-token",
    GITHUB_PAT_default: "github_pat_SECRETVALUE",
  } as unknown as Env;
}

const PATHS = ["/admin", "/admin/", "/admin/system", "/admin/projects/harborline"];

describe("admin shell pages", () => {
  it.each(PATHS)("%s answers 200 with the strict headers", async (path) => {
    const res = await app.request(path, {}, env());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/^text\/html/);
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    const nonce = /'nonce-([0-9a-f]{32})'/.exec(csp)?.[1];
    expect(nonce).toBeDefined();
    expect(csp).toBe(ADMIN_CSP(nonce!));
    for (const d of [
      "default-src 'none'",
      `script-src 'self' 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ]) {
      expect(csp).toContain(d);
    }
    expect(csp).not.toContain("unsafe-inline");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const html = await res.text();
    // Every script and style element carries this response's nonce, and the
    // markup has no inline style attributes or event handlers the CSP would block.
    expect(html).toContain(`<script src="/admin.js" nonce="${nonce}" defer></script>`);
    for (const tag of html.match(/<(script|style)\b[^>]*>/g) ?? []) expect(tag).toContain(`nonce="${nonce}"`);
    expect(html).not.toMatch(/\sstyle="/);
    expect(html).not.toMatch(/\son[a-z]+="/);
  });

  it("uses a fresh nonce per response", async () => {
    const a = (await app.request("/admin", {}, env())).headers.get("Content-Security-Policy");
    const b = (await app.request("/admin", {}, env())).headers.get("Content-Security-Policy");
    expect(a).not.toBe(b);
  });

  it("holds no data: no D1 read, no secrets, no project values", async () => {
    dbCalls = 0;
    for (const path of PATHS) {
      const html = await (await app.request(path, {}, env())).text();
      for (const leak of ["secret-project", "fk_pub_leakleak", "adm1n-s3cret-token", "github_pat_SECRETVALUE"]) expect(html).not.toContain(leak);
    }
    expect(dbCalls).toBe(0);
  });

  it("does not reflect the project id from the URL", async () => {
    const res = await app.request("/admin/projects/%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E", {}, env());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("%3Cimg");
  });

  it("renders the view the path asks for", async () => {
    const view = async (path: string) => /<body data-view="([a-z]+)">/.exec(await (await app.request(path, {}, env())).text())?.[1];
    expect(await view("/admin")).toBe("projects");
    expect(await view("/admin/system")).toBe("system");
    expect(await view("/admin/projects/x")).toBe("project");
  });

  it("other /admin paths are not admin pages", async () => {
    expect((await app.request("/admin/nope", {}, env())).status).toBe(404);
    expect((await app.request("/admin/projects/a/b", {}, env())).status).toBe(404);
    expect(adminViewFor("/admin/projects/")).toBeNull();
    expect(adminViewFor("/admin.js")).toBeNull();
    expect(adminViewFor("/administrator")).toBeNull();
  });

  it("leaves the admin API untouched", async () => {
    const res = await app.request("/api/admin/projects", {}, env());
    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });
});
