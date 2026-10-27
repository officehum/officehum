/**
 * The office's shipped tools must be reserved, or a role can declare one and the two collide in the
 * same conversation.
 *
 * This is a test rather than a comment because the drift it catches already happened once: three tools
 * shipped (RASF-3109) while the reserved list still carried only the names the office planned to ship.
 * Nothing compared the two lists, so nothing noticed.
 */
import { RESERVED_TOOL_NAMES } from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import { OFFICE_TOOL_NAMES } from "./index.js";

describe("the reserved tool names", () => {
  it("every shipped office tool is reserved", () => {
    const reserved: readonly string[] = RESERVED_TOOL_NAMES;
    expect(OFFICE_TOOL_NAMES.filter((name) => !reserved.includes(name))).toEqual([]);
  });
});
