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

  it("takes what a tool's result verifies, and reports every bad part with its path", () => {
    const good = [
      { name: "check_schedule", replay: "safe" },
      {
        name: "book_appointment",
        replay: "unsafe",
        verifies: { subject: "customer", system: "quickbooks", field: "customers[].id" },
      },
    ];
    expect(messages(withFields({ tools: good }))).toEqual([]);
    const bad = [
      { name: "check_schedule", replay: "safe" },
      {
        name: "book_appointment",
        replay: "unsafe",
        verifies: { subject: "person", system: "Quick Books", field: "customers[]..id", extra: 1 },
      },
    ];
    const reported = messages(withFields({ tools: bad }));
    for (const field of ["subject", "system", "field", "extra"]) {
      expect(
        reported.some((line) => line.includes(`tools[1].verifies.${field}`)),
        field,
      ).toBe(true);
    }
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
      'officehum.json › tools[2].name: "delegate" is reserved by Office Hum; choose another name',
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

  it("reserves the approval id practice mode asks under", () => {
    const approvals = [
      ...sample.approvals,
      { id: "practice", tool: sample.approvals[0]?.tool ?? "", description: "Mine" },
    ];
    expect(messages(withFields({ approvals }))).toEqual([
      `officehum.json › approvals[${sample.approvals.length}].id: "practice" is reserved for the office's practice mode; give this approval another id`,
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

  it("takes outside on a tool that changes something, and refuses it on one that only reads", () => {
    const tools = (check: object, book: object) => [
      { name: "check_schedule", replay: "safe", ...check },
      { name: "book_appointment", replay: "unsafe", ...book },
    ];
    expect(messages(withFields({ tools: tools({}, { outside: true }) }))).toEqual([]);
    // A safe tool that writes, like the Front Desk's send_message, may declare it too.
    expect(
      messages(withFields({ tools: tools({}, { replay: "safe", writes: true, outside: true }) })),
    ).toEqual([]);
    expect(messages(withFields({ tools: tools({ outside: true }, {}) }))).toEqual([
      'officehum.json › tools[0].outside: "check_schedule" changes nothing, so it cannot send or publish anything; a tool that does is replay "unsafe" or states "writes": true',
    ]);
    expect(messages(withFields({ tools: tools({}, { outside: false }) }))).toEqual([
      "officehum.json › tools[1].outside: must be true (got false)",
    ]);
  });

  it("takes outside on a limit with a direction, and refuses it on one without", () => {
    const limit = (fields: object) => ({
      limits: {
        order_limit_cents: { description: "Orders that go out unasked", default: 1000, ...fields },
      },
    });
    expect(messages(withFields(limit({ guard: "ceiling", outside: true })))).toEqual([]);
    const refusal =
      'officehum.json › limits.order_limit_cents.outside: needs a direction, because loosening it lets something go outside the business without a person; declare "guard": "ceiling" or "floor"';
    expect(messages(withFields(limit({ outside: true })))).toEqual([refusal]);
    expect(messages(withFields(limit({ guard: "none", outside: true })))).toEqual([refusal]);
  });

  it("checks that a limit's declared guard agrees with the approvals that compare with it", () => {
    const over = {
      id: "large_invoice",
      tool: "book_appointment",
      description: "Invoices over the amount",
      when: [{ arg: "amount", op: "gt", value: { limit: "large_invoice" } }],
    };
    const limit = (guard?: string) => ({
      large_invoice: {
        description: "Invoices over the amount",
        default: 5000,
        ...(guard === undefined ? {} : { guard }),
      },
    });
    expect(messages(withFields({ limits: limit("ceiling"), approvals: [over] }))).toEqual([]);
    expect(messages(withFields({ limits: limit(), approvals: [over] }))).toEqual([]);
    expect(messages(withFields({ limits: limit("floor"), approvals: [over] }))).toEqual([
      'officehum.json › limits.large_invoice.guard: is "floor", but approvals compare with it as a ceiling (raising it lets more through); declare "ceiling" or leave guard out',
    ]);
    expect(messages(withFields({ limits: limit("none"), approvals: [over] }))).toEqual([
      'officehum.json › limits.large_invoice.guard: is "none", but approvals compare with it as a ceiling (raising it lets more through); declare "ceiling" or leave guard out',
    ]);
    // Read only by code: the role says which way it guards, or that it guards nothing.
    expect(messages(withFields({ limits: limit("none") }))).toEqual([]);
    expect(messages(withFields({ limits: limit("sideways") }))).toEqual([
      'officehum.json › limits.large_invoice.guard: must be one of "ceiling", "floor", "none" (got "sideways")',
    ]);
  });

  it("checks a summed condition's field, and the comparison a sum needs", () => {
    const limits = { large_invoice: { description: "Invoices over the amount", default: 5000 } };
    const summed = [
      {
        id: "large_invoice",
        tool: "book_appointment",
        description: "Invoices over the amount",
        when: [
          {
            arg: "lines",
            op: "gt",
            field: "unitPriceCents",
            times: "quantity",
            value: { limit: "large_invoice" },
          },
        ],
      },
    ];
    // The Bookkeeper's declaration, on a tool whose parameters are defined in code: `lines` is an
    // array, which a manifest cannot describe, so nothing objects.
    expect(messages(withFields({ limits, approvals: summed }))).toEqual([]);

    const equality = [
      {
        id: "large_invoice",
        tool: "book_appointment",
        description: "Invoices over the amount",
        when: [{ arg: "lines", op: "eq", field: "amountCents", value: 2500 }],
      },
    ];
    expect(messages(withFields({ approvals: equality }))).toEqual([
      'officehum.json › approvals[0].when[0].field: sums an argument\'s elements, which needs a numeric comparison — "gt", "gte", "lt" or "lte" (op is "eq")',
    ]);

    const timesOnly = [
      {
        id: "large_invoice",
        tool: "book_appointment",
        description: "Invoices over the amount",
        when: [{ arg: "lines", op: "gt", times: "quantity", value: 2500 }],
      },
    ];
    expect(messages(withFields({ approvals: timesOnly }))).toEqual([
      'officehum.json › approvals[0].when[0].times: needs "field": it multiplies the summed field, so on its own it has nothing to multiply',
    ]);
  });

  it("refuses a summed condition on a declared scalar parameter", () => {
    // A manifest parameter is one string, number, integer or boolean: it has no elements to add up, so
    // a summed condition can only name an argument of a tool whose parameters are defined in code.
    const tools = [
      ...sample.tools,
      {
        name: "stock_adjust",
        replay: "unsafe",
        engine: ["adjust"],
        description: "Adjust a stock level",
        parameters: { quantity: { type: "number", description: "Units to add" } },
      },
    ];
    const approvals = [
      ...sample.approvals,
      {
        id: "large_adjust",
        tool: "stock_adjust",
        description: "Large adjustments",
        when: [{ arg: "quantity", op: "gt", field: "amountCents", value: 10 }],
      },
    ];
    expect(
      messages(withFields({ tools, approvals, engine: { command: ["bin/stock", "adjust"] } })),
    ).toEqual([
      'officehum.json › approvals[1].when[0].field: sums the elements of an array argument, and "quantity" is one declared "number" parameter; a manifest cannot declare an array, so a summed condition names a tool whose parameters are defined in code',
    ]);
  });

  describe("an approval's value", () => {
    /** The sample's approval on its unsafe `book_appointment`, asking for this value. */
    const asking = (value: unknown, approvals: unknown[] = []) =>
      withFields({
        approvals: [
          {
            id: "book_after_hours",
            tool: "book_appointment",
            description: "Bookings after 18:00",
            value,
          },
          ...approvals,
        ],
      });
    const credit = { name: "creditCents", label: "Credit to give", min: 1, max: 50_000 };

    it("accepts fixed bounds, fact bounds, a negative minimum and no bounds at all", () => {
      expect(messages(asking(credit))).toEqual([]);
      expect(
        messages(
          asking({
            name: "adjustmentCents",
            label: "Adjustment",
            minFact: "lowestCents",
            maxFact: "highestCents",
          }),
        ),
      ).toEqual([]);
      expect(messages(asking({ name: "adjustmentCents", label: "Adjustment", min: -500 }))).toEqual(
        [],
      );
      expect(messages(asking({ name: "revisedCents", label: "Revised budget" }))).toEqual([]);
    });

    it("reports a name that is not a camelCase identifier ending in Cents", () => {
      expect(messages(asking({ ...credit, name: "credit" }))).toEqual([
        'officehum.json › approvals[0].value.name: must be a camelCase name ending in Cents, like "creditCents" (got "credit")',
      ]);
      expect(messages(asking({ ...credit, name: "credit_cents" }))).toHaveLength(1);
    });

    it("reports min above max, a fixed and a fact bound for one side, and a whole-cents bound", () => {
      expect(messages(asking({ ...credit, min: 600, max: 500 }))).toEqual([
        "officehum.json › approvals[0].value.min: 600 is above max 500; the approver could enter nothing",
      ]);
      // min defaults to 0, so a negative max alone leaves nothing to enter.
      expect(messages(asking({ name: "creditCents", label: "Credit", max: -1 }))).toEqual([
        "officehum.json › approvals[0].value.min: 0 is above max -1; the approver could enter nothing",
      ]);
      expect(messages(asking({ ...credit, minFact: "lowCents", maxFact: "lineCents" }))).toEqual([
        "officehum.json › approvals[0].value.minFact: the low bound is given twice, as min and as minFact; keep one",
        "officehum.json › approvals[0].value.maxFact: the high bound is given twice, as max and as maxFact; keep one",
      ]);
      expect(messages(asking({ ...credit, max: 10.5 }))).toHaveLength(1);
    });

    it("reports a value on an approval whose tool is safe to run again", () => {
      const tools = sample.tools.map((tool) =>
        tool.name === "book_appointment" ? { ...tool, replay: "safe", writes: true } : tool,
      );
      expect(messages({ ...asking(credit), tools })).toEqual([
        'officehum.json › approvals[0].value: "book_appointment" is replay "safe", and a value the approver enters must reach the tool once; make the tool replay "unsafe"',
      ]);
    });

    it("reports two approvals on one tool that both ask for a value", () => {
      const second = {
        id: "book_late",
        tool: "book_appointment",
        description: "Bookings after 21:00",
        value: { ...credit, name: "depositCents" },
      };
      expect(messages(asking(credit, [second]))).toEqual([
        'officehum.json › approvals[1].value: "book_appointment" already has an approval that asks for a value ("book_after_hours"); one call carries one value',
      ]);
    });
  });

  it("checks an approval's amount names an argument of the tool, and times a field", () => {
    const tools = [
      ...sample.tools,
      {
        name: "stock_adjust",
        replay: "unsafe",
        engine: ["adjust"],
        description: "Adjust a stock level",
        parameters: { cost_cents: { type: "integer", description: "What it costs" } },
      },
    ];
    const engine = { command: ["bin/stock", "adjust"] };
    const approval = (amount: unknown) => [
      ...sample.approvals,
      { id: "large_adjust", tool: "stock_adjust", description: "Large adjustments", amount },
    ];
    expect(
      messages(withFields({ tools, engine, approvals: approval({ arg: "cost_cents" }) })),
    ).toEqual([]);
    expect(
      messages(withFields({ tools, engine, approvals: approval({ arg: "costCents" }) })),
    ).toEqual([
      'officehum.json › approvals[1].amount.arg: "costCents" is not a parameter of "stock_adjust"',
    ]);

    // On a tool whose parameters are defined in code, any argument name may be right.
    const inCode = (amount: unknown) => [
      { id: "large_booking", tool: "book_appointment", description: "Large bookings", amount },
    ];
    expect(
      messages(
        withFields({
          approvals: inCode({ arg: "lines", field: "unitPriceCents", times: "quantity" }),
        }),
      ),
    ).toEqual([]);
    expect(
      messages(withFields({ approvals: inCode({ arg: "lines", times: "quantity" }) })),
    ).toEqual([
      'officehum.json › approvals[0].amount.times: needs "field": it multiplies the summed field, so on its own it has nothing to multiply',
    ]);
  });

  it("takes no value with a presence condition, and needs one otherwise", () => {
    const presence = [
      {
        id: "large_increase",
        tool: "book_appointment",
        description: "Increases over the set amount",
        when: [{ arg: "quantity", op: "present" }],
      },
    ];
    expect(messages(withFields({ approvals: presence }))).toEqual([]);

    const withValue = [
      {
        id: "large_increase",
        tool: "book_appointment",
        description: "Increases over the set amount",
        when: [{ arg: "quantity", op: "present", value: 1 }],
      },
    ];
    expect(messages(withFields({ approvals: withValue }))).toEqual([
      'officehum.json › approvals[0].when[0].value: must be omitted when op is "present"',
    ]);

    const withoutValue = [
      {
        id: "large_increase",
        tool: "book_appointment",
        description: "Increases over the set amount",
        when: [{ arg: "quantity", op: "gt" }],
      },
    ];
    expect(messages(withFields({ approvals: withoutValue }))).toEqual([
      'officehum.json › approvals[0].when[0].value: needs a value unless the op is "present" or "absent"',
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
    const tools = [...sample.tools, { name: "context_recall", replay: "safe" }];
    expect(messages(withFields({ contextPlan, tools }))).toEqual([]);
  });

  it("declares context_recall exactly when the context plan has a history filter", () => {
    const historyFilter = { keepRecentRounds: 2, keepCitedIds: true, maxToolResultTokens: 200 };
    const recall = { name: "context_recall", replay: "safe" };
    expect(messages(withFields({ contextPlan: { historyFilter } }))).toEqual([
      'officehum.json › contextPlan.historyFilter: turns on the relevance filter, whose stubs point at "context_recall"; declare it in tools as { "name": "context_recall", "replay": "safe" }',
    ]);
    expect(messages(withFields({ tools: [...sample.tools, recall] }))).toEqual([
      'officehum.json › tools[2]: "context_recall" comes with contextPlan.historyFilter; declare a historyFilter or remove the tool',
    ]);
    expect(
      messages(
        withFields({
          contextPlan: { historyFilter },
          tools: [...sample.tools, { ...recall, replay: "unsafe", noApproval: "reads only" }],
        }),
      ),
    ).toEqual([
      'officehum.json › tools[2]: "context_recall" is built by the SDK, reads only and is safe to re-run; declare it exactly as { "name": "context_recall", "replay": "safe" }',
    ]);
    expect(
      messages(withFields({ contextPlan: { historyFilter }, tools: [...sample.tools, recall] })),
    ).toEqual([]);
  });

  it("rejects an unknown field in a context plan", () => {
    const contextPlan = { promptBudgetTokens: 4000, mask: false };
    expect(messages(withFields({ contextPlan }))).toEqual([
      "officehum.json › contextPlan.mask: is not a known field",
    ]);
  });

  it("lets a sub-agent run only declared safe tools and declared skills", () => {
    const contextPlan = {
      subagents: [
        {
          id: "summarise",
          purpose: "Summarise a thread",
          model: "small",
          tools: ["check_schedule", "book_appointment", "issue_refund"],
          skills: ["payroll"],
          output: { type: "object" },
        },
      ],
    };
    expect(messages(withFields({ contextPlan }))).toEqual([
      'officehum.json › contextPlan.subagents[0].tools[1]: "book_appointment" is unsafe; a sub-agent runs only the role\'s safe tools, never one that changes something',
      'officehum.json › contextPlan.subagents[0].tools[2]: "issue_refund" is not a declared tool; a sub-agent runs only the role\'s declared safe tools',
      'officehum.json › contextPlan.subagents[0].skills[0]: "payroll" is not a declared skill',
    ]);
  });

  describe("a tool that writes, whatever its replay policy", () => {
    // `replay: "safe"` says only that an interrupted call may be run again. A tool can be safe to
    // re-run and still change something, as an idempotent booking is.
    const tools = [
      { name: "check_schedule", replay: "safe" },
      { name: "book_appointment", replay: "safe", writes: true },
    ];
    const approvals = [
      { id: "booking", tool: "book_appointment", description: "Approve this booking" },
    ];

    it("is accepted when it is safe to re-run and gated", () => {
      expect(messages(withFields({ tools, approvals }))).toEqual([]);
    });

    it("must say so when an approval names a safe tool", () => {
      const silent = [tools[0], { name: "book_appointment", replay: "safe" }];
      expect(messages(withFields({ tools: silent, approvals }))).toEqual([
        'officehum.json › tools[1]: "book_appointment" is named by an approval, so it changes something; add "writes": true (replay "safe" only says an interrupted call may be run again)',
      ]);
    });

    it("states exactly one approval decision, like an unsafe tool", () => {
      expect(messages(withFields({ tools, approvals: [] }))).toEqual([
        'officehum.json › tools[1]: "book_appointment" writes and states no approval decision; add an approval in approvals[], or a noApproval note saying why it needs none',
      ]);
    });

    it("is never a sub-agent's tool", () => {
      const contextPlan = {
        subagents: [
          {
            id: "summarise",
            purpose: "Summarise a thread",
            model: "small",
            tools: ["check_schedule", "book_appointment"],
            output: { type: "object" },
          },
        ],
      };
      expect(messages(withFields({ tools, approvals, contextPlan }))).toEqual([
        'officehum.json › contextPlan.subagents[0].tools[1]: "book_appointment" writes; a sub-agent runs only the role\'s tools that change nothing',
      ]);
    });

    it("is never completion evidence", () => {
      const accepts = [
        {
          type: "booking.request",
          description: "Book",
          done: [{ tool: "book_appointment", args: {}, expect: "found" }],
        },
      ];
      expect(messages(withFields({ tools, approvals, accepts }))).toEqual([
        'officehum.json › accepts[0].done[0].tool: "book_appointment" writes; completion evidence runs a declared tool that changes nothing, in the host, never the model',
      ]);
    });
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
      'officehum.json › tools[0].noApproval: "check_schedule" is safe, so noApproval does not apply; remove it (noApproval explains a tool that writes but needs no approval)',
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

  it("accepts a channel declared one-way, and the shorthand beside it", () => {
    const channels = ["email", { channel: "sms", direction: "inbound", replyBy: "email" }];
    const result = validateManifest(withFields({ channels }));
    expect(result.ok).toBe(true);
    // The declaration survives validation as itself: a reader sees the direction, not a bare name.
    expect(result.ok && result.value.channels).toEqual(channels);
  });

  it("refuses a reply on a channel the role does not declare", () => {
    const channels = [{ channel: "sms", direction: "inbound", replyBy: "chat" }];
    expect(messages(withFields({ channels }))).toEqual([
      'officehum.json › channels[0].replyBy: replyBy "chat" is not a channel this role declares',
    ]);
  });

  it("refuses a direction that says a channel replies on itself", () => {
    const channels = ["email", { channel: "sms", direction: "inbound", replyBy: "sms" }];
    expect(messages(withFields({ channels }))).toEqual([
      "officehum.json › channels[1].replyBy: replyBy cannot be sms itself; declare the channel without a direction instead",
    ]);
  });

  it("counts a declaration and the shorthand as one channel", () => {
    const channels = ["email", { channel: "email", direction: "outbound" }];
    expect(messages(withFields({ channels }))).toEqual([
      'officehum.json › channels[1]: channel "email" is declared more than once',
    ]);
  });
});
