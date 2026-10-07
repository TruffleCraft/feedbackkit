import { describe, it, expect } from "vitest";
// @ts-expect-error — plain ESM script without types
import { nextDev, promote, pruneDev, devOf, latestStable } from "../scripts/release-version.mjs";

describe("release versions from tags (ADR-013)", () => {
  it("starts the first line at 0.1.0", () => {
    expect(nextDev([])).toBe("v0.1.0-dev.1");
    expect(nextDev(["v0.1.0-dev.1", "v0.1.0-dev.2"])).toBe("v0.1.0-dev.3");
  });

  it("takes the next patch after a stable release, by itself", () => {
    expect(nextDev(["v0.1.0-dev.3", "v0.1.0"])).toBe("v0.1.1-dev.1");
    expect(nextDev(["v0.1.0", "v0.1.1-dev.1"])).toBe("v0.1.1-dev.2");
  });

  it("starts a minor or major line once, later dev builds stay on it", () => {
    expect(nextDev(["v0.1.0"], "minor")).toBe("v0.2.0-dev.1");
    expect(nextDev(["v0.1.0", "v0.2.0-dev.1"])).toBe("v0.2.0-dev.2");
    expect(nextDev(["v0.4.2"], "major")).toBe("v1.0.0-dev.1");
    expect(() => nextDev([], "huge")).toThrow();
  });

  it("ignores tags that are not release tags", () => {
    expect(nextDev(["web-v1.0.0", "v0.1", "v0.1.0-rc.1", "v0.1.0"])).toBe("v0.1.1-dev.1");
  });

  it("promotes a dev build to its stable version, never twice, never backwards", () => {
    const tags = ["v0.1.0-dev.1", "v0.1.0-dev.2"];
    expect(promote("v0.1.0-dev.2", tags)).toBe("v0.1.0");
    expect(() => promote("v0.1.0-dev.2", [...tags, "v0.1.0"])).toThrow(/already released/);
    expect(() => promote("v0.1.0", tags)).toThrow(/not a dev build/);
    expect(() => promote("v0.1.0-dev.9", tags)).toThrow(/unknown tag/);
    expect(() => promote("v0.1.0-dev.1; rm -rf /", tags)).toThrow(/not a dev build/);
    expect(() => promote("v0.1.1-dev.1", ["v0.1.1-dev.1", "v0.2.0"])).toThrow(/not newer/);
  });

  it("finds the latest stable, prunes old dev builds, lists a version's dev builds", () => {
    const tags = ["v0.1.0-dev.1", "v0.1.0-dev.2", "v0.1.0", "v0.1.1-dev.1", "v0.1.1-dev.2", "v0.1.1-dev.3"];
    expect(latestStable(tags)).toEqual({ major: 0, minor: 1, patch: 0, dev: null });
    expect(latestStable(["v0.1.0-dev.1"])).toBeNull();
    expect(pruneDev(tags, 3)).toEqual(["v0.1.0-dev.1", "v0.1.0-dev.2"]);
    expect(devOf("v0.1.0", tags)).toEqual(["v0.1.0-dev.1", "v0.1.0-dev.2"]);
  });
});
