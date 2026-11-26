import { describe, expect, it } from "vitest";
import type { AgentManifest } from "../manifest.js";
import { validateSuite } from "./suite.js";

const manifest = {
  tools: [
    { name: "get_invoice", replay: "safe" },
    {
      name: "run_report",
      replay: "safe",
      engine: ["report"],
      description: "Runs a report.",
      parameters: { period: { type: "string", description: "The period." } },
    },
  ],
  approvals: [],
  accepts: [],
} as unknown as AgentManifest;

const suiteWith = (stubs: Record<string, unknown>) => ({
  scenarios: [
    {
      id: "a-scenario",
      description: "A scenario",
      input: { kind: "message", text: "Go." },
      stubs,
      expect: {},
    },
  ],
});

const plain = { run_report: { text: "{}" } };

describe("validateSuite stubs", () => {
  it("still accepts a text stub", () => {
    const result = validateSuite(
      suiteWith({ get_invoice: { text: "{}", isError: false }, ...plain }),
      manifest,
      "x",
    );
    expect(result.issues).toEqual([]);
  });

  it("accepts a byArgs stub", () => {
    const result = validateSuite(
      suiteWith({
        get_invoice: {
          byArgs: [{ args: { id: "1043" }, text: "{}" }],
          otherwise: { text: "none", isError: true },
        },
        ...plain,
      }),
      manifest,
      "x",
    );
    expect(result.issues).toEqual([]);
  });

  it("rejects an empty byArgs", () => {
    const result = validateSuite(
      suiteWith({ get_invoice: { byArgs: [] }, ...plain }),
      manifest,
      "x",
    );
    expect(result.ok).toBe(false);
  });

  it("reports an argument the tool does not take, when the manifest names its parameters", () => {
    const result = validateSuite(
      suiteWith({
        get_invoice: { text: "{}" },
        run_report: { byArgs: [{ args: { perod: "2026-10" }, text: "{}" }] },
      }),
      manifest,
      "x",
    );
    expect(result.issues.map((issue) => issue.path)).toEqual([
      "scenarios[0].stubs.run_report.byArgs[0].args.perod",
    ]);
  });

  it("accepts an includes matcher in a byArgs entry and in an expected call", () => {
    const suite = suiteWith({
      get_invoice: { byArgs: [{ args: { id: { includes: "104" } }, text: "{}" }] },
      run_report: { byArgs: [{ args: { period: { includes: "2026" } }, text: "{}" }] },
    });
    (suite.scenarios[0] as { expect: unknown }).expect = {
      calls: [{ tool: "run_report", args: { period: { includes: "2026" } } }],
    };
    expect(validateSuite(suite, manifest, "x").issues).toEqual([]);
  });

  it("reports a malformed includes matcher with its path", () => {
    const suite = suiteWith({
      get_invoice: { byArgs: [{ args: { id: { includes: 104 } }, text: "{}" }] },
      run_report: { byArgs: [{ args: { period: { includes: "" } }, text: "{}" }] },
    });
    (suite.scenarios[0] as { expect: unknown }).expect = {
      calls: [{ tool: "run_report", args: { period: { includes: "2026", also: "x" } } }],
    };
    const issues = validateSuite(suite, manifest, "x").issues;
    expect(issues.map((issue) => issue.path)).toEqual([
      "scenarios[0].stubs.get_invoice.byArgs[0].args.id.includes",
      "scenarios[0].stubs.run_report.byArgs[0].args.period.includes",
      "scenarios[0].expect.calls[0].args.period",
    ]);
    for (const issue of issues) expect(issue.message).toMatch(/includes/);
  });

  it("accepts a some matcher on an array argument, with matchers inside it", () => {
    const suite = suiteWith({ get_invoice: { text: "{}" }, ...plain });
    (suite.scenarios[0] as { expect: unknown }).expect = {
      calls: [{ tool: "run_report", args: { period: { some: { month: { includes: "11" } } } } }],
    };
    expect(validateSuite(suite, manifest, "x").issues).toEqual([]);
  });

  it("reports a malformed some matcher with its path", () => {
    const suite = suiteWith({ get_invoice: { text: "{}" }, ...plain });
    (suite.scenarios[0] as { expect: unknown }).expect = {
      calls: [
        { tool: "run_report", args: { period: { some: "2026" } } },
        { tool: "run_report", args: { period: { some: { month: "11" }, also: "x" } } },
        { tool: "run_report", args: { period: { some: { month: { includes: "" } } } } },
        { tool: "run_report", args: { some: { month: "11" } } },
      ],
    };
    const issues = validateSuite(suite, manifest, "x").issues;
    expect(issues.map((issue) => issue.path)).toEqual([
      "scenarios[0].expect.calls[0].args.period.some",
      "scenarios[0].expect.calls[1].args.period",
      "scenarios[0].expect.calls[2].args.period.some.month.includes",
      "scenarios[0].expect.calls[3].args.some",
    ]);
  });

  it("rejects an includes matcher at the top level of args, with its path", () => {
    const suite = suiteWith({
      get_invoice: { byArgs: [{ args: { includes: "1043" }, text: "{}" }] },
      ...plain,
    });
    (suite.scenarios[0] as { expect: unknown }).expect = {
      calls: [{ tool: "get_invoice", args: { includes: "1043" } }],
    };
    const issues = validateSuite(suite, manifest, "x").issues;
    expect(issues.map((issue) => issue.path)).toEqual([
      "scenarios[0].stubs.get_invoice.byArgs[0].args.includes",
      "scenarios[0].expect.calls[0].args.includes",
    ]);
    for (const issue of issues) expect(issue.message).toMatch(/argument's value/);
  });

  it("skips the argument-name check for a tool whose manifest names no parameters", () => {
    const result = validateSuite(
      suiteWith({ get_invoice: { byArgs: [{ args: { anything: "x" }, text: "{}" }] }, ...plain }),
      manifest,
      "x",
    );
    expect(result.issues).toEqual([]);
  });
});

describe("validateSuite message origin", () => {
  const withInput = (input: Record<string, unknown>) => ({
    scenarios: [
      {
        id: "a-scenario",
        description: "A scenario",
        input: { kind: "message", text: "Go.", ...input },
        stubs: { get_invoice: { text: "{}" }, ...plain },
        expect: {},
      },
    ],
  });

  it("accepts an internal or external origin for a named sender", () => {
    for (const origin of ["internal", "external"]) {
      const result = validateSuite(withInput({ from: "dana@example.test", origin }), manifest, "x");
      expect(result.issues, origin).toEqual([]);
    }
  });

  it("reports an origin that is neither, with its path", () => {
    const result = validateSuite(
      withInput({ from: "dana@example.test", origin: "staff" }),
      manifest,
      "x",
    );
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toEqual(["scenarios[0].input.origin"]);
  });

  it("reports an origin with no sender to give it to, with its path", () => {
    const result = validateSuite(withInput({ origin: "internal" }), manifest, "x");
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        path: "scenarios[0].input.origin",
        message: expect.stringContaining("from"),
      }),
    ]);
  });
});

describe("validateSuite shared stubs", () => {
  const scenarioWith = (id: string, stubs?: Record<string, unknown>) => ({
    id,
    description: "A scenario",
    input: { kind: "message", text: "Go." },
    ...(stubs === undefined ? {} : { stubs }),
    expect: {},
  });

  it("gives a scenario with no stubs of its own the file's stubs", () => {
    const result = validateSuite(
      {
        stubs: { get_invoice: { text: "INVOICE" }, run_report: { text: "REPORT" } },
        scenarios: [scenarioWith("a-scenario")],
      },
      manifest,
      "x",
    );
    expect(result.issues).toEqual([]);
    expect(result.ok && result.value.scenarios[0]?.stubs).toEqual({
      get_invoice: { text: "INVOICE" },
      run_report: { text: "REPORT" },
    });
    expect(result.ok && result.value).not.toHaveProperty("stubs");
  });

  it("lets a scenario's stub replace the file's stub for that tool, whole, and keeps the others", () => {
    const result = validateSuite(
      {
        stubs: {
          get_invoice: {
            byArgs: [{ args: { id: "1" }, text: "SHARED" }],
            otherwise: { text: "NONE" },
          },
          run_report: { text: "REPORT" },
        },
        scenarios: [
          scenarioWith("overrides", { get_invoice: { text: "OWN" } }),
          scenarioWith("inherits"),
        ],
      },
      manifest,
      "x",
    );
    expect(result.issues).toEqual([]);
    if (!result.ok) return;
    expect(result.value.scenarios[0]?.stubs).toEqual({
      get_invoice: { text: "OWN" },
      run_report: { text: "REPORT" },
    });
    expect(result.value.scenarios[1]?.stubs.get_invoice).toEqual({
      byArgs: [{ args: { id: "1" }, text: "SHARED" }],
      otherwise: { text: "NONE" },
    });
  });

  it("reports a declared tool stubbed by neither the scenario nor the file, with its path", () => {
    const result = validateSuite(
      {
        stubs: { run_report: { text: "REPORT" } },
        scenarios: [
          scenarioWith("a-scenario"),
          scenarioWith("b-scenario", { get_invoice: { text: "{}" } }),
        ],
      },
      manifest,
      "x",
    );
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      {
        source: "x",
        path: "scenarios[0].stubs",
        message:
          'must stub "get_invoice" here or in the file\'s top-level stubs; evals never call real tools',
      },
    ]);
  });

  it("requires a scenario's stubs when the file has none", () => {
    const result = validateSuite(
      { scenarios: [scenarioWith("a-scenario")] },
      { ...manifest, tools: [] } as AgentManifest,
      "x",
    );
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toEqual(["scenarios[0].stubs"]);
  });

  it("reports a file stub for an undeclared tool, and checks its arguments, each with its path", () => {
    const result = validateSuite(
      {
        stubs: {
          get_invoice: { byArgs: [{ args: { includes: "1043" }, text: "{}" }] },
          run_report: { byArgs: [{ args: { perod: "2026-10" }, text: "{}" }] },
          send_invoice: { text: "{}" },
        },
        scenarios: [scenarioWith("a-scenario")],
      },
      manifest,
      "x",
    );
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toEqual([
      "stubs.send_invoice",
      "stubs.get_invoice.byArgs[0].args.includes",
      "stubs.run_report.byArgs[0].args.perod",
    ]);
    expect(result.issues[0]?.message).toBe("is not a declared tool");
  });

  it("still validates a file without shared stubs, unchanged", () => {
    const result = validateSuite(
      suiteWith({ get_invoice: { text: "{}" }, ...plain }),
      manifest,
      "x",
    );
    expect(result.issues).toEqual([]);
    expect(result.ok && result.value.scenarios[0]?.stubs).toEqual({
      get_invoice: { text: "{}" },
      ...plain,
    });
  });
});

describe("validateSuite reply prohibitions", () => {
  const gated = {
    ...manifest,
    tools: [...manifest.tools, { name: "send_invoice", replay: "unsafe" }],
    approvals: [{ id: "send_invoice_approval", tool: "send_invoice", description: "Sends." }],
  } as unknown as AgentManifest;
  const stubs = {
    get_invoice: { text: "Invoice 1043: $200, due 2026-12-01." },
    run_report: { text: "{}" },
    send_invoice: { text: "Sent as SND-77." },
  };
  const withReply = (notContains: unknown[], extra: Record<string, unknown> = {}) => ({
    scenarios: [
      {
        id: "a-scenario",
        description: "A scenario",
        input: { kind: "message", text: "Send invoice 1043." },
        stubs,
        expect: { reply: { notContains } },
        ...extra,
      },
    ],
  });

  it("reports every phrase an honest reply can contain, each with its path, the phrase and advice", () => {
    const result = validateSuite(
      withReply(["still with", "i've sent it", "account is disabled", "dana declined"]),
      gated,
      "x",
    );
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toEqual([
      "scenarios[0].expect.reply.notContains[0]",
      "scenarios[0].expect.reply.notContains[2]",
    ]);
    expect(result.issues[0]?.message).toContain('"still with"');
    expect(result.issues[0]?.message).toContain("notCalled");
    expect(result.issues[1]?.message).toContain('"account is disabled"');
  });

  it("accepts a receipt token of a tool whose approval the scenario declines", () => {
    const result = validateSuite(
      withReply(["snd-77"], { approvals: { send_invoice_approval: "decline" } }),
      gated,
      "x",
    );
    expect(result.issues).toEqual([]);
  });

  it("accepts a receipt token of a tool the scenario lists in notCalled", () => {
    const result = validateSuite(
      {
        scenarios: [
          {
            ...withReply([]).scenarios[0],
            expect: { notCalled: ["send_invoice"], reply: { notContains: ["sent as snd-77"] } },
          },
        ],
      },
      gated,
      "x",
    );
    expect(result.issues).toEqual([]);
  });

  it("refuses a receipt token of a tool the scenario lets run", () => {
    const result = validateSuite(
      withReply(["snd-77"], { approvals: { send_invoice_approval: "approve" } }),
      gated,
      "x",
    );
    expect(result.issues.map((issue) => issue.path)).toEqual([
      "scenarios[0].expect.reply.notContains[0]",
    ]);
  });

  it("accepts any phrase with a stated reason, and refuses one without a real reason", () => {
    expect(
      validateSuite(
        withReply([
          { phrase: "grace", reason: "the exposed worker's name must never be disclosed" },
        ]),
        gated,
        "x",
      ).issues,
    ).toEqual([]);
    expect(validateSuite(withReply([{ phrase: "grace", reason: "ok" }]), gated, "x").ok).toBe(
      false,
    );
    expect(validateSuite(withReply([{ phrase: "grace" }]), gated, "x").ok).toBe(false);
  });
});

describe("validateSuite memory", () => {
  const SEED = "mem_SEEDACMEAPJANE000000000000";
  const withMemory = (memory: unknown, fields: Record<string, unknown> = {}) => ({
    stubs: { ...plain, get_invoice: { text: "Invoice 1042 for Acme" } },
    scenarios: [
      {
        id: "a-scenario",
        description: "A scenario",
        input: { kind: "message", text: "Who is Acme's AP contact now?", from: "ada" },
        memory,
        expect: {},
        ...fields,
      },
    ],
  });
  const seed = {
    id: SEED,
    about: "customer:quickbooks:42",
    kind: "fact",
    category: "contact",
    text: "Acme's AP contact is Jane Ortiz.",
  };

  it("accepts seeded records and every expectation, and keeps them on the resolved scenario", () => {
    const memory = {
      seed: [
        {
          ...seed,
          status: "unverified",
          reviewAt: "2027-03-01",
          source: { type: "external", ref: "email:x" },
        },
      ],
      expect: {
        count: 2,
        records: [{ id: SEED, status: "superseded" }, { text: { includes: "Raj" } }],
        absent: [{ status: "active", text: { includes: "Jane" } }],
        reviews: [{ type: "unverified" }],
        prompted: ["Jane Ortiz"],
        unread: ["AP contact is Jane"],
      },
    };
    const result = validateSuite(withMemory(memory), manifest, "x");
    expect(result.issues).toEqual([]);
    expect(result.ok && result.value.scenarios[0]?.memory).toEqual(memory);
  });

  it("lets a scenario with memory expect the memory tools, and no other scenario", () => {
    const calls = {
      calls: [{ tool: "memory_save", args: { kind: "fact" } }],
      notCalled: ["memory_forget"],
    };
    expect(validateSuite(withMemory({}, { expect: calls }), manifest, "x").issues).toEqual([]);
    const without = withMemory({}, { expect: calls });
    delete (without.scenarios[0] as { memory?: unknown }).memory;
    expect(validateSuite(without, manifest, "x").issues.map((issue) => issue.path)).toEqual([
      "scenarios[0].expect.calls[0].tool",
      "scenarios[0].expect.notCalled[0]",
    ]);
  });

  it("reports every malformed seed field with its path", () => {
    const paths = (record: Record<string, unknown>) =>
      validateSuite(withMemory({ seed: [record] }), manifest, "x")
        .issues.map((issue) => issue.path)
        .sort();
    expect(
      paths({ ...seed, id: "jane", about: "acme", kind: "gossip", category: "bank", extra: 1 }),
    ).toEqual(
      ["id", "about", "kind", "category", "extra"]
        .map((field) => `scenarios[0].memory.seed[0].${field}`)
        .sort(),
    );
    expect(
      paths({
        ...seed,
        reviewAt: "March",
        status: "forgotten",
        source: { type: "rumour", ref: "" },
      }),
    ).toEqual(
      ["reviewAt", "status", "source.type", "source.ref"]
        .map((field) => `scenarios[0].memory.seed[0].${field}`)
        .sort(),
    );
  });

  it("reports a seed id used twice, and a phrase no seeded record carries or one the input or a stub carries", () => {
    const result = validateSuite(
      withMemory({
        seed: [seed, seed],
        expect: {
          prompted: ["Raj Patel", "AP contact"],
          unread: ["Invoice 1042", "Jane Ortiz"],
          records: [{ includes: "x" }],
        },
      }),
      manifest,
      "x",
    );
    expect(result.issues.map((issue) => [issue.path, issue.message])).toEqual([
      ["scenarios[0].memory.seed[1].id", `"${SEED}" is used by another seeded record`],
      [
        "scenarios[0].memory.expect.prompted[0]",
        '"Raj Patel" is in no seeded record, so finding it proves nothing about memory: quote a seeded record\'s text',
      ],
      [
        "scenarios[0].memory.expect.prompted[1]",
        '"AP contact" is also in the input or a stub, so finding it proves nothing about memory: quote text only a seeded record carries',
      ],
      [
        "scenarios[0].memory.expect.unread[0]",
        '"Invoice 1042" is in no seeded record, so finding it proves nothing about memory: quote a seeded record\'s text',
      ],
      [
        "scenarios[0].memory.expect.records[0].includes",
        'an includes matcher goes on an argument\'s value, e.g. { "sku": { "includes": "…" } }, never on args itself',
      ],
    ]);
  });
});

describe("validateSuite scripted approver values", () => {
  const valued = {
    tools: [
      { name: "give_credit", replay: "unsafe" },
      { name: "send_note", replay: "unsafe" },
    ],
    approvals: [
      {
        id: "any_credit",
        tool: "give_credit",
        description: "Credit",
        value: { name: "creditCents", label: "Credit to give", min: 1, max: 50_000 },
      },
      { id: "note", tool: "send_note", description: "Note" },
    ],
    accepts: [],
  } as unknown as AgentManifest;
  const stubs = { give_credit: { text: "credited" }, send_note: { text: "sent" } };
  const suite = (approvals: Record<string, unknown>, expect: Record<string, unknown> = {}) => ({
    scenarios: [
      {
        id: "a-scenario",
        description: "A scenario",
        input: { kind: "message", text: "Go." },
        stubs,
        approvals,
        expect,
      },
    ],
  });
  const problems = (approvals: Record<string, unknown>) =>
    validateSuite(suite(approvals), valued, "x").issues.map(
      (issue) => `${issue.path}: ${issue.message}`,
    );

  it("accepts a value scripted with a yes, and the plain strings as before", () => {
    const result = validateSuite(
      suite(
        { any_credit: { decision: "approve", valueCents: 2_500 }, note: "approve" },
        { calls: [{ tool: "give_credit", approvedValue: { name: "creditCents", cents: 2_500 } }] },
      ),
      valued,
      "x",
    );
    expect(result.issues).toEqual([]);
    expect(result.ok && result.value.scenarios[0]?.approvals).toEqual({
      any_credit: { decision: "approve", valueCents: 2_500 },
      note: "approve",
    });
    expect(problems({ any_credit: "decline", note: "decline" })).toEqual([]);
    expect(problems({ any_credit: "pending", note: "pending" })).toEqual([]);
  });

  it("reports a value on a decline, a non-integer, a value nobody asks for and a yes without one", () => {
    expect(problems({ any_credit: { decision: "decline", valueCents: 2_500 } })).toEqual([
      'scenarios[0].approvals.any_credit.valueCents: a decline carries no value; script it as "decline"',
    ]);
    expect(problems({ any_credit: { decision: "approve", valueCents: 25.5 } })).toEqual([
      "scenarios[0].approvals.any_credit.valueCents: must be a whole number of cents (got 25.5)",
    ]);
    expect(problems({ note: { decision: "approve", valueCents: 100 } })).toEqual([
      'scenarios[0].approvals.note.valueCents: the note approval asks for no value; script it as "approve"',
    ]);
    expect(problems({ any_credit: "approve" })).toEqual([
      'scenarios[0].approvals.any_credit: the any_credit approval asks for "Credit to give" (creditCents); script it as { "decision": "approve", "valueCents": … }',
    ]);
  });

  it("reports an expected approved value that no approval of the tool declares", () => {
    const result = validateSuite(
      suite(
        { any_credit: { decision: "approve", valueCents: 2_500 } },
        {
          calls: [
            { tool: "send_note", approvedValue: { name: "creditCents", cents: 1 } },
            { tool: "give_credit", approvedValue: { name: "refundCents", cents: 1 } },
          ],
        },
      ),
      valued,
      "x",
    );
    expect(result.issues.map((issue) => `${issue.path}: ${issue.message}`)).toEqual([
      'scenarios[0].expect.calls[0].approvedValue.name: "creditCents" is not a value an approval of "send_note" asks for',
      'scenarios[0].expect.calls[1].approvedValue.name: "refundCents" is not a value an approval of "give_credit" asks for',
    ]);
  });

  it("names the accepted shapes for an answer it cannot read", () => {
    const result = validateSuite(suite({ any_credit: { decision: "approve" } }), valued, "x");
    expect(result.issues.map((issue) => issue.path)).toEqual(["scenarios[0].approvals.any_credit"]);
    expect(result.issues[0]?.message).toContain('"valueCents"');
  });
});

describe("validateSuite office-only fields", () => {
  const accepting = {
    tools: [{ name: "get_invoice", replay: "safe" }],
    approvals: [],
    accepts: [{ type: "invoice.create", description: "Create an invoice" }],
  } as unknown as AgentManifest;
  const ticketScenario = (fields: Record<string, unknown>) => ({
    id: "early-done-refused",
    description: "Replying done early is refused",
    input: { kind: "ticket", type: "invoice.create", payload: {} },
    stubs: { get_invoice: { text: "{}" } },
    expect: {},
    ...fields,
  });

  it("accepts a scripted office suite with a confirmation and a ticket expectation", () => {
    const result = validateSuite(
      {
        mode: "office",
        model: "scripted",
        scenarios: [
          ticketScenario({
            confirmation: "confirm",
            expect: { ticket: { status: "done", refusedWith: ["get_invoice"] } },
          }),
        ],
      },
      accepting,
      "evals/office.json",
    );
    expect(result.issues).toEqual([]);
    expect(result.ok && result.value.mode).toBe("office");
    expect(result.ok && result.value.model).toBe("scripted");
  });

  it("reports each office-only field in a suite that does not declare office mode, by path", () => {
    const result = validateSuite(
      {
        scenarios: [
          ticketScenario({ confirmation: "confirm", expect: { ticket: { status: "done" } } }),
        ],
      },
      accepting,
      "x",
    );
    expect(result.issues.map((issue) => `${issue.path}: ${issue.message}`)).toEqual([
      'scenarios[0].confirmation: only an office-mode suite has a board to confirm on; declare "mode": "office" at the top of the file',
      'scenarios[0].expect.ticket: only an office-mode suite has a board ticket to check; declare "mode": "office" at the top of the file',
    ]);
  });

  it("checks dispatched-ticket matchers and a stub's details, office-only, by path", () => {
    const dispatching = (mode?: "office") =>
      validateSuite(
        {
          ...(mode === undefined ? {} : { mode }),
          scenarios: [
            ticketScenario({
              stubs: {
                get_invoice: { text: "Invoice 1", details: { invoice: { customerId: "7" } } },
              },
              expect: {
                dispatched: [{ type: "finance.review", subjects: ["customer:quickbooks:7"] }],
                notDispatched: [{ includes: "x" }],
              },
            }),
          ],
        },
        accepting,
        "x",
      );
    expect(dispatching("office").issues.map((issue) => issue.path)).toEqual([
      "scenarios[0].expect.notDispatched[0].includes",
    ]);
    expect(dispatching().issues.map((issue) => `${issue.path}: ${issue.message}`)).toEqual(
      expect.arrayContaining([
        'scenarios[0].expect.dispatched: only an office-mode suite has a board to dispatch on; declare "mode": "office" at the top of the file',
        'scenarios[0].expect.notDispatched: only an office-mode suite has a board to dispatch on; declare "mode": "office" at the top of the file',
      ]),
    );
  });

  it("accepts a bare-only suite, which still has no board for office-only fields", () => {
    const plain = validateSuite(
      { mode: "bare", scenarios: [ticketScenario({ expect: {} })] },
      accepting,
      "evals/bare.json",
    );
    expect(plain.issues).toEqual([]);
    expect(plain.ok && plain.value.mode).toBe("bare");
    const boarded = validateSuite(
      { mode: "bare", scenarios: [ticketScenario({ expect: { ticket: { status: "done" } } })] },
      accepting,
      "evals/bare.json",
    );
    expect(boarded.issues.map((issue) => issue.path)).toEqual(["scenarios[0].expect.ticket"]);
  });

  it("lets only an office suite expect the office's communication tools, which run for real there", () => {
    const dispatching = (mode: "office" | "bare" | undefined) => ({
      ...(mode === undefined ? {} : { mode }),
      scenarios: [
        ticketScenario({
          expect: { calls: [{ tool: "agent_dispatch", args: { type: "finance.review" } }] },
        }),
      ],
    });
    expect(validateSuite(dispatching("office"), accepting, "x").issues).toEqual([]);
    for (const mode of ["bare", undefined] as const) {
      expect(
        validateSuite(dispatching(mode), accepting, "x").issues.map(
          (issue) => `${issue.path}: ${issue.message}`,
        ),
      ).toEqual(['scenarios[0].expect.calls[0].tool: "agent_dispatch" is not a declared tool']);
    }
  });

  it("refuses a mode, a model or a ticket status it does not know", () => {
    const result = validateSuite(
      {
        mode: "cloud",
        model: "live",
        scenarios: [ticketScenario({ expect: { ticket: { status: "finished" } } })],
      },
      accepting,
      "x",
    );
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(["mode", "model", "scenarios[0].expect.ticket.status"]),
    );
  });
});

describe("validateSuite judged reply assertions", () => {
  const withJudged = (judged: unknown[]) => ({
    scenarios: [
      {
        id: "a-scenario",
        description: "A scenario",
        input: { kind: "message", text: "Go." },
        stubs: { get_invoice: { text: "{}" }, run_report: { text: "{}" } },
        expect: { reply: { judged } },
      },
    ],
  });
  const claim = "The reply promises that someone will contact the sender.";

  it("accepts a claim with either verdict", () => {
    const result = validateSuite(
      withJudged([
        { claim, verdict: "absent" },
        { claim: "The reply names Finance and Billing.", verdict: "present" },
      ]),
      manifest,
      "x",
    );
    expect(result.issues).toEqual([]);
    expect(result.ok && result.value.scenarios[0]?.expect.reply?.judged?.[0]?.verdict).toBe(
      "absent",
    );
  });

  it("reports an empty, blank, long, questioning or repeated claim, each with its path", () => {
    const result = validateSuite(
      withJudged([
        { claim: "", verdict: "absent" },
        { claim: "   ", verdict: "absent" },
        { claim: `The reply says ${"a".repeat(290)}.`, verdict: "absent" },
        { claim: "Does the reply promise a call?", verdict: "absent" },
        { claim, verdict: "absent" },
        { claim: ` ${claim.toUpperCase()}`, verdict: "present" },
      ]),
      manifest,
      "x",
    );
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => `${issue.path}: ${issue.message}`)).toEqual([
      "scenarios[0].expect.reply.judged[0].claim: is empty; write the claim as a sentence about the reply",
      "scenarios[0].expect.reply.judged[1].claim: is empty; write the claim as a sentence about the reply",
      "scenarios[0].expect.reply.judged[2].claim: is 306 characters; keep a claim to 300 or fewer",
      'scenarios[0].expect.reply.judged[3].claim: ends with a question mark; state the claim as a sentence ("The reply promises …"), not a question',
      "scenarios[0].expect.reply.judged[5].claim: repeats judged[4]'s claim; a scenario judges each claim once",
    ]);
  });

  it("refuses a verdict other than absent or present, with its path", () => {
    const result = validateSuite(withJudged([{ claim, verdict: "maybe" }]), manifest, "x");
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toEqual([
      "scenarios[0].expect.reply.judged[0].verdict",
    ]);
  });
});

describe("validateSuite pack tools", () => {
  const withPack = {
    ...manifest,
    tools: [
      ...manifest.tools,
      { name: "data_query", replay: "safe", pack: "data", description: "Answers from a sheet." },
    ],
  } as unknown as AgentManifest;
  const scenario = (fields: Record<string, unknown>) => ({
    id: "a-scenario",
    description: "A scenario",
    input: { kind: "message", text: "Go." },
    stubs: { get_invoice: { text: "{}" }, ...plain },
    expect: {},
    ...fields,
  });

  it("need not stub a pack tool in a suite that runs without its pack", () => {
    expect(validateSuite({ scenarios: [scenario({})] }, withPack, "x").issues).toEqual([]);
  });

  it("refuses an expected call to a pack tool the suite does not run with", () => {
    const suite = { scenarios: [scenario({ expect: { calls: [{ tool: "data_query" }] } })] };
    expect(validateSuite(suite, withPack, "x").issues.map((issue) => issue.message)).toEqual([
      '"data_query" comes from the data pack, which this suite does not run with; declare "packs": ["data"] at the top of the file',
    ]);
  });

  it("runs a suite that declares the pack with its tools stubbed and expected", () => {
    const suite = {
      packs: ["data"],
      scenarios: [
        scenario({
          stubs: { get_invoice: { text: "{}" }, ...plain, data_query: { text: "| 42 |" } },
          expect: { calls: [{ tool: "data_query" }], notCalled: ["data_query"] },
        }),
      ],
    };
    const result = validateSuite(suite, withPack, "x");
    expect(result.issues).toEqual([]);
    expect(result.ok && result.value.packs).toEqual(["data"]);
  });

  it("must stub the pack's tools in a suite that declares the pack", () => {
    const suite = { packs: ["data"], scenarios: [scenario({})] };
    expect(validateSuite(suite, withPack, "x").issues.map((issue) => issue.message)).toEqual([
      `must stub "data_query" here or in the file's top-level stubs; evals never call real tools`,
    ]);
  });

  it("refuses a pack the role declares no tool from", () => {
    const suite = { packs: ["charts"], scenarios: [scenario({})] };
    expect(validateSuite(suite, withPack, "x").issues.map((issue) => issue.message)).toEqual([
      '"charts" is not a pack any of the role\'s tools comes from (it declares tools from "data")',
    ]);
  });
});
