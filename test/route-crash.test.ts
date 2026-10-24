import { describe, it, expect, beforeEach, vi } from "vitest";
import { fakeD1 } from "./helpers.js";
import type { Env } from "../src/worker/env.js";

// #108: the route boundary of POST /api/feedback. orchestrateFeedback is mocked so
// it can crash or answer the persist failure; the rest of the route is real.
const orchestrate = vi.hoisted(() => ({ impl: async (): Promise<unknown> => ({ http: 200, body: {} }) }));
vi.mock("../src/worker/orchestrate.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/worker/orchestrate.js")>();
  return { ...real, orchestrateFeedback: () => orchestrate.impl() };
});

const { app } = await import("../src/worker/app.js");
const { __clearConfigCache } = await import("../src/worker/config.js");

const FID = "22222222-2222-4222-8222-222222222222";
const configJson = JSON.stringify({
  projectId: "demo",
  templates: [{ type: "bug", label: "Bug", fields: [] }],
  llm: { provider: "off" },
  tracker: { kind: "github", defaultRepo: "acme/site", patSecret: "GITHUB_PAT_default" },
  auth: { origins: [] },
});
const body = JSON.stringify({ v: 1, feedbackId: FID, type: "bug", message: "kaputt", pageUrl: "https://acme.dev" });

function env(feedbackLookup: (params: unknown[]) => unknown): Env {
  return {
    DB: fakeD1((sql, params) => {
      if (sql.includes("FROM projects")) return { config: configJson, config_version: 1 };
      if (sql.includes("FROM feedback")) return feedbackLookup(params);
      return null;
    }),
    FK_ENV: "test",
  } as unknown as Env;
}

const post = (e: Env) => app.request("/api/feedback?project=fk_pub_x", { method: "POST", body }, e);

describe("POST /api/feedback — crash handler (#108)", () => {
  beforeEach(() => {
    __clearConfigCache();
    orchestrate.impl = async () => {
      throw new Error("boom");
    };
  });

  it("answers 503 FK_PERSIST_FAILED with Retry-After when no row is stored", async () => {
    const res = await post(env(() => null));
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(await res.json()).toMatchObject({ status: "error", code: "FK_PERSIST_FAILED", retryable: true });
  });

  it("answers 503 when D1 cannot confirm the row either", async () => {
    const res = await post(
      env(() => {
        throw new Error("D1 down");
      }),
    );
    expect(res.status).toBe(503);
  });

  it("answers issue_failed with the stored row id once the row is confirmed", async () => {
    let seen: unknown[] = [];
    const res = await post(
      env((params) => {
        seen = params;
        return { id: "row-1" };
      }),
    );
    expect(seen).toEqual(["demo", FID]); // looked up by project and client feedbackId
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "issue_failed", id: "row-1" });
  });

  it("passes the persist failure's status and Retry-After through", async () => {
    const { persistFailed } = await import("../src/worker/orchestrate.js");
    orchestrate.impl = async () => persistFailed();
    const res = await post(env(() => null));
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
  });
});
