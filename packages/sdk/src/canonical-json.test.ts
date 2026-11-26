import { describe, expect, it } from "vitest";
import { canonicalJson, sameCanonical } from "./canonical-json.js";

describe("canonicalJson", () => {
  it("orders keys by code unit, where a locale would put lower case first", () => {
    // `localeCompare` reads "weeklyHoursCap" before "weekStart"; code units read "S" before "l".
    expect(canonicalJson({ weeklyHoursCap: 40, weekStart: "2026-11-09" })).toBe(
      '{"weekStart":"2026-11-09","weeklyHoursCap":40}',
    );
    expect(canonicalJson({ b: 1, B: 2, a: 3, _a: 4, "1": 5 })).toBe(
      '{"1":5,"B":2,"_a":4,"a":3,"b":1}',
    );
  });

  it("gives one text for one value, at every depth, and keeps array order", () => {
    const left = {
      to: "acme",
      lines: [
        { qty: 2, sku: "b" },
        { sku: "a", qty: 1 },
      ],
    };
    const right = {
      lines: [
        { sku: "b", qty: 2 },
        { qty: 1, sku: "a" },
      ],
      to: "acme",
    };
    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it("refuses a value JSON cannot write", () => {
    expect(() => canonicalJson(undefined)).toThrow("Only a JSON value has a canonical form.");
  });
});

describe("sameCanonical", () => {
  const canonical = canonicalJson({ weekStart: "2026-11-09", weeklyHoursCap: 40 });

  it("recognises a text an older version stored with its keys in locale order", () => {
    const stored = '{"weeklyHoursCap":40,"weekStart":"2026-11-09"}';
    expect(stored).not.toBe(canonical);
    expect(sameCanonical(stored, canonical)).toBe(true);
    expect(sameCanonical(canonical, canonical)).toBe(true);
  });

  it("does not match another value, or text that is not JSON", () => {
    expect(sameCanonical('{"weeklyHoursCap":41,"weekStart":"2026-11-09"}', canonical)).toBe(false);
    expect(sameCanonical("not json", canonical)).toBe(false);
  });
});
