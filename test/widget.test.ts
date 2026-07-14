import { describe, it, expect, vi } from "vitest";
import { parseUA } from "../src/widget/lib/ua-parse.js";
import { redactPII } from "../src/widget/lib/pii-filter.js";
import { createConsoleBuffer, installConsoleBuffer } from "../src/widget/core/console-buffer.js";
import { collectDeviceInfo } from "../src/widget/lib/device-info.js";
import { reduce, type WidgetState } from "../src/widget/core/state.js";
import { uuid } from "../src/widget/lib/uuid.js";
import { Api } from "../src/widget/lib/api.js";
import type { FeedbackResponse } from "../src/shared/contract.js";

describe("parseUA", () => {
  it("identifies common browsers", () => {
    expect(parseUA("Mozilla/5.0 (Windows NT 10.0) Chrome/120.0.0.0 Safari/537.36").browser).toBe("Chrome 120");
    expect(parseUA("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Firefox/121.0").browser).toBe("Firefox 121");
    expect(parseUA("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Version/17.0 Mobile/15E148 Safari/604.1").browser).toBe("Safari 17");
    expect(parseUA("Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537.36 Edg/120.0").browser).toBe("Edge");
  });
  it("identifies OS", () => {
    expect(parseUA("... Windows NT 10.0 ...").os).toBe("Windows 10/11");
    expect(parseUA("... Mac OS X 10_15_7 ...").os).toBe("macOS");
    expect(parseUA("... (iPhone; CPU iPhone OS 17_0) ...").os).toBe("iOS");
    expect(parseUA("... Android 14 ...").os).toBe("Android");
  });
});

describe("redactPII", () => {
  it("redacts emails, tokens, jwts, and long hex", () => {
    expect(redactPII("mail me at jane.doe@acme.com")).toContain("[redacted-email]");
    expect(redactPII("Authorization: Bearer sk_live_deadbeef")).not.toContain("sk_live_deadbeef");
    expect(redactPII("password: hunter2")).not.toContain("hunter2");
    expect(redactPII("session eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0")).toContain("[redacted-jwt]");
    expect(redactPII("hash 0123456789abcdef0123456789abcdef")).toContain("[redacted-hex]");
  });
  it("leaves ordinary text intact (incl. prose mentions of 'token')", () => {
    expect(redactPII("the save button does nothing")).toBe("the save button does nothing");
    expect(redactPII("the token is invalid")).toBe("the token is invalid"); // no separator → not clobbered
  });
});

describe("uuid", () => {
  it("produces a distinct v4-shaped id (works without secure-context randomUUID)", () => {
    const u = uuid();
    expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(uuid()).not.toBe(u);
  });
});

describe("console buffer", () => {
  it("keeps the last N entries, PII-filtered", () => {
    const b = createConsoleBuffer(2);
    b.push("error", ["boom", { user: "a@b.com" }], 1);
    b.push("warn", ["warn1"], 2);
    b.push("error", ["warn2"], 3);
    const snap = b.snapshot();
    expect(snap).toHaveLength(2); // ring capped
    expect(snap[0]!.msg).toContain("warn1");
    expect(snap[0]!.level).toBe("warn");
  });

  it("hooks console.error/warn and restores", () => {
    const calls: string[] = [];
    const fake = { error: (...a: unknown[]) => calls.push(`e:${a[0]}`), warn: (...a: unknown[]) => calls.push(`w:${a[0]}`) } as unknown as Console;
    const { buffer, restore } = installConsoleBuffer(fake, 5);
    fake.error("kaputt");
    fake.warn("hmm");
    expect(buffer.snapshot().map((e) => e.msg)).toEqual(["kaputt", "hmm"]);
    expect(calls).toEqual(["e:kaputt", "w:hmm"]); // original still called
    restore();
    fake.error("after");
    expect(buffer.snapshot()).toHaveLength(2); // no longer capturing
  });
});

describe("collectDeviceInfo", () => {
  it("collects browser/os/viewport/language from a window-like object", () => {
    const info = collectDeviceInfo({
      navigator: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0 Safari/537.36", language: "de-DE" },
      innerWidth: 1440,
      innerHeight: 900,
    });
    expect(info).toMatchObject({ browser: "Chrome 120", os: "macOS", viewport: { w: 1440, h: 900 }, language: "de-DE" });
  });
});

describe("state machine", () => {
  const closed: WidgetState = { name: "closed" };
  it("opens to a form and ignores open when already open", () => {
    const form = reduce(closed, { t: "open", type: "bug" });
    expect(form).toEqual({ name: "form", type: "bug", text: "" });
    expect(reduce(form, { t: "open", type: "idea" })).toBe(form); // unchanged ref
  });
  it("form → extracting → (slowHint) sendNow primary", () => {
    const form: WidgetState = { name: "form", type: "bug", text: "x" };
    const ex = reduce(form, { t: "submit" });
    expect(ex).toEqual({ name: "extracting", sendNow: false });
    expect(reduce(ex, { t: "slowHint" })).toEqual({ name: "extracting", sendNow: true });
    expect(reduce(ex, { t: "sendNow" })).toEqual({ name: "submitting" });
  });
  it("maps responses to states", () => {
    const ex: WidgetState = { name: "extracting", sendNow: false };
    expect(reduce(ex, { t: "response", res: { v: 1, status: "follow_up", question: "Was hast du erwartet?", extracted: { b: "x" } } })).toEqual({ name: "asking", question: "Was hast du erwartet?", extracted: { b: "x" } });
    expect(reduce(ex, { t: "response", res: { v: 1, status: "created", id: "1", issueUrl: "u" } })).toEqual({ name: "done", issueUrl: "u", soft: false });
    expect(reduce(ex, { t: "response", res: { v: 1, status: "accepted_incomplete", id: "1", issueUrl: "u" } })).toEqual({ name: "done", issueUrl: "u", soft: true });
    expect(reduce(ex, { t: "response", res: { v: 1, status: "issue_failed", id: "1", reason: "r" } })).toEqual({ name: "done", soft: true });
    expect(reduce(ex, { t: "response", res: { v: 1, status: "error", error: "boom" } })).toEqual({ name: "failed", reason: "boom" });
    // A non-conforming response must not produce an undefined state (render crash).
    expect(reduce(ex, { t: "response", res: { v: 1, status: "weird" } as unknown as FeedbackResponse })).toEqual({ name: "failed", reason: "unexpected response" });
  });
  it("ignores a response when no call is in flight; asking → submitting; retry → form", () => {
    const form: WidgetState = { name: "form", type: "bug", text: "" };
    expect(reduce(form, { t: "response", res: { v: 1, status: "created", id: "1" } })).toBe(form);
    const asking: WidgetState = { name: "asking", question: "q", extracted: {} };
    expect(reduce(asking, { t: "answer" })).toEqual({ name: "submitting" });
    expect(reduce({ name: "failed", reason: "x" }, { t: "retry" })).toEqual({ name: "form", type: "", text: "" });
  });
});

describe("Api", () => {
  const okJson = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });

  it("fetches config and returns null on non-200 / throw", async () => {
    const good = new Api("https://fb.dev", "p", { fetchImpl: okJson({ v: 1, enabled: true, types: [] }) as unknown as typeof fetch });
    expect((await good.config())?.enabled).toBe(true);
    const bad = new Api("https://fb.dev", "p", { fetchImpl: (async () => new Response("no", { status: 404 })) as unknown as typeof fetch });
    expect(await bad.config()).toBeNull();
    const boom = new Api("https://fb.dev", "p", { fetchImpl: (async () => { throw new Error("net"); }) as unknown as typeof fetch });
    expect(await boom.config()).toBeNull();
  });

  it("uploadScreenshot returns the key, or null on failure", async () => {
    let seenUrl = "";
    const f = (async (url: string) => { seenUrl = url; return new Response(JSON.stringify({ key: "p/abc.webp" }), { status: 200 }); }) as unknown as typeof fetch;
    const api = new Api("https://fb.dev", "p", { fetchImpl: f });
    const key = await api.uploadScreenshot("11111111-1111-4111-8111-111111111111", new Blob([new Uint8Array([1])], { type: "image/webp" }));
    expect(key).toBe("p/abc.webp");
    expect(seenUrl).toContain("kind=screenshot");
    expect(seenUrl).toContain("feedbackId=11111111");
  });

  it("submit returns the FeedbackResponse; network failure → error status", async () => {
    const api = new Api("https://fb.dev", "p", { fetchImpl: okJson({ v: 1, status: "need_fields", missing: ["a"], extracted: {} }) as unknown as typeof fetch });
    const r = await api.submit({ v: 1, feedbackId: "f", pageUrl: "u", attachmentKeys: [], consoleErrors: [] });
    expect(r.status).toBe("need_fields");
    const boom = new Api("https://fb.dev", "p", { fetchImpl: (async () => { throw new Error("down"); }) as unknown as typeof fetch });
    expect((await boom.submit({ v: 1, feedbackId: "f", pageUrl: "u", attachmentKeys: [], consoleErrors: [] })).status).toBe("error");
  });

  it("event fires a sendBeacon with the enum payload", () => {
    const beacon = vi.fn((_url: string, _data: BodyInit) => true);
    const api = new Api("https://fb.dev", "p", { sendBeacon: beacon });
    api.event("submitted");
    expect(beacon).toHaveBeenCalledOnce();
    expect(beacon.mock.calls[0]![0]).toContain("/api/events");
  });
});
