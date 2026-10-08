// Capture policy, host context, privacy link, URL redaction, retention — the
// knobs a consumer app needs before it can embed the widget for all users.
import { describe, it, expect, beforeEach } from "vitest";
import { FeedbackConfig, FeedbackPayload } from "../src/shared/contract.js";
import { toPublicConfig } from "../src/shared/projection.js";
import { renderIssueBody } from "../src/shared/render.js";
import { redactPageUrl } from "../src/shared/page-url.js";
import { readHostContext } from "../src/widget/lib/host-context.js";
import { orchestrateFeedback, applyCapturePolicy } from "../src/worker/orchestrate.js";
import { pruneExpiredRecords, DEDUP_TTL_MS } from "../src/worker/storage/retention.js";
import { ipKey, hourWindow } from "../src/worker/security/ratelimit.js";
import { app } from "../src/worker/app.js";
import { __clearConfigCache } from "../src/worker/config.js";
import { verifyTurnstile, TURNSTILE_ACTION } from "../src/worker/security/turnstile.js";
import { fakeD1 } from "./helpers.js";
import type { ChatFn } from "../src/worker/llm/client.js";
import type { FetchFn } from "../src/worker/providers/github.js";
import type { Env } from "../src/worker/env.js";

const base = {
  projectId: "nora",
  locale: "de",
  templates: [{ type: "bug", label: "Bug", fields: [] }],
  llm: { provider: "custom", model: "m", baseUrl: "https://llm.example/v1" },
  tracker: { kind: "github", defaultRepo: "acme/app", patSecret: "GITHUB_PAT_default" },
  auth: { origins: ["https://app.example"] },
};
const cfg = (over: Record<string, unknown> = {}) => FeedbackConfig.parse({ ...base, ...over });

const UUID = "11111111-1111-4111-8111-111111111111";
const payload = (over: Record<string, unknown> = {}) =>
  FeedbackPayload.parse({ v: 1, feedbackId: UUID, type: "bug", message: "Knopf tut nichts", pageUrl: "https://app.example/app/", ...over });

describe("config: capture, privacyUrl, turnstile", () => {
  it("defaults to today's behaviour (screenshot optional, console on)", () => {
    expect(cfg().capture).toEqual({ screenshot: "optional", console: true });
  });
  it("accepts screenshot off / console off", () => {
    expect(cfg({ capture: { screenshot: "off", console: false } }).capture).toEqual({ screenshot: "off", console: false });
  });
  it("requires an https privacy URL", () => {
    expect(() => cfg({ privacyUrl: "http://app.example/privacy" })).toThrow();
    expect(cfg({ privacyUrl: "https://app.example/privacy" }).privacyUrl).toBe("https://app.example/privacy");
  });
  it("requires the Turnstile secret to name a TURNSTILE_SECRET_<name> binding", () => {
    expect(() => cfg({ turnstile: { siteKey: "0x4AAA", secret: "LLM_API_KEY" } })).toThrow();
    expect(cfg({ turnstile: { siteKey: "0x4AAA", secret: "TURNSTILE_SECRET_main" } }).turnstile?.secret).toBe("TURNSTILE_SECRET_main");
  });
});

describe("public projection", () => {
  it("carries capture, privacy link and the Turnstile SITE key — never the secret name", () => {
    const pub = toPublicConfig(cfg({ capture: { screenshot: "off" }, privacyUrl: "https://app.example/privacy", turnstile: { siteKey: "0x4AAA", secret: "TURNSTILE_SECRET_main" } }), 1);
    expect(pub.capture).toEqual({ screenshot: "off", console: true });
    expect(pub.privacyUrl).toBe("https://app.example/privacy");
    expect(pub.turnstileSiteKey).toBe("0x4AAA");
    expect(JSON.stringify(pub)).not.toContain("TURNSTILE_SECRET");
  });
  it("omits privacy link and site key when not configured", () => {
    const pub = toPublicConfig(cfg(), 1);
    expect(pub).not.toHaveProperty("privacyUrl");
    expect(pub).not.toHaveProperty("turnstileSiteKey");
  });
});

describe("payload: host context", () => {
  it("accepts a flat, bounded context", () => {
    expect(payload({ context: { userId: "u_1", appVersion: "1.4.2", beta: true, tenant: 7 } }).context).toEqual({ userId: "u_1", appVersion: "1.4.2", beta: true, tenant: 7 });
  });
  it("rejects nested values, bad keys and too many keys", () => {
    expect(() => payload({ context: { user: { id: 1 } } })).toThrow();
    expect(() => payload({ context: { "bad key": "x" } })).toThrow();
    expect(() => payload({ context: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i])) })).toThrow();
    expect(() => payload({ context: { long: "x".repeat(201) } })).toThrow();
  });
});

describe("readHostContext (widget side)", () => {
  it("reads an object or a function, keeps only valid flat entries", () => {
    expect(readHostContext({ userId: "u_1", nested: { a: 1 }, "bad key": 1, n: Number.NaN, ok: false })).toEqual({ userId: "u_1", ok: false });
    expect(readHostContext(() => ({ appVersion: "2.0" }))).toEqual({ appVersion: "2.0" });
  });
  it("truncates long strings and caps the key count", () => {
    const ctx = readHostContext(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, "x".repeat(300)])))!;
    expect(Object.keys(ctx)).toHaveLength(20);
    expect((ctx["k0"] as string).length).toBe(200);
  });
  it("never throws: a throwing callback or junk yields undefined", () => {
    expect(readHostContext(() => { throw new Error("host bug"); })).toBeUndefined();
    expect(readHostContext(undefined)).toBeUndefined();
    expect(readHostContext("user")).toBeUndefined();
    expect(readHostContext([1, 2])).toBeUndefined();
    expect(readHostContext({})).toBeUndefined();
  });
});

describe("redactPageUrl", () => {
  it("keeps origin + path, drops query and fragment", () => {
    expect(redactPageUrl("https://app.example/auth/verify?token=abc123#x")).toBe("https://app.example/auth/verify");
    expect(redactPageUrl("https://app.example/")).toBe("https://app.example/");
  });
  it("leaves non-URLs and non-http schemes alone", () => {
    expect(redactPageUrl("(test page)")).toBe("(test page)");
    expect(redactPageUrl("about:blank")).toBe("about:blank");
  });
});

describe("applyCapturePolicy (server side)", () => {
  it("redacts the URL, drops the Turnstile token, keeps console when allowed", () => {
    const p = applyCapturePolicy(cfg(), payload({ pageUrl: "https://app.example/x?code=secret", turnstileToken: "tok", consoleErrors: [{ level: "error", msg: "boom", ts: 1 }] }));
    expect(p.pageUrl).toBe("https://app.example/x");
    expect(p).not.toHaveProperty("turnstileToken");
    expect(p.consoleErrors).toHaveLength(1);
  });
  it("drops console entries when the project switched console capture off", () => {
    const p = applyCapturePolicy(cfg({ capture: { console: false } }), payload({ consoleErrors: [{ level: "error", msg: "transcript: …", ts: 1 }] }));
    expect(p.consoleErrors).toEqual([]);
  });
});

describe("issue body: app context", () => {
  it("renders the host context as an unverified block, neutralized", () => {
    const body = renderIssueBody(cfg().templates[0]!, { message: "m", fields: {}, pageUrl: "https://app.example/", hostContext: { userId: "u_1", note: "@admin #1" } }, "de");
    expect(body).toContain("### App context");
    expect(body).toContain("not verified");
    expect(body).toContain("userId: u_1");
    expect(body).not.toContain("@admin #1"); // mention/ref defanged
  });
  it("omits the block without context", () => {
    expect(renderIssueBody(cfg().templates[0]!, { message: "m", fields: {}, pageUrl: "https://app.example/" }, "de")).not.toContain("App context");
  });
});

describe("orchestrate: host context reaches the issue, never the LLM", () => {
  it("keeps context out of the LLM request and puts it into the issue", async () => {
    const llmBodies: string[] = [];
    const chat: ChatFn = async (req) => {
      llmBodies.push(String((req as { init: RequestInit }).init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: "Knopf", extracted: {}, missing: [], followUpQuestion: "" }) } }] }), { status: 200 });
    };
    const issues: string[] = [];
    const fetchImpl: FetchFn = async (_url, init) => {
      issues.push(String(init.body));
      return new Response(JSON.stringify({ html_url: "https://github.com/acme/app/issues/1", number: 1 }), { status: 201 });
    };
    const db = fakeD1((sql) => (sql.includes("counters") ? { count: 1 } : null));
    const e = { DB: db, GITHUB_PAT_default: "tok" } as unknown as Env;
    const res = await orchestrateFeedback(e, { config: cfg(), version: 1 }, payload({ context: { userId: "u_secret_42" }, pageUrl: "https://app.example/app/?token=t0k" }), { apiKey: "k", chat, fetchImpl });
    expect(res.body.status).toBe("created");
    expect(llmBodies).toHaveLength(1);
    expect(llmBodies[0]).not.toContain("u_secret_42");
    expect(llmBodies[0]).not.toContain("t0k");
    expect(issues[0]).toContain("u_secret_42");
    expect(issues[0]).not.toContain("t0k");
  });
});

// ── Upload gate ────────────────────────────────────────────────────────────────
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
function uploadEnv(config: Record<string, unknown>) {
  const json = JSON.stringify({ ...base, ...config });
  return {
    DB: fakeD1((sql) => (sql.includes("FROM projects") ? { config: json, config_version: 1 } : sql.includes("counters") ? { count: 1 } : null)),
    UPLOADS: { put: async () => {}, get: async () => null, delete: async () => {} } as unknown as R2Bucket,
    ASSETS: { fetch: async () => new Response("") } as unknown as Fetcher,
    FK_ENV: "test",
  } as unknown as Env;
}

describe("POST /api/upload with capture.screenshot off", () => {
  beforeEach(() => __clearConfigCache());
  it("refuses a page capture (409) but accepts a user-picked file", async () => {
    const e = uploadEnv({ capture: { screenshot: "off" } });
    const shot = await app.request(`/api/upload?project=fk_pub_x&feedbackId=${UUID}&kind=screenshot`, { method: "POST", headers: { Origin: "https://app.example" }, body: PNG }, e);
    expect(shot.status).toBe(409);
    __clearConfigCache();
    const file = await app.request(`/api/upload?project=fk_pub_x&feedbackId=${UUID}&kind=upload`, { method: "POST", headers: { Origin: "https://app.example" }, body: PNG }, e);
    expect(file.status).toBe(200);
  });
});

// ── Retention ──────────────────────────────────────────────────────────────────
function retentionDb(projects: Array<{ id: string; config: string }>) {
  const deletes: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      let params: unknown[] = [];
      const stmt = {
        bind: (...a: unknown[]) => ((params = a), stmt),
        all: async () => ({ results: sql.includes("FROM projects") ? projects : [] }),
        run: async () => {
          deletes.push({ sql, params });
          return { success: true, meta: { changes: 2 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, deletes };
}

describe("pruneExpiredRecords", () => {
  const now = 1_800_000_000_000;
  it("deletes feedback + events past each project's retentionDays, and old dedup rows", async () => {
    const { db, deletes } = retentionDb([
      { id: "nora", config: JSON.stringify({ storage: { retentionDays: 90 } }) },
      { id: "keep", config: JSON.stringify({ storage: {} }) },
      { id: "broken", config: "{not json" },
    ]);
    const n = await pruneExpiredRecords({ DB: db } as unknown as Env, now);
    const cutoff = now - 90 * 86_400_000;
    expect(deletes).toContainEqual({ sql: "DELETE FROM feedback WHERE project_id = ?1 AND created_at < ?2", params: ["nora", cutoff] });
    expect(deletes).toContainEqual({ sql: "DELETE FROM events WHERE project_id = ?1 AND ts < ?2", params: ["nora", cutoff] });
    expect(deletes.some((d) => d.params[0] === "keep" || d.params[0] === "broken")).toBe(false);
    expect(deletes).toContainEqual({ sql: "DELETE FROM dedup WHERE created_at < ?1", params: [now - DEDUP_TTL_MS] });
    expect(n).toEqual({ feedback: 2, events: 2 });
  });
});

// ── Turnstile ──────────────────────────────────────────────────────────────────

const siteverify = (result: object, status = 200) => {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body) });
    return new Response(JSON.stringify(result), { status });
  };
  return { fetchImpl, calls };
};
const check = (over: Record<string, unknown> = {}) => ({ secret: "s3cret", token: "tok", remoteIp: "1.2.3.4", origins: ["https://app.example", "https://*.preview.example"], ...over });

describe("verifyTurnstile", () => {
  it("accepts success + our action + an allowlisted hostname, and sends secret/token/ip", async () => {
    const { fetchImpl, calls } = siteverify({ success: true, action: TURNSTILE_ACTION, hostname: "app.example" });
    expect(await verifyTurnstile({ ...check(), fetchImpl })).toBe(true);
    expect(calls[0]!.url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    const sent = new URLSearchParams(calls[0]!.body);
    expect(sent.get("secret")).toBe("s3cret");
    expect(sent.get("response")).toBe("tok");
    expect(sent.get("remoteip")).toBe("1.2.3.4");
  });
  it("matches wildcard origins and hosts of origins with a port", async () => {
    expect(await verifyTurnstile({ ...check(), fetchImpl: siteverify({ success: true, action: "feedback", hostname: "pr-1.preview.example" }).fetchImpl })).toBe(true);
    expect(await verifyTurnstile({ ...check({ origins: ["http://localhost:8787"] }), fetchImpl: siteverify({ success: true, action: "feedback", hostname: "localhost" }).fetchImpl })).toBe(true);
  });
  it("fails closed: wrong action, foreign hostname, success false, http error, network error", async () => {
    expect(await verifyTurnstile({ ...check(), fetchImpl: siteverify({ success: true, action: "login", hostname: "app.example" }).fetchImpl })).toBe(false);
    expect(await verifyTurnstile({ ...check(), fetchImpl: siteverify({ success: true, action: "feedback", hostname: "evil.example" }).fetchImpl })).toBe(false);
    expect(await verifyTurnstile({ ...check(), fetchImpl: siteverify({ success: false, "error-codes": ["timeout-or-duplicate"] }).fetchImpl })).toBe(false);
    expect(await verifyTurnstile({ ...check(), fetchImpl: siteverify({}, 500).fetchImpl })).toBe(false);
    expect(await verifyTurnstile({ ...check(), fetchImpl: async () => { throw new Error("down"); } })).toBe(false);
  });
  it("never calls Siteverify without a secret or a sane token", async () => {
    const { fetchImpl, calls } = siteverify({ success: true, action: "feedback", hostname: "app.example" });
    expect(await verifyTurnstile({ ...check({ secret: undefined }), fetchImpl })).toBe(false);
    expect(await verifyTurnstile({ ...check({ token: undefined }), fetchImpl })).toBe(false);
    expect(await verifyTurnstile({ ...check({ token: "x".repeat(2049) }), fetchImpl })).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("POST /api/feedback with Turnstile enabled", () => {
  beforeEach(() => __clearConfigCache());
  it("403s a submission without a token before any LLM or tracker work", async () => {
    const json = JSON.stringify({ ...base, turnstile: { siteKey: "0x4AAA", secret: "TURNSTILE_SECRET_main" } });
    const e = {
      DB: fakeD1((sql) => (sql.includes("FROM projects") ? { config: json, config_version: 1 } : sql.includes("counters") ? { count: 1 } : null)),
      UPLOADS: { get: async () => null } as unknown as R2Bucket,
      ASSETS: { fetch: async () => new Response("") } as unknown as Fetcher,
      FK_ENV: "test",
      TURNSTILE_SECRET_main: "s3cret",
    } as unknown as Env;
    const res = await app.request(
      "/api/feedback?project=fk_pub_x",
      { method: "POST", headers: { Origin: "https://app.example", "Content-Type": "application/json" }, body: JSON.stringify({ v: 1, feedbackId: UUID, type: "bug", message: "m", pageUrl: "https://app.example/" }) },
      e,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("verification failed");
  });
});

describe("rate-limit keys never hold a raw IP", () => {
  it("hashes the address: stable per IP, different per IP and per secret, no raw address in the key", async () => {
    const env = { ADMIN_TOKEN: "secret-a" } as unknown as Env;
    const a1 = await ipKey(env, "fb:nora", "203.0.113.7");
    const a2 = await ipKey(env, "fb:nora", "203.0.113.7");
    const b = await ipKey(env, "fb:nora", "203.0.113.8");
    const c = await ipKey({ ADMIN_TOKEN: "secret-b" } as unknown as Env, "fb:nora", "203.0.113.7");
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1).not.toBe(c);
    expect(a1).toMatch(/^fb:nora:[0-9a-f]{32}$/);
    expect(a1).not.toContain("203.0.113");
  });

  it("the daily cron removes finished hourly rows and keeps the daily LLM budget rows", async () => {
    const now = 1_800_000_000_000;
    const { db, deletes } = retentionDb([]);
    await pruneExpiredRecords({ DB: db } as unknown as Env, now);
    expect(deletes).toContainEqual({ sql: "DELETE FROM counters WHERE key NOT LIKE 'llm:%' AND window_start < ?1", params: [hourWindow(now)] });
  });
});
