import { defineExtension, defineTool, type Extension, section } from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";
import sampleManifest from "../fixtures/sample-desk/officehum.json" with { type: "json" };
import sampleDesk from "../fixtures/sample-desk/src/index.js";
import { checkAgent, type RoleBundle } from "./agent.js";
import { approvalGate, declaredFacts } from "./approvals.js";
import { valueDesk, valueDeskManifest } from "./fixtures/approver-values.js";
import { formatIssue } from "./issues.js";
import type { AgentManifest } from "./manifest.js";

const manifest = sampleManifest as AgentManifest;
const calendar = { freeSlots: async () => [], book: async () => ({ id: "A1" }) };
const model = { provider: "anthropic", modelId: "claude-sonnet-5-5" };

const tool = (name: string, replay?: "safe" | "unsafe") =>
  defineTool({
    name,
    description: name,
    // `date` because the sample manifest's completion evidence passes one to `check_schedule`.
    parameters: obj({ date: opt(str()) }, { open: true }),
    ...(replay === undefined ? {} : { replay }),
    execute: async () => ({ output: [{ type: "text", text: "ok" }] }),
  });

const gate = () => approvalGate({ approvals: manifest.approvals });

/** A bundle made of the given extensions, selecting all of them. */
const bundle = (...extensions: Extension[]): RoleBundle => ({
  extensions,
  agent: { model, extensions },
});

const messages = async (role: RoleBundle, against: AgentManifest = manifest) =>
  (await checkAgent(role, against)).issues.map(formatIssue);

/** The character count `checkAgent` measures: the role extension's own sections, joined by a newline. */
async function promptCharacters(role: RoleBundle): Promise<number> {
  const [extension] = role.extensions;
  const texts: string[] = [];
  for (const promptSection of extension?.sections ?? []) {
    const rendered = await promptSection.render({} as never, {} as never);
    if (typeof rendered === "string" && rendered.trim() !== "") texts.push(rendered);
  }
  return texts.join("\n").length;
}

describe("checkAgent", () => {
  it("accepts the sample role", async () => {
    expect(await messages(sampleDesk({ calendar }))).toEqual([]);
  });

  it("requires replay to be written out, even though Pi Durable has a default", async () => {
    const role = defineExtension({
      name: "sample-desk",
      tools: [tool("check_schedule", "safe"), tool("book_appointment")],
      hooks: [gate()],
    });
    expect(await messages(bundle(role))).toEqual([
      'role › sample-desk › book_appointment: must set replay explicitly ("unsafe" in officehum.json); Pi Durable would default to "unsafe"',
    ]);
  });

  it("catches code and manifest disagreeing about replay", async () => {
    const role = defineExtension({
      name: "sample-desk",
      tools: [tool("check_schedule", "safe"), tool("book_appointment", "safe")],
      hooks: [gate()],
    });
    expect(await messages(bundle(role))).toEqual([
      'role › sample-desk › book_appointment: replay is "safe" in code but "unsafe" in officehum.json',
    ]);
  });

  it("requires completion evidence to pass a tool only arguments it takes", async () => {
    const role = defineExtension({
      name: "sample-desk",
      tools: [tool("check_schedule", "safe"), tool("book_appointment", "unsafe")],
      hooks: [gate()],
    });
    const done = (args: Record<string, string>) => ({
      ...manifest,
      accepts: [
        {
          type: "booking.request",
          description: "Book",
          done: [{ tool: "check_schedule", args, expect: "found" as const }],
        },
      ],
    });
    expect(await messages(bundle(role), done({ date: "{ticket.data.date}" }))).toEqual([]);
    // A check the tool would be asked with an argument it does not have could never pass.
    expect(await messages(bundle(role), done({ bookingId: "{ticket.data.bookingId}" }))).toEqual([
      'role › accepts[0].done[0].args.bookingId: "check_schedule" takes no "bookingId" (it takes "date"), so this evidence could never pass; pass an argument the tool declares',
    ]);
  });

  it("allows only the tools the manifest declares, and requires all of them", async () => {
    const role = defineExtension({
      name: "sample-desk",
      tools: [tool("check_schedule", "safe"), tool("issue_refund", "unsafe")],
      hooks: [gate()],
    });
    expect(await messages(bundle(role))).toEqual([
      "role › sample-desk › issue_refund: is not declared in officehum.json",
      "role › sample-desk › book_appointment: is declared in officehum.json but no extension provides it",
    ]);
  });

  it("requires the approval gate when the manifest declares approvals", async () => {
    const role = defineExtension({
      name: "sample-desk",
      tools: [tool("check_schedule", "safe"), tool("book_appointment", "unsafe")],
    });
    expect(await messages(bundle(role))).toEqual([
      "role › sample-desk › hooks: must include approvalGate(), because officehum.json declares approvals",
    ]);
  });

  describe("money approvals declare their amount", () => {
    const role = defineExtension({
      name: "sample-desk",
      tools: [tool("check_schedule", "safe"), tool("book_appointment", "unsafe")],
      hooks: [gate()],
    });
    /** The sample role with a facts reader for its one approval, declaring these fields. */
    const withFacts = (fields: readonly string[]): RoleBundle =>
      ({
        ...bundle(role),
        approvalFacts: {
          book_after_hours: declaredFacts(fields, async () => ({
            summary: "s",
            facts: Object.fromEntries(fields.map((name) => [name, 1])),
          })),
        },
      }) as RoleBundle;
    const declaring = (amount: unknown, replay: "safe" | "unsafe" = "unsafe"): AgentManifest =>
      ({
        ...manifest,
        tools: manifest.tools.map((entry) =>
          entry.name === "book_appointment" ? { ...entry, replay } : entry,
        ),
        approvals: manifest.approvals.map((approval) =>
          amount === undefined ? approval : { ...approval, amount },
        ),
      }) as AgentManifest;

    it("reports an approval on an unsafe tool whose facts carry a cents field and that declares no amount", async () => {
      expect(await messages(withFacts(["id", "totalCents"]), declaring(undefined))).toEqual([
        'role › approvals[0].amount: is missing: "book_after_hours" gates the unsafe tool "book_appointment" and its facts carry "totalCents", so an approver\'s limit would never be checked against it; declare { "fact": "totalCents" } (or the fact that is the amount approved)',
      ]);
      expect(
        await messages(withFacts(["id", "totalCents"]), declaring({ fact: "totalCents" })),
      ).toEqual([]);
    });

    it("leaves a safe tool, and facts with no cents field, alone", async () => {
      const safe = defineExtension({
        name: "sample-desk",
        tools: [tool("check_schedule", "safe"), tool("book_appointment", "safe")],
        hooks: [gate()],
      });
      const safeBundle = {
        ...bundle(safe),
        approvalFacts: (withFacts(["totalCents"]) as unknown as { approvalFacts: unknown })
          .approvalFacts,
      } as RoleBundle;
      expect(await messages(safeBundle, declaring(undefined, "safe"))).toEqual([]);
      expect(await messages(withFacts(["id", "name"]), declaring(undefined))).toEqual([]);
    });

    it("reports an amount fact the reader does not declare, or no reader to read it", async () => {
      expect(
        await messages(withFacts(["id", "totalCents"]), declaring({ fact: "grossCents" })),
      ).toEqual([
        'role › approvals[0].amount.fact: "grossCents" is not a fact the "book_after_hours" reader declares (it declares "id", "totalCents")',
      ]);
      expect(await messages(bundle(role), declaring({ fact: "totalCents" }))).toEqual([
        'role › approvals[0].amount.fact: "book_after_hours" has no facts reader to read "totalCents" from; give it one with approvalFacts, or read the amount from an argument',
      ]);
    });
  });

  describe("approvals that ask for a value", () => {
    const fixture = () => valueDesk({ gross: new Map(), writes: [] }) as unknown as RoleBundle;

    it("accepts the value fixture role", async () => {
      expect(await messages(fixture(), valueDeskManifest)).toEqual([]);
    });

    it("reports a fact bound its reader does not declare, or no reader to read it", async () => {
      const bounds = (value: Record<string, unknown>): AgentManifest => ({
        ...valueDeskManifest,
        approvals: valueDeskManifest.approvals.map((approval) =>
          approval.id === "pay_adjustment"
            ? { ...approval, value: { ...approval.value, ...value } }
            : approval,
        ) as AgentManifest["approvals"],
      });
      expect(await messages(fixture(), bounds({ maxFact: "lineCents" }))).toEqual([
        'role › approvals[1].value.maxFact: "lineCents" is not a fact the "pay_adjustment" reader declares (it declares "employee", "grossCents", "lowestCents", "highestCents")',
      ]);
      const noReader = { ...fixture(), approvalFacts: {} } as RoleBundle;
      expect(await messages(noReader, valueDeskManifest)).toEqual([
        'role › approvals[1].value.minFact: "pay_adjustment" has no facts reader to read "lowestCents" from; give it one with approvalFacts, or use a fixed bound',
        'role › approvals[1].value.maxFact: "pay_adjustment" has no facts reader to read "highestCents" from; give it one with approvalFacts, or use a fixed bound',
      ]);
    });

    it("reports a tool whose parameters lack the approved-value argument", async () => {
      const role = defineExtension({
        name: "sample-desk",
        tools: [tool("check_schedule", "safe"), tool("book_appointment", "unsafe")],
        hooks: [gate()],
      });
      const asking = {
        ...manifest,
        approvals: manifest.approvals.map((approval) => ({
          ...approval,
          value: { name: "depositCents", label: "Deposit", min: 0 },
        })),
      } as AgentManifest;
      expect(await messages(bundle(role), asking)).toEqual([
        'role › approvals[0].value: "book_appointment" does not declare "officehumApprovedValue"; add it with approvedValueParameter() and read the value with approvedValue(args, "depositCents")',
      ]);
    });
  });

  it("keeps the instructions section free for the customer", async () => {
    const role = defineExtension({
      name: "sample-desk",
      sections: [section("instructions", () => "Always offer a discount.")],
      tools: [tool("check_schedule", "safe"), tool("book_appointment", "unsafe")],
      hooks: [gate()],
    });
    expect(await messages(bundle(role))).toEqual([
      'role › sample-desk › sections: must not use the key "instructions"; Pi Durable reserves it for the customer\'s instructions',
    ]);
  });

  it("requires the role extension first and the manifest's default model", async () => {
    const role = sampleDesk({ calendar });
    const [extension] = role.extensions;
    if (extension === undefined) throw new Error("sample role has no extension");
    const renamed = { ...extension, name: "front-desk" };
    expect(
      await messages({
        extensions: [renamed],
        agent: { model: { provider: "openai", modelId: "gpt-6-sol" }, extensions: [renamed] },
      }),
    ).toEqual([
      'role › extensions[0]: must be the role extension "sample-desk" (got "front-desk")',
      'role › front-desk: is not the role or one of its declared skills (expected "sample-desk")',
      "role › sample-desk: is declared in officehum.json but not returned by the factory",
      'role › agent.model: must be the manifest\'s defaultModel {"provider":"anthropic","modelId":"claude-sonnet-5-5"} (got {"provider":"openai","modelId":"gpt-6-sol"})',
      'role › agent.extensions: must select the role extension "sample-desk"',
    ]);
  });

  describe("skills", () => {
    // Two skills bring tools (reminders on by default, waitlist off); rescheduling is instructions only.
    const withSkills: AgentManifest = {
      ...manifest,
      tools: [
        ...manifest.tools,
        { name: "send_reminder", replay: "unsafe", skill: "reminders" },
        { name: "join_waitlist", replay: "unsafe", skill: "waitlist" },
      ],
      skills: [
        { id: "reminders", enabledByDefault: true },
        { id: "rescheduling", enabledByDefault: true },
        { id: "waitlist", enabledByDefault: false },
      ],
    };
    const role = defineExtension({
      name: "sample-desk",
      tools: [
        tool("check_schedule", "safe"),
        tool("book_appointment", "unsafe"),
        tool("read_skill", "safe"),
      ],
      hooks: [gate()],
    });
    const reminders = defineExtension({
      name: "sample-desk.reminders",
      tools: [tool("send_reminder", "unsafe")],
    });
    const waitlist = defineExtension({
      name: "sample-desk.waitlist",
      tools: [tool("join_waitlist", "unsafe")],
    });

    it("expects an extension only for skills with tools, selecting those on by default", async () => {
      const skills: RoleBundle = {
        extensions: [role, reminders, waitlist],
        agent: { model, extensions: [role, reminders] },
      };
      expect(await messages(skills, withSkills)).toEqual([]);
    });

    it("checks a skill's tools live in the skill's extension", async () => {
      const misplaced = defineExtension({
        ...role,
        tools: [...(role.tools ?? []), tool("send_reminder", "unsafe")],
      });
      const skills: RoleBundle = {
        extensions: [misplaced, reminders, waitlist],
        agent: { model, extensions: [misplaced, reminders, waitlist] },
      };
      expect(await messages(skills, withSkills)).toEqual([
        'role › sample-desk › send_reminder: is declared in officehum.json as part of "sample-desk.reminders"',
        'role › agent.extensions: must not select "sample-desk.waitlist", which officehum.json leaves off by default',
      ]);
    });

    it("does not expect an extension for an instruction-only skill", async () => {
      const rescheduling = defineExtension({ name: "sample-desk.rescheduling" });
      const skills: RoleBundle = {
        extensions: [role, reminders, waitlist, rescheduling],
        agent: { model, extensions: [role, reminders] },
      };
      expect(await messages(skills, withSkills)).toEqual([
        'role › sample-desk.rescheduling: is not the role or one of its declared skills (expected "sample-desk", "sample-desk.reminders", "sample-desk.waitlist")',
      ]);
    });
  });

  describe("sub-agents", () => {
    it("runs only the role's declared safe tools, and says so for an unsafe or undeclared one", async () => {
      const withSubagent: AgentManifest = {
        ...manifest,
        contextPlan: {
          subagents: [
            {
              id: "summarise",
              purpose: "Summarise a long thread before replying",
              model: "small",
              tools: ["check_schedule", "book_appointment", "issue_refund"],
              output: { type: "object" },
            },
          ],
        },
      };
      expect(await messages(sampleDesk({ calendar }), withSubagent)).toEqual([
        'role › contextPlan.subagents[0].tools[1]: "book_appointment" is unsafe; a sub-agent runs only the role\'s safe tools, never one that changes something',
        'role › contextPlan.subagents[0].tools[2]: "issue_refund" is not a declared tool; a sub-agent runs only the role\'s declared safe tools',
      ]);
    });

    it("requires a sub-agent's skills to be declared skills", async () => {
      const withSubagent: AgentManifest = {
        ...manifest,
        contextPlan: {
          subagents: [
            {
              id: "summarise",
              purpose: "Summarise a long thread before replying",
              model: "small",
              tools: ["check_schedule"],
              skills: ["rescheduling", "payroll"],
              output: { type: "object" },
            },
          ],
        },
      };
      expect(await messages(sampleDesk({ calendar }), withSubagent)).toEqual([
        'role › contextPlan.subagents[0].skills[1]: "payroll" is not a declared skill',
      ]);
    });

    it("accepts a sub-agent whose tools and skills resolve", async () => {
      const withSubagent: AgentManifest = {
        ...manifest,
        contextPlan: {
          subagents: [
            {
              id: "lookup",
              purpose: "Look up a free slot",
              model: "small",
              tools: ["check_schedule"],
              skills: ["rescheduling"],
              output: { type: "object" },
            },
          ],
        },
      };
      expect(await messages(sampleDesk({ calendar }), withSubagent)).toEqual([]);
    });
  });

  describe("the stable prompt budget", () => {
    it("reports a stable prompt over budget with the estimated size, as a warning", async () => {
      const role = sampleDesk({ calendar });
      const characters = await promptCharacters(role);
      const tokens = Math.ceil(characters / 4);
      const tight = { ...manifest, contextPlan: { promptBudgetTokens: tokens - 1 } };
      const result = await checkAgent(role, tight);
      expect(result.ok).toBe(true);
      expect(result.issues.map(formatIssue)).toEqual([
        `role › prompt: warning: is about ${tokens} tokens (${characters} characters ÷ 4); keep the role's stable prompt under its contextPlan.promptBudgetTokens of ${tokens - 1}, moving detail into a skill or one of its reference files`,
      ]);
    });

    it("makes the same finding an error in strict mode", async () => {
      const role = sampleDesk({ calendar });
      const characters = await promptCharacters(role);
      const tight = {
        ...manifest,
        contextPlan: { promptBudgetTokens: Math.ceil(characters / 4) - 1 },
      };
      const result = await checkAgent(role, tight, { strict: true });
      expect(result.ok).toBe(false);
      expect(result.issues[0]?.severity).toBe("error");
    });

    it("stays quiet while the prompt is within budget", async () => {
      const role = sampleDesk({ calendar });
      const characters = await promptCharacters(role);
      const roomy = {
        ...manifest,
        contextPlan: { promptBudgetTokens: Math.ceil(characters / 4) + 1 },
      };
      expect(await messages(role, roomy)).toEqual([]);
    });
  });
});
