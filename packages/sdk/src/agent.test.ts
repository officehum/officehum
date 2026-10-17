import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, section } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import sampleManifest from "../fixtures/sample-desk/officehum.json" with { type: "json" };
import sampleDesk from "../fixtures/sample-desk/src/index.js";
import { checkAgent, type RoleBundle } from "./agent.js";
import { approvalGate } from "./approvals.js";
import { formatIssue } from "./issues.js";
import type { AgentManifest } from "./manifest.js";

const manifest = sampleManifest as AgentManifest;
const calendar = { freeSlots: async () => [], book: async () => ({ id: "A1" }) };
const model = { provider: "anthropic", modelId: "claude-sonnet-5-5" };

const tool = (name: string, replay?: "safe" | "unsafe") =>
  defineTool({
    name,
    description: name,
    parameters: Type.Object({}),
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
