import { describe, it, expect } from "vitest";
import { FeedbackConfig } from "../src/shared/contract.js";
import committedJson from "../src/admin/settings-descriptor.json";
// @ts-expect-error -- plain ESM script without type declarations
import { describeSchema } from "../scripts/settings-descriptor.mjs";

type Desc = { k: string; opt?: boolean; def?: unknown; shape?: Record<string, Desc>; el?: Desc; val?: Desc; options?: unknown[] };
const committed = committedJson as unknown as Desc;
const fresh = JSON.parse(JSON.stringify(describeSchema(FeedbackConfig))) as Desc;

describe("the settings descriptor the admin form is built from", () => {
  it("is current: it is generated from the config schema", () => {
    expect(committed, "src/admin/settings-descriptor.json is stale, run pnpm gen:settings").toEqual(fresh);
  });

  it("starts nothing destructive: numbers and choices have a default only where the schema declares one", () => {
    const shape = fresh.shape!;
    expect(shape["storage"]!.shape!["retentionDays"]).toEqual({ k: "number", opt: true });
    expect(shape["tracker"]!.shape!["project"]!.shape!["number"]).toEqual({ k: "number" });
    expect(shape["delivery"]).toMatchObject({ k: "enum", opt: true });
    expect(shape["delivery"]!.def).toBeUndefined();
    expect(shape["llm"]!.shape!["dailyBudget"]).toMatchObject({ k: "number", opt: true, def: 200 });
    expect(shape["capture"]!.shape!["screenshot"]).toMatchObject({ k: "enum", def: "optional" });
  });

  it("describes nesting, unions and records", () => {
    const templates = fresh.shape!["templates"]!;
    expect(templates.k).toBe("array");
    const label = templates.el!.shape!["label"]!;
    expect(label.k).toBe("union");
    expect(label.options).toEqual([{ k: "string" }, { k: "record", val: { k: "string" } }]);
  });
});
