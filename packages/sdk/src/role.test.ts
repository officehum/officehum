import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  HookApi,
  HookRegistration,
  PromptSection,
  ToolHooks,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import sampleManifest from "../fixtures/sample-desk/officehum.json" with { type: "json" };
import sampleDesk from "../fixtures/sample-desk/src/index.js";
import { checkAgent } from "./agent.js";
import { isApprovalGate } from "./approvals.js";
import type { AgentManifest } from "./manifest.js";
import { defineRole, RoleFilesError } from "./role.js";
import { ACME_OVERLAY, removeTempDirs, SAMPLE_DIR, tempDir } from "./test-helpers.js";

afterEach(removeTempDirs);

const calendar = { freeSlots: async () => [], book: async () => ({ id: "A1" }) };

async function render(
  sections: readonly PromptSection[] | undefined,
): Promise<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {};
  for (const section of sections ?? []) {
    out[section.key] = await section.render({} as never, {} as never);
  }
  return out;
}

async function callTool(
  tools: readonly ToolRegistration[] | undefined,
  name: string,
  args: object,
) {
  const tool = tools?.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  const result = await tool.execute(args as never, {} as never, {} as never);
  const [first] = result.output ?? [];
  return { isError: result.isError === true, text: first?.type === "text" ? first.text : "" };
}

/** The approval gate a role installs, ready to drive a call through. */
function gateOf(role: {
  readonly extensions: readonly { readonly hooks?: readonly HookRegistration[] }[];
}) {
  const registration = (role.extensions[0]?.hooks ?? []).find(isApprovalGate);
  if (registration === undefined) throw new Error("the role has no approval gate");
  return (registration as unknown as { handlers: Pick<ToolHooks, "beforeTool"> }).handlers
    .beforeTool;
}

/** A hook API whose memo is a map: as durable as one call needs. */
function hookApi(): HookApi {
  const memos = new Map<string, unknown>();
  return {
    taskId: "task-1",
    conversationId: "conversation-1",
    memo: async (name: string, ...rest: unknown[]) => {
      if (rest.length === 2 && !memos.has(name)) memos.set(name, rest[0]);
      return memos.get(name);
    },
  } as unknown as HookApi;
}

const bookCall = (id: string) =>
  ({
    type: "toolCall",
    id,
    name: "book_appointment",
    arguments: { start: "2026-11-24T19:00" },
  }) as Parameters<ToolHooks["beforeTool"]>[0];

describe("defineRole", () => {
  it("builds the sample role from its files, and it matches its manifest", async () => {
    const role = sampleDesk({ calendar });
    expect((await checkAgent(role, sampleManifest as AgentManifest)).issues).toEqual([]);
    const [extension] = role.extensions;
    const sections = await render(extension?.sections);
    expect(Object.keys(sections)).toEqual(["agents_md", "skills", "append_system"]);
    expect(sections.agents_md).toMatch(/^# Sample Desk/);
    expect(sections.skills).toContain("- rescheduling: Move an existing appointment");
    expect(sections.append_system).toMatch(/^Never promise a slot/);
    expect(extension?.tools?.map((tool) => tool.name)).toEqual([
      "check_schedule",
      "book_appointment",
      "read_skill",
    ]);
  });

  it("loads a skill's instructions and reference files on demand", async () => {
    const tools = sampleDesk({ calendar }).extensions[0]?.tools;
    expect((await callTool(tools, "read_skill", { name: "rescheduling" })).text).toMatch(
      /^1\. Ask for the booking reference/,
    );
    expect(
      (await callTool(tools, "read_skill", { name: "rescheduling", file: "references/policy.md" }))
        .text,
    ).toMatch(/^# Rescheduling policy/);
    expect(await callTool(tools, "read_skill", { name: "payroll" })).toEqual({
      isError: true,
      text: 'There is no skill called "payroll".',
    });
    expect(
      await callTool(tools, "read_skill", { name: "rescheduling", file: "../../APPEND_SYSTEM.md" }),
    ).toEqual({
      isError: true,
      text: 'The rescheduling skill has no file "../../APPEND_SYSTEM.md".',
    });
  });

  it("layers a customer's overlay into the prompt and the agent settings", async () => {
    const role = sampleDesk({ calendar, overlays: [ACME_OVERLAY] });
    const sections = await render(role.extensions[0]?.sections);
    expect(sections.agents_md).toContain("## About Acme Dental");
    expect(sections.skills).toContain("- vip-customers: How to look after Acme's members.");
    expect(role.agent.thinkingLevel).toBe("low");
  });

  it("removes tools an overlay switches off", () => {
    const overlay = tempDir("acme", {
      "settings.json": JSON.stringify({ tools: ["-book_appointment"] }),
    });
    const role = sampleDesk({ calendar, overlays: [overlay] });
    const tools = role.agent.tools;
    expect(
      tools != null && !Array.isArray(tools) && "remove" in tools
        ? tools.remove.map((tool) => tool.name)
        : [],
    ).toEqual(["book_appointment"]);
  });

  it("stops asking for an approval an overlay switches off, and asks again once it is back", async () => {
    const overlay = tempDir("acme", {
      "settings.json": JSON.stringify({ approvals: ["-book_after_hours"] }),
    });
    // No approver: a gated call is blocked, so whether the gate applies is what the result shows.
    const role = sampleDesk({ calendar, overlays: [overlay] });
    const gate = gateOf(role);
    expect(await gate(bookCall("call-1"), hookApi(), {} as never)).toBeUndefined();

    writeFileSync(join(overlay, "settings.json"), JSON.stringify({ approvals: [] }));
    expect(role.reload()).toEqual([]);
    expect((await gate(bookCall("call-2"), hookApi(), {} as never))?.block).toContain(
      "needs a person's approval (Bookings that start at 18:00 or later)",
    );
  });

  it("takes overlay edits live, and keeps the last good files when an edit is broken", async () => {
    const overlay = tempDir("acme", { "AGENTS.md": "Acme opens at 08:00." });
    const role = sampleDesk({ calendar, overlays: [overlay] });
    expect((await render(role.extensions[0]?.sections)).agents_md).toContain(
      "Acme opens at 08:00.",
    );

    writeFileSync(join(overlay, "AGENTS.md"), "Acme opens at 07:30.");
    expect(role.reload()).toEqual([]);
    expect((await render(role.extensions[0]?.sections)).agents_md).toContain(
      "Acme opens at 07:30.",
    );

    writeFileSync(join(overlay, "settings.json"), "{ not json");
    expect(role.reload()).not.toEqual([]);
    expect((await render(role.extensions[0]?.sections)).agents_md).toContain(
      "Acme opens at 07:30.",
    );
  });

  it("lists and loads an extension's skills with the role's own (extraSkills)", async () => {
    const memory = tempDir("memory-hygiene", {
      "SKILL.md":
        "---\nname: memory-hygiene\ndescription: What is worth remembering.\n---\n\nSave one fact per record.\n",
    });
    const role = defineRole({
      packageDir: SAMPLE_DIR,
      manifest: sampleManifest,
      extraSkills: [memory],
    });
    const [extension] = role.extensions;
    expect((await render(extension?.sections)).skills).toContain(
      "- memory-hygiene: What is worth remembering.",
    );
    expect((await callTool(extension?.tools, "read_skill", { name: "memory-hygiene" })).text).toBe(
      "Save one fact per record.",
    );
    const clash = tempDir("rescheduling", {
      "SKILL.md": "---\nname: rescheduling\ndescription: Another.\n---\n\nBody.\n",
    });
    expect(() =>
      defineRole({ packageDir: SAMPLE_DIR, manifest: sampleManifest, extraSkills: [clash] }),
    ).toThrow(/skill "rescheduling" is also .*skills\/rescheduling; rename one of them/);
  });

  it("refuses to build a role with a broken manifest or files", () => {
    expect(() =>
      defineRole({ packageDir: SAMPLE_DIR, manifest: { ...sampleManifest, tools: "none" } }),
    ).toThrow(RoleFilesError);
    const broken = tempDir("acme", {
      "settings.json": JSON.stringify({ tools: ["+issue_refund"] }),
    });
    expect(() => sampleDesk({ calendar, overlays: [broken] })).toThrow(
      /overlay acme\/settings\.json › tools\[0\]: "issue_refund" is not a tool of this role/,
    );
  });
});
