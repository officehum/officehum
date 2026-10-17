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
    const tools = [
      ...sample.tools,
      { name: "delegate", replay: "unsafe", noApproval: "internal note; no outside effect" },
    ];
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
    const approvals = [
      ...sample.approvals,
      { id: "issue_refund", tool: "issue_refund", description: "Refunds" },
    ];
    const tools = [
      ...sample.tools,
      {
        name: "send_reminder",
        replay: "unsafe",
        skill: "reminders",
        noApproval: "internal note; no outside effect",
      },
    ];
    expect(messages(withFields({ approvals, tools }))).toEqual([
      'officehum.json › tools[2].skill: "reminders" is not a declared skill',
      'officehum.json › approvals[1].tool: "issue_refund" is not a declared tool',
    ]);
  });

  it("checks approval conditions that name a limit", () => {
    const limits = { large_invoice: { description: "Invoices over the amount", default: 5000 } };
    const approvals = [
      {
        id: "large_invoice",
        tool: "book_appointment",
        description: "Invoices over the amount",
        when: [{ arg: "amount", op: "gt", value: { limit: "nope" } }],
      },
      {
        id: "flagged",
        tool: "book_appointment",
        description: "Flagged",
        when: [{ arg: "amount", op: "eq", value: { limit: "large_invoice" } }],
      },
    ];
    expect(messages(withFields({ limits, approvals }))).toEqual([
      'officehum.json › approvals[0].when[0].value: "nope" is not a declared limit',
      'officehum.json › approvals[1].when[0].value: names a limit, which needs "gt", "gte", "lt" or "lte" (op is "eq"); use a literal value instead',
    ]);
  });

  it("names limits in snake_case", () => {
    const limits = { "Large Invoice": { description: "Invoices over the amount", default: 5000 } };
    expect(messages(withFields({ limits }))).toEqual([
      'officehum.json › limits.Large Invoice: must be named in snake_case, like "large_invoice"',
    ]);
  });

  it("checks ticket types are dotted", () => {
    const accepts = [{ type: "booking", description: "Book" }];
    expect(messages(withFields({ accepts }))).toEqual([
      'officehum.json › accepts[0].type: must be a dotted ticket type, like "invoice.create" (got "booking")',
    ]);
  });

  it("refuses a dispatch whose type the role also accepts", () => {
    const dispatches = [{ type: "booking.request", when: "a customer needs a booking" }];
    expect(messages(withFields({ dispatches }))).toEqual([
      'officehum.json › dispatches[0].type: "booking.request" is also a type this role accepts; a role accepts a type or hands it off, never both — remove the accept or the dispatch',
    ]);
  });

  it("accepts a dispatch of a type the role does not accept", () => {
    const dispatches = [{ type: "invoice.create", when: "a customer asks to be billed" }];
    expect(messages(withFields({ dispatches }))).toEqual([]);
  });

  it("refuses a dispatch declared twice", () => {
    const dispatches = [
      { type: "invoice.create", when: "billing" },
      { type: "invoice.create", when: "billing again" },
    ];
    expect(messages(withFields({ dispatches }))).toEqual([
      'officehum.json › dispatches[1]: ticket type "invoice.create" is declared more than once',
    ]);
  });

  it("accepts a well-formed context plan", () => {
    const contextPlan = {
      promptBudgetTokens: 4000,
      retrieval: { sources: [{ id: "policy", description: "The policy manual" }] },
      subagents: [
        {
          id: "summarise",
          purpose: "Summarise a thread",
          model: "small",
          tools: ["check_schedule"],
          output: { type: "object" },
        },
      ],
      historyFilter: { keepRecentRounds: 6, keepCitedIds: true, maxToolResultTokens: 400 },
      maskAmounts: true,
      modelTiers: { small: ["summarising", "classifying"] },
      memorySubjects: ["customer", "vendor"],
      toolGroups: [
        { id: "booking", tools: ["book_appointment"], forTicketTypes: ["booking.request"] },
      ],
    };
    expect(messages(withFields({ contextPlan }))).toEqual([]);
  });

  it("rejects an unknown field in a context plan", () => {
    const contextPlan = { promptBudgetTokens: 4000, mask: false };
    expect(messages(withFields({ contextPlan }))).toEqual([
      "officehum.json › contextPlan.mask: is not a known field",
    ]);
  });

  it("requires a sub-agent's model to be small or default", () => {
    const contextPlan = {
      subagents: [
        {
          id: "summarise",
          purpose: "Summarise a thread",
          model: "tiny",
          tools: ["check_schedule"],
          output: { type: "object" },
        },
      ],
    };
    expect(messages(withFields({ contextPlan }))).toEqual([
      'officehum.json › contextPlan.subagents[0].model: must be one of "small", "default" (got "tiny")',
    ]);
  });

  it("requires an unsafe tool to state exactly one approval decision", () => {
    const tools = [
      { name: "check_schedule", replay: "safe" },
      { name: "book_appointment", replay: "unsafe" },
    ];
    expect(messages(withFields({ tools, approvals: [] }))).toEqual([
      'officehum.json › tools[1]: "book_appointment" is unsafe and states no approval decision; add an approval in approvals[], or a noApproval note saying why it needs none',
    ]);
  });

  it("refuses an unsafe tool that states both an approval and noApproval", () => {
    const tools = [
      { name: "check_schedule", replay: "safe" },
      {
        name: "book_appointment",
        replay: "unsafe",
        noApproval: "internal note; no outside effect",
      },
    ];
    expect(messages(withFields({ tools }))).toEqual([
      'officehum.json › tools[1]: "book_appointment" is unsafe and states two approval decisions; keep an approval in approvals[], or noApproval, never both',
    ]);
  });

  it("refuses noApproval on a safe tool", () => {
    const tools = [
      { name: "check_schedule", replay: "safe", noApproval: "internal note; no outside effect" },
      { name: "book_appointment", replay: "unsafe" },
    ];
    expect(messages(withFields({ tools }))).toEqual([
      'officehum.json › tools[0].noApproval: "check_schedule" is safe, so noApproval does not apply; remove it (noApproval explains an unsafe tool that needs no approval)',
    ]);
  });

  it("keeps a noApproval note to 300 characters", () => {
    const tools = [
      { name: "check_schedule", replay: "safe" },
      { name: "book_appointment", replay: "unsafe", noApproval: "x".repeat(301) },
    ];
    expect(messages(withFields({ tools }))).toEqual([
      "officehum.json › tools[1].noApproval: must be at most 300 characters (got 301)",
    ]);
  });

  it("refuses an empty noApproval note", () => {
    const tools = [
      { name: "check_schedule", replay: "safe" },
      { name: "book_appointment", replay: "unsafe", noApproval: "" },
    ];
    expect(messages(withFields({ tools }))).toEqual([
      "officehum.json › tools[1].noApproval: must not be empty",
    ]);
  });

  it("accepts all four kinds of completion evidence", () => {
    const accepts = [
      {
        type: "booking.request",
        description: "Book",
        done: [
          { engine: ["levels"], args: { sku: "{ticket.data.sku}" } },
          { tool: "check_schedule", args: { date: "{ticket.data.date.value}" }, expect: "found" },
          { file: "confirmation" },
          { person: true },
        ],
      },
    ];
    expect(messages(withFields({ accepts }))).toEqual([]);
  });

  it("requires completion evidence to name a safe tool of the role", () => {
    const accepts = [
      {
        type: "booking.request",
        description: "Book",
        done: [{ tool: "book_appointment", args: {}, expect: "found" }],
      },
    ];
    expect(messages(withFields({ accepts }))).toEqual([
      'officehum.json › accepts[0].done[0].tool: "book_appointment" is unsafe; completion evidence runs a declared safe tool in the host, never the model',
    ]);
  });

  it("requires completion evidence to name a declared tool", () => {
    const accepts = [
      {
        type: "booking.request",
        description: "Book",
        done: [{ tool: "list_it", expect: "found" }],
      },
    ];
    expect(messages(withFields({ accepts }))).toEqual([
      'officehum.json › accepts[0].done[0].tool: "list_it" is not a declared tool; completion evidence names a safe tool of this role',
    ]);
  });

  it("reports a placeholder that is not an interpolation", () => {
    const accepts = [
      {
        type: "booking.request",
        description: "Book",
        done: [
          {
            engine: ["levels"],
            args: {
              sku: "{ticket.data}",
              booking: "{ticket.id}",
              date: "{ticket.data.date}",
            },
          },
        ],
      },
    ];
    expect(messages(withFields({ accepts }))).toEqual([
      'officehum.json › accepts[0].done[0].args.sku: "{ticket.data}" is not an interpolation; the only two are {ticket.id} and {ticket.data.<path>}',
    ]);
  });

  it("checks the shape of a completion evidence entry", () => {
    const accepts = [{ type: "booking.request", description: "Book", done: "yes" }];
    expect(messages(withFields({ accepts }))).toEqual([
      'officehum.json › accepts[0].done: must be an array (got "yes")',
    ]);
  });

  it("says which shapes a completion evidence entry may take", () => {
    const accepts = [
      { type: "booking.request", description: "Book", done: [{ tool: "check_schedule" }] },
    ];
    expect(messages(withFields({ accepts }))).toEqual([
      'officehum.json › accepts[0].done[0]: must be one of: { "engine": ["subcommand", …], "args": { "flag": "{ticket.data.<path>}" } }, { "tool": "NAME", "args": {…}, "expect": "found" }, { "file": "NAME" }, or { "person": true } (got {"tool":"check_schedule"})',
    ]);
  });

  it("reports a value that is not an object", () => {
    expect(messages("hello")).toEqual(['officehum.json: must be an object (got "hello")']);
  });
});
