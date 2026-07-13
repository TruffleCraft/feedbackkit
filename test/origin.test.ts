import { describe, it, expect } from "vitest";
import { originAllowed } from "../src/worker/security/origin.js";

describe("originAllowed — exact entries", () => {
  const list = ["https://acme.dev", "http://localhost:3000"];
  it("allows an exact match", () => {
    expect(originAllowed("https://acme.dev", list)).toBe(true);
    expect(originAllowed("http://localhost:3000", list)).toBe(true);
  });
  it("rejects a different scheme", () => {
    expect(originAllowed("http://acme.dev", list)).toBe(false);
  });
  it("rejects substring / suffix tricks", () => {
    expect(originAllowed("https://notacme.dev", list)).toBe(false);
    expect(originAllowed("https://acme.dev.evil.com", list)).toBe(false);
    expect(originAllowed("https://acme.dev/path", list)).toBe(false);
  });
  it("rejects empty / missing origin", () => {
    expect(originAllowed("", list)).toBe(false);
    expect(originAllowed(null, list)).toBe(false);
    expect(originAllowed(undefined, list)).toBe(false);
  });
});

describe("originAllowed — wildcard subdomains (the VOS-bug class)", () => {
  const list = ["https://*.acme.dev"];
  it("allows a single-label subdomain", () => {
    expect(originAllowed("https://app.acme.dev", list)).toBe(true);
    expect(originAllowed("https://staging.acme.dev", list)).toBe(true);
  });
  it("does NOT match the bare apex (wildcard requires a label)", () => {
    expect(originAllowed("https://acme.dev", list)).toBe(false);
  });
  it("does NOT span multiple labels", () => {
    expect(originAllowed("https://a.b.acme.dev", list)).toBe(false);
  });
  it("REJECTS the suffix-bypass that the unanchored VOS regex allowed", () => {
    expect(originAllowed("https://app.acme.dev.evil.com", list)).toBe(false);
    expect(originAllowed("https://acme.dev.evil.com", list)).toBe(false);
    expect(originAllowed("https://evil.com/app.acme.dev", list)).toBe(false);
  });
  it("does not let the dot act as a regex wildcard", () => {
    // `.` must be escaped: "acmeXdev" must not match "acme.dev"
    expect(originAllowed("https://appXacme.dev", ["https://*.acme.dev"])).toBe(false);
  });
});

describe("originAllowed — wildcard port", () => {
  const list = ["http://localhost:*"];
  it("allows any localhost port", () => {
    expect(originAllowed("http://localhost:5173", list)).toBe(true);
  });
  it("rejects a look-alike host", () => {
    expect(originAllowed("http://localhost.evil.com", list)).toBe(false);
  });
});
