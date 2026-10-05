import { describe, expect, it } from "vitest";
import { DEPARTMENTS, defineManifest } from "./index.js";

describe("defineManifest", () => {
  it("returns the manifest it was given", () => {
    const manifest = defineManifest({
      id: "frontdesk",
      name: "Front Desk",
      version: "0.0.0",
      department: "front-office",
      role: "Answers customers and books appointments",
    });
    expect(manifest.id).toBe("frontdesk");
    expect(DEPARTMENTS).toContain(manifest.department);
  });
});
