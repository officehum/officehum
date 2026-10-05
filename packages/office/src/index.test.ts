import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PI_DURABLE_VERSION } from "./index.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  dependencies: Record<string, string>;
};

describe("@officehum/office", () => {
  it("pins an exact Pi Durable version", () => {
    expect(PI_DURABLE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("keeps the exported version in sync with package.json", () => {
    expect(pkg.dependencies["@earendil-works/pi-durable"]).toBe(PI_DURABLE_VERSION);
  });
});
