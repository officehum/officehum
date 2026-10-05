import { describe, expect, it } from "vitest";
import { PI_DURABLE_RANGE } from "./index.js";

describe("@officehum/office", () => {
  it("pins Pi Durable to the 1.0 line", () => {
    expect(PI_DURABLE_RANGE.startsWith("~1.0")).toBe(true);
  });
});
