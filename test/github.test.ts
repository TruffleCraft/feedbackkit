import { describe, it, expect } from "vitest";
import { createIssue, checkRepoAccess, TrackerError, type FetchFn } from "../src/worker/providers/github.js";

describe("createIssue", () => {
  it("POSTs title/body/labels and returns the issue url + number", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const f: FetchFn = async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({ html_url: "https://github.com/acme/site/issues/7", number: 7 }), { status: 201 });
    };
    const r = await createIssue({ pat: "tok", repo: "acme/site", title: "[BUG] x", body: "b", labels: ["type/bug"], fetchImpl: f });
    expect(r).toEqual({ url: "https://github.com/acme/site/issues/7", number: 7 });
    expect(captured!.url).toBe("https://api.github.com/repos/acme/site/issues");
    const sent = JSON.parse(captured!.init.body as string);
    expect(sent).toEqual({ title: "[BUG] x", body: "b", labels: ["type/bug"] });
    expect((captured!.init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("throws TrackerError with the status on failure", async () => {
    const f: FetchFn = async () => new Response("nope", { status: 403 });
    await expect(createIssue({ pat: "t", repo: "acme/site", title: "t", body: "b", fetchImpl: f })).rejects.toMatchObject({
      name: "TrackerError",
      status: 403,
    });
  });

  it("throws on an unexpected payload", async () => {
    const f: FetchFn = async () => new Response(JSON.stringify({ nope: true }), { status: 201 });
    await expect(createIssue({ pat: "t", repo: "acme/site", title: "t", body: "b", fetchImpl: f })).rejects.toBeInstanceOf(TrackerError);
  });
});

describe("checkRepoAccess", () => {
  it("ok on 200, surfaces PAT expiry header", async () => {
    const f: FetchFn = async () =>
      new Response("{}", { status: 200, headers: { "github-authentication-token-expiration": "2026-09-01 00:00:00 UTC" } });
    const a = await checkRepoAccess("acme/site", "tok", f);
    expect(a.ok).toBe(true);
    expect(a.patExpiry).toContain("2026-09-01");
  });

  it("explains 404 as a possible one-owner scope problem", async () => {
    const f: FetchFn = async () => new Response("", { status: 404 });
    const a = await checkRepoAccess("acme/site", "tok", f);
    expect(a.ok).toBe(false);
    expect(a.reason).toContain("one owner");
  });

  it("flags 401 as invalid/expired PAT", async () => {
    const f: FetchFn = async () => new Response("", { status: 401 });
    const a = await checkRepoAccess("acme/site", "tok", f);
    expect(a.reason).toContain("invalid or expired");
  });

  it("returns a network-error result instead of throwing", async () => {
    const f: FetchFn = async () => {
      throw new Error("ECONNREFUSED");
    };
    const a = await checkRepoAccess("acme/site", "tok", f);
    expect(a).toMatchObject({ ok: false, status: 0 });
  });
});
