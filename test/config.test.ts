import { describe, it, expect, beforeEach } from "vitest";
import { loadProject, __clearConfigCache } from "../src/worker/config.js";
import { ConfigError } from "../src/worker/errors.js";
import { hitRateLimit } from "../src/worker/security/ratelimit.js";
import { fakeD1 } from "./helpers.js";
import type { Env } from "../src/worker/env.js";

const validConfig = JSON.stringify({
  projectId: "demo",
  templates: [{ type: "bug", label: "Bug", fields: [] }],
  llm: { provider: "openrouter", model: "m" },
  tracker: { kind: "github", defaultRepo: "acme/site", patSecret: "GITHUB_PAT_default" },
  auth: { origins: ["https://acme.dev"] },
});

function envWith(db: D1Database): Env {
  return { DB: db } as unknown as Env;
}

describe("loadProject", () => {
  beforeEach(() => __clearConfigCache());

  it("loads + parses a project by public key", async () => {
    const env = envWith(fakeD1(() => ({ config: validConfig, config_version: 2 })));
    const loaded = await loadProject(env, "fk_pub_x");
    expect(loaded?.version).toBe(2);
    expect(loaded?.config.projectId).toBe("demo");
  });

  it("returns null for an unknown project", async () => {
    const env = envWith(fakeD1(() => null));
    expect(await loadProject(env, "fk_pub_missing")).toBeNull();
  });

  it("throws ConfigError on invalid config JSON", async () => {
    const env = envWith(fakeD1(() => ({ config: "{not json", config_version: 1 })));
    await expect(loadProject(env, "fk_pub_x")).rejects.toBeInstanceOf(ConfigError);
  });

  it("throws ConfigError when config fails schema validation", async () => {
    const bad = JSON.stringify({ projectId: "demo" }); // missing templates/llm/tracker/auth
    const env = envWith(fakeD1(() => ({ config: bad, config_version: 1 })));
    await expect(loadProject(env, "fk_pub_x")).rejects.toBeInstanceOf(ConfigError);
  });

  it("serves from the isolate cache within the TTL (no second D1 read)", async () => {
    let reads = 0;
    const env = envWith(
      fakeD1(() => {
        reads++;
        return { config: validConfig, config_version: 1 };
      }),
    );
    const t = 1_000_000;
    await loadProject(env, "fk_pub_x", t);
    await loadProject(env, "fk_pub_x", t + 30_000); // within 60s TTL
    expect(reads).toBe(1);
    await loadProject(env, "fk_pub_x", t + 61_000); // past TTL
    expect(reads).toBe(2);
  });
});

describe("hitRateLimit", () => {
  it("allows up to the limit, then blocks (atomic count from RETURNING)", async () => {
    let n = 0;
    const env = envWith(fakeD1(() => ({ count: ++n })));
    expect((await hitRateLimit(env, "k", 3600, 3)).allowed).toBe(true); // 1
    expect((await hitRateLimit(env, "k", 3600, 3)).allowed).toBe(true); // 2
    expect((await hitRateLimit(env, "k", 3600, 3)).allowed).toBe(true); // 3
    expect((await hitRateLimit(env, "k", 3600, 3)).allowed).toBe(false); // 4 > 3
  });

  it("fails open (degraded) when the store throws", async () => {
    const env = envWith(
      fakeD1(() => {
        throw new Error("D1 down");
      }),
    );
    const r = await hitRateLimit(env, "k", 3600, 3);
    expect(r.allowed).toBe(true);
    expect(r.degraded).toBe(true);
  });
});
