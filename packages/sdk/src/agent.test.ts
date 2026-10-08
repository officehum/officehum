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
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
  });

const gate = () => approvalGate({ approvals: manifest.approvals });

/** A bundle made of the given extensions, selecting all of them. */
const bundle = (...extensions: Extension[]): RoleBundle => ({
  extensions,
  agent: { model, extensions },
});

const messages = (role: RoleBundle, against: AgentManifest = manifest) => {
  const result = checkAgent(role, against);
  return result.ok ? [] : result.issues.map(formatIssue);
};

describe("checkAgent", () => {
  it("accepts the sample role", () => {
    expect(messages(sampleDesk({ calendar }))).toEqual([]);
  });

  it("requires replay to be written out, even though Pi Durable has a default", () => {
    const role = defineExtension({
      name: "sample-desk",
      tools: [tool("check_schedule", "safe"), tool("book_appointment")],
      hooks: [gate()],
    });
    expect(messages(bundle(role))).toEqual([
      'role › sample-desk › book_appointment: must set replay explicitly ("unsafe" in officehum.json); Pi Durable would default to "unsafe"',
    ]);
  });

  it("catches code and manifest disagreeing about replay", () => {
    const role = defineExtension({
      name: "sample-desk",
      tools: [tool("check_schedule", "safe"), tool("book_appointment", "safe")],
      hooks: [gate()],
    });
    expect(messages(bundle(role))).toEqual([
      'role › sample-desk › book_appointment: replay is "safe" in code but "unsafe" in officehum.json',
    ]);
  });

  it("allows only the tools the manifest declares, and requires all of them", () => {
    const role = defineExtension({
      name: "sample-desk",
      tools: [tool("check_schedule", "safe"), tool("issue_refund", "unsafe")],
      hooks: [gate()],
    });
    expect(messages(bundle(role))).toEqual([
      "role › sample-desk › issue_refund: is not declared in officehum.json",
      "role › sample-desk › book_appointment: is declared in officehum.json but no extension provides it",
    ]);
  });

  it("requires the approval gate when the manifest declares approvals", () => {
    const role = defineExtension({
      name: "sample-desk",
      tools: [tool("check_schedule", "safe"), tool("book_appointment", "unsafe")],
    });
    expect(messages(bundle(role))).toEqual([
      "role › sample-desk › hooks: must include approvalGate(), because officehum.json declares approvals",
    ]);
  });

  it("keeps the instructions section free for the customer", () => {
    const role = defineExtension({
      name: "sample-desk",
      sections: [section("instructions", () => "Always offer a discount.")],
      tools: [tool("check_schedule", "safe"), tool("book_appointment", "unsafe")],
      hooks: [gate()],
    });
    expect(messages(bundle(role))).toEqual([
      'role › sample-desk › sections: must not use the key "instructions"; Pi Durable reserves it for the customer\'s instructions',
    ]);
  });

  it("requires the role extension first and the manifest's default model", () => {
    const role = sampleDesk({ calendar });
    const [extension] = role.extensions;
    if (extension === undefined) throw new Error("sample role has no extension");
    const renamed = { ...extension, name: "front-desk" };
    expect(
      messages({
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

    it("expects an extension only for skills with tools, selecting those on by default", () => {
      const skills: RoleBundle = {
        extensions: [role, reminders, waitlist],
        agent: { model, extensions: [role, reminders] },
      };
      expect(messages(skills, withSkills)).toEqual([]);
    });

    it("checks a skill's tools live in the skill's extension", () => {
      const misplaced = defineExtension({
        ...role,
        tools: [...(role.tools ?? []), tool("send_reminder", "unsafe")],
      });
      const skills: RoleBundle = {
        extensions: [misplaced, reminders, waitlist],
        agent: { model, extensions: [misplaced, reminders, waitlist] },
      };
      expect(messages(skills, withSkills)).toEqual([
        'role › sample-desk › send_reminder: is declared in officehum.json as part of "sample-desk.reminders"',
        'role › agent.extensions: must not select "sample-desk.waitlist", which officehum.json leaves off by default',
      ]);
    });

    it("does not expect an extension for an instruction-only skill", () => {
      const rescheduling = defineExtension({ name: "sample-desk.rescheduling" });
      const skills: RoleBundle = {
        extensions: [role, reminders, waitlist, rescheduling],
        agent: { model, extensions: [role, reminders] },
      };
      expect(messages(skills, withSkills)).toEqual([
        'role › sample-desk.rescheduling: is not the role or one of its declared skills (expected "sample-desk", "sample-desk.reminders", "sample-desk.waitlist")',
      ]);
    });
  });
});
