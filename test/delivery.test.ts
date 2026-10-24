import { describe, it, expect } from "vitest";
import { DELIVERY_CAPABILITY, FeedbackConfig, requiredDeliveryCapability, resolveDelivery } from "../src/shared/contract.js";
import { FeedbackConfig as StableConfig } from "./fixtures/contract-0.1.13.js";
// @ts-expect-error -- plain ESM script without type declarations
import * as script from "../scripts/delivery-capability.mjs";

// #109: the delivery model (issue | project | local), its resolution order, the
// refinements, and the capability gate shared by the import route and pnpm seed.

const tracker = { kind: "github", defaultRepo: "acme/site", patSecret: "GITHUB_PAT_default" };
const base = (over: Record<string, unknown> = {}) => ({
  projectId: "demo",
  templates: [{ type: "bug", label: "Bug" }],
  llm: { provider: "off" },
  tracker,
  auth: { origins: [] },
  ...over,
});
const issues = (raw: unknown) => {
  const r = FeedbackConfig.safeParse(raw);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("resolveDelivery", () => {
  it("template delivery > template noIssue > project delivery > default", () => {
    expect(resolveDelivery({ delivery: "local", tracker }, { delivery: "issue" })).toBe("issue");
    expect(resolveDelivery({ delivery: "project", tracker }, { noIssue: true })).toBe("local"); // a project default never overrides noIssue
    expect(resolveDelivery({ delivery: "project", tracker }, {})).toBe("project");
    expect(resolveDelivery({ tracker }, {})).toBe("issue");
    expect(resolveDelivery({}, {})).toBe("local");
    expect(resolveDelivery({}, { delivery: "project", noIssue: true })).toBe("project");
  });
});

describe("FeedbackConfig delivery refinements", () => {
  it("accepts today's configs unchanged", () => {
    expect(issues(base())).toEqual([]);
    expect(issues(base({ templates: [{ type: "bug", label: "Bug" }, { type: "praise", label: "Praise", noIssue: true }] }))).toEqual([]);
  });

  it("makes tracker optional when every type is stored locally", () => {
    expect(issues(base({ tracker: undefined }))).toEqual([]); // default without a tracker: local
    expect(issues(base({ tracker: undefined, delivery: "local" }))).toEqual([]);
    expect(issues(base({ tracker: undefined, templates: [{ type: "bug", label: "Bug", delivery: "issue" }] }))).toEqual(['tracker: type "bug" opens issues: tracker is required']);
  });

  it("rejects noIssue next to delivery issue, with its JSON path", () => {
    const raw = base({ templates: [{ type: "bug", label: "Bug" }, { type: "praise", label: "Praise", noIssue: true, delivery: "issue" }] });
    expect(issues(raw)).toEqual(['templates.1.delivery: noIssue: true contradicts delivery "issue"; remove one of them']);
  });

  it("keeps noIssue next to delivery project or local (a safe fallback for older workers)", () => {
    const project = { org: "acme", number: 3 };
    expect(issues(base({ delivery: "project", tracker: { ...tracker, project }, templates: [{ type: "bug", label: "Bug", noIssue: true, delivery: "project" }] }))).toEqual([]);
    expect(issues(base({ templates: [{ type: "bug", label: "Bug", noIssue: true, delivery: "local" }] }))).toEqual([]);
  });

  it("rejects tracker.project without an explicit delivery", () => {
    const raw = base({ tracker: { ...tracker, project: { org: "acme", number: 3 } } });
    expect(issues(raw)).toEqual(['delivery: tracker.project is set: set delivery explicitly ("issue", "project" or "local")']);
    // Explicit on every template counts as explicit.
    expect(issues({ ...raw, templates: [{ type: "bug", label: "Bug", delivery: "project" }] })).toEqual([]);
  });

  it("needs tracker.project for project delivery and a repo for issue delivery", () => {
    expect(issues(base({ delivery: "project" }))).toEqual(['tracker.project: type "bug" is delivered to a GitHub Project: tracker.project is required']);
    const noRepo = { kind: "github", patSecret: "GITHUB_PAT_default", project: { org: "acme", number: 3 } };
    expect(issues(base({ delivery: "project", tracker: noRepo }))).toEqual([]);
    expect(issues(base({ delivery: "issue", tracker: noRepo }))).toEqual(['tracker.defaultRepo: type "bug" opens issues: set tracker.defaultRepo or templates[0].tracker.repo']);
    expect(issues(base({ delivery: "issue", tracker: noRepo, templates: [{ type: "bug", label: "Bug", tracker: { repo: "acme/x" } }] }))).toEqual([]);
  });
});

describe("delivery capability gate", () => {
  const cases: unknown[] = [
    base(),
    base({ templates: [{ type: "bug", label: "Bug", noIssue: true }] }),
    base({ tracker: undefined }),
    base({ delivery: "local" }),
    base({ templates: [{ type: "bug", label: "Bug", delivery: "issue" }] }),
    base({ delivery: "project", tracker: { ...tracker, project: { org: "a", number: 1 } } }),
    base({ tracker: { ...tracker, project: { org: "a", number: 1 } } }),
    null,
  ];

  it("levels: 0 for today's shapes, 1 for delivery or no tracker, 2 for a GitHub Project", () => {
    expect(cases.map(requiredDeliveryCapability)).toEqual([0, 0, 1, 1, 1, 2, 2, 0]);
  });

  it("pnpm seed's copy agrees with the contract", () => {
    for (const c of cases) expect(script.requiredDeliveryCapability(c)).toBe(requiredDeliveryCapability(c));
    expect(script.codeDeliveryCapability()).toBe(DELIVERY_CAPABILITY);
  });
});

describe("stable v0.1.13 reading a new config", () => {
  it("never opens an issue for a template that keeps noIssue", () => {
    const raw = base({
      delivery: "project",
      tracker: { ...tracker, project: { org: "acme", number: 3 } },
      templates: [
        { type: "bug", label: "Bug", noIssue: true, delivery: "project" },
        { type: "idea", label: "Idea", noIssue: true, delivery: "local" },
      ],
    });
    expect(issues(raw)).toEqual([]); // valid for the new release
    const old = StableConfig.parse(raw); // and stable still parses it…
    expect(old.templates.every((t) => t.noIssue)).toBe(true); // …with noIssue intact: its orchestrate stores, never opens an issue
  });

  it("refuses a config without a tracker instead of guessing", () => {
    expect(StableConfig.safeParse(base({ tracker: undefined, delivery: "local" })).success).toBe(false);
  });
});
