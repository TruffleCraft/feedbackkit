import { describe, it, expect } from "vitest";
import { FeedbackConfig, activeTemplates, templateProblems } from "../src/shared/contract.js";
import { autoTypeEnabled, toPublicConfig } from "../src/shared/projection.js";

const type = (id: string, extra: Record<string, unknown> = {}) => ({ type: id, label: id, ...extra });
const cfg = (templates: unknown[]) => ({ templates });

describe("rules for type and field IDs", () => {
  it("accepts unique IDs and a first write", () => {
    expect(templateProblems(cfg([type("bug"), type("idea")]))).toEqual([]);
    expect(templateProblems({ projectId: "x" })).toEqual([]);
  });

  it("refuses a type ID that is used twice and a field key that is used twice in one type", () => {
    expect(templateProblems(cfg([type("bug"), type("bug")]))).toEqual(['templates.1.type: "bug" is used by more than one type']);
    const twice = type("bug", { fields: [{ key: "a" }, { key: "b" }, { key: "a" }] });
    expect(templateProblems(cfg([twice]))).toEqual(['templates.0.fields.2.key: "a" is used twice in type "bug"']);
    // The same key in two different types is fine.
    expect(templateProblems(cfg([type("bug", { fields: [{ key: "a" }] }), type("idea", { fields: [{ key: "a" }] })]))).toEqual([]);
  });

  it("keeps a published type: it can be archived, never removed or renamed", () => {
    const published = cfg([type("bug"), type("idea")]);
    expect(templateProblems(cfg([type("bug")]), published)).toEqual(['templates: type "idea" was published and cannot be removed or renamed. Set "archived": true on it instead']);
    expect(templateProblems(cfg([type("bug"), type("thought")]), published)).toHaveLength(1);
    expect(templateProblems(cfg([type("bug"), type("idea", { archived: true })]), published)).toEqual([]);
    // A new type is free, and a type that was never published can go.
    expect(templateProblems(cfg([type("bug"), type("idea"), type("new")]), published)).toEqual([]);
    expect(templateProblems(cfg([type("bug")]), cfg([type("bug")]))).toEqual([]);
  });

  it("keeps at least one active type", () => {
    expect(templateProblems(cfg([type("bug", { archived: true })]))).toEqual(["templates: at least one type must stay active"]);
    expect(templateProblems(cfg([type("bug", { archived: true }), type("idea")]))).toEqual([]);
  });
});

describe("an archived type", () => {
  const config = FeedbackConfig.parse({
    projectId: "demo",
    templates: [type("old", { archived: true }), type("bug"), type("idea")],
    llm: { provider: "openrouter", model: "m" },
    auth: { origins: [] },
  });

  it("is hidden from visitors but stays in the settings", () => {
    expect(config.templates).toHaveLength(3);
    expect(activeTemplates(config.templates).map((t) => t.type)).toEqual(["bug", "idea"]);
    expect(toPublicConfig(config, 1).types.map((t) => t.type)).toEqual(["bug", "idea"]);
  });

  it("does not count when the gateway decides whether it picks the type", () => {
    expect(autoTypeEnabled(config)).toBe(true);
    const one = FeedbackConfig.parse({ ...config, templates: [type("old", { archived: true }), type("bug")] });
    expect(autoTypeEnabled(one)).toBe(false);
  });
});
