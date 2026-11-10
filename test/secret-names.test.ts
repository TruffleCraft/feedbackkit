import { describe, it, expect, beforeEach, vi } from "vitest";
import { patSecretProblems } from "../src/shared/contract.js";
import { checkConfigForWrite } from "../src/worker/admin/config-write.js";
import { loadProject, warnLegacySecretNames, __clearConfigCache } from "../src/worker/config.js";
import { fakeD1 } from "./helpers.js";
import type { Env } from "../src/worker/env.js";

const config = (patSecret: string, projectPat?: string) => ({
  projectId: "demo",
  templates: [{ type: "bug", label: "Bug", fields: [] }],
  llm: { provider: "off", model: "" },
  tracker: { kind: "github", defaultRepo: "acme/site", patSecret, ...(projectPat ? { project: { org: "acme", number: 1, patSecret: projectPat } } : {}) },
  auth: { origins: ["https://acme.example"] },
});

describe("the secret a project's settings may name", () => {
  it("accepts GITHUB_PAT_<name> and nothing else", () => {
    expect(patSecretProblems(config("GITHUB_PAT_default"))).toEqual([]);
    expect(patSecretProblems(config("GITHUB_PAT_default", "GITHUB_PAT_projects"))).toEqual([]);
    expect(patSecretProblems(config("ADMIN_TOKEN"))).toEqual(['tracker.patSecret: "ADMIN_TOKEN" is not a GITHUB_PAT_<name> secret']);
    expect(patSecretProblems(config("GITHUB_PAT_default", "LLM_API_KEY"))).toEqual(['tracker.project.patSecret: "LLM_API_KEY" is not a GITHUB_PAT_<name> secret']);
    expect(patSecretProblems(config("github_pat_default"))).toHaveLength(1);
    expect(patSecretProblems(config("GITHUB_PAT_"))).toHaveLength(1);
    expect(patSecretProblems({ projectId: "x" })).toEqual([]);
    expect(patSecretProblems(null)).toEqual([]);
  });

  it("is refused when settings are written", async () => {
    const env = {} as unknown as Env;
    const bad = await checkConfigForWrite(env, config("ADMIN_TOKEN"));
    expect(bad).toMatchObject({ ok: false, status: 400, body: { code: "FK_CONFIG_INVALID", issues: [expect.stringContaining("ADMIN_TOKEN")] } });
    const badProject = await checkConfigForWrite(env, config("GITHUB_PAT_default", "DB"));
    expect(badProject).toMatchObject({ ok: false, status: 400 });
    expect((await checkConfigForWrite(env, config("GITHUB_PAT_default"))).ok).toBe(true);
  });

  describe("stored settings", () => {
    beforeEach(() => __clearConfigCache());

    it("keep loading and are warned about once", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const env = { DB: fakeD1(() => ({ config: JSON.stringify(config("ADMIN_TOKEN")), config_version: 1 })) } as unknown as Env;
        const loaded = await loadProject(env, "fk_pub_legacy");
        expect(loaded?.config.tracker?.patSecret).toBe("ADMIN_TOKEN");
        __clearConfigCache();
        await loadProject(env, "fk_pub_legacy");
        const messages = warn.mock.calls.map((call) => String(call[0])).filter((m) => m.includes("fk_pub_legacy"));
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain("tracker.patSecret");
      } finally { warn.mockRestore(); }
    });

    it("say nothing when the names are fine", () => {
      const warn = vi.fn();
      warnLegacySecretNames("fk_pub_fine", config("GITHUB_PAT_default"), warn);
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
