import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatIssue } from "./issues.js";
import { type AgentManifest, validateManifest } from "./manifest.js";

const sample = JSON.parse(
  readFileSync(new URL("../fixtures/sample-desk/officehum.json", import.meta.url), "utf8"),
) as AgentManifest;

/** The sample manifest with some fields replaced. */
const withFields = (fields: Record<string, unknown>) => ({ ...structuredClone(sample), ...fields });

const messages = (value: unknown) => {
  const result = validateManifest(value);
  return result.ok ? [] : result.issues.map(formatIssue);
};

describe("validateManifest", () => {
  it("accepts the sample role's manifest", () => {
    const result = validateManifest(sample);
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.id).toBe("sample-desk");
  });

  it("explains a bad replay value with the allowed values and what it got", () => {
    const tools = [
      { name: "check_schedule", replay: "safe" },
      { name: "book_appointment", replay: "maybe" },
    ];
    expect(messages(withFields({ tools }))).toEqual([
      'officehum.json › tools[1].replay: must be one of "safe", "unsafe" (got "maybe")',
    ]);
  });

  it("requires replay on every tool, with no default", () => {
    const tools = [{ name: "check_schedule" }, { name: "book_appointment", replay: "unsafe" }];
    expect(messages(withFields({ tools }))).toEqual([
      "officehum.json › tools[0].replay: is required",
    ]);
  });

  it("reports every problem at once, not just the first", () => {
    const manifest: Record<string, unknown> = withFields({
      id: "Sample Desk",
      department: "legal",
      extra: true,
    });
    delete manifest.role;
    expect(messages(manifest)).toEqual(
      expect.arrayContaining([
        'officehum.json › id: must be kebab-case, like "front-desk" (got "Sample Desk")',
        'officehum.json › department: must be one of "front-office", "finance", "operations", "sales", "marketing", "people" (got "legal")',
        "officehum.json › extra: is not a known field",
        "officehum.json › role: is required",
      ]),
    );
  });

  it("rejects fields that moved to package.json", () => {
    expect(messages(withFields({ version: "0.1.0", piDurable: "1.0.x" }))).toEqual([
      "officehum.json › version: is not a known field",
      "officehum.json › piDurable: is not a known field",
    ]);
  });

  it("rejects tool names the Office provides", () => {
    const tools = [...sample.tools, { name: "delegate", replay: "unsafe" }];
    expect(messages(withFields({ tools }))).toEqual([
      'officehum.json › tools[2].name: "delegate" is provided by the Office; choose another name',
    ]);
  });

  it("rejects duplicate declarations", () => {
    const tools = [...sample.tools, { name: "check_schedule", replay: "safe" }];
    const accepts = [...sample.accepts, { type: "booking.request", description: "Again" }];
    expect(messages(withFields({ tools, accepts }))).toEqual([
      'officehum.json › tools[2]: tool "check_schedule" is declared more than once',
      'officehum.json › accepts[1]: ticket type "booking.request" is declared more than once',
    ]);
  });

  it("requires approvals and skills to refer to what the manifest declares", () => {
    const approvals = [{ id: "issue_refund", tool: "issue_refund", description: "Refunds" }];
    const tools = [
      ...sample.tools,
      { name: "send_reminder", replay: "unsafe", skill: "reminders" },
    ];
    expect(messages(withFields({ approvals, tools }))).toEqual([
      'officehum.json › tools[2].skill: "reminders" is not a declared skill',
      'officehum.json › approvals[0].tool: "issue_refund" is not a declared tool',
    ]);
  });

  it("checks ticket types are dotted", () => {
    const accepts = [{ type: "booking", description: "Book" }];
    expect(messages(withFields({ accepts }))).toEqual([
      'officehum.json › accepts[0].type: must be a dotted ticket type, like "invoice.create" (got "booking")',
    ]);
  });

  it("reports a value that is not an object", () => {
    expect(messages("hello")).toEqual(['officehum.json: must be an object (got "hello")']);
  });
});
