/**
 * Tool packs: tools a role declares with `"pack"` and the office supplies. The role is
 * built with or without the pack, and only the pack's tools it declares are offered.
 */
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";
import sampleManifest from "../fixtures/sample-desk/officehum.json" with { type: "json" };
import { checkAgent } from "./agent.js";
import { formatIssue } from "./issues.js";
import { type AgentManifest, validateManifest } from "./manifest.js";
import { defineRole, RoleFilesError } from "./role.js";
import { SAMPLE_DIR } from "./test-helpers.js";
import type { ToolPack } from "./tool-packs.js";

const QUERY = {
  name: "data_query",
  replay: "safe",
  pack: "data",
  description: "Answers a question over a spreadsheet with an exact figure.",
} as const;

/** The sample desk with the data pack's `data_query` declared, and any fields replaced. */
function manifestWith(tool: Record<string, unknown> = QUERY): AgentManifest {
  const manifest = structuredClone(sampleManifest) as unknown as AgentManifest;
  return { ...manifest, tools: [...manifest.tools, tool as AgentManifest["tools"][number]] };
}

const messages = (value: unknown) => {
  const result = validateManifest(value);
  return result.ok ? [] : result.issues.map(formatIssue);
};

const packTool = (name: string, replay: "safe" | "unsafe" = "safe"): ToolRegistration =>
  defineTool({
    name,
    description: `The pack's own ${name}.`,
    parameters: obj({ date: opt(str()), sql: opt(str()) }),
    replay,
    execute: async () => ({ output: [{ type: "text" as const, text: `${name} ran` }] }),
  }) as unknown as ToolRegistration;

const dataPack = (tools = [packTool("data_query"), packTool("data_export")]): ToolPack => ({
  id: "data",
  tools,
});

function role(manifest: AgentManifest, packs?: readonly ToolPack[]) {
  return defineRole({
    packageDir: SAMPLE_DIR,
    manifest,
    tools: [packTool("check_schedule"), packTool("book_appointment", "unsafe")],
    ...(packs === undefined ? {} : { packs }),
  });
}

const offered = (bundle: ReturnType<typeof role>) =>
  bundle.extensions.flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name));

describe("a pack tool in officehum.json", () => {
  it("is declared like any tool, with its pack's id", () => {
    expect(messages(manifestWith())).toEqual([]);
  });

  it("states a description, for the agent card and a reviewer", () => {
    const { description: _description, ...bare } = QUERY;
    expect(messages(manifestWith(bare))).toEqual([
      "officehum.json › tools[2].description: is required for a pack tool: the agent card and a reviewer read it (the model reads the pack's own)",
    ]);
  });

  it("takes its parameters from the pack, never from the manifest", () => {
    const parameters = { sql: { type: "string", description: "The query." } };
    expect(messages(manifestWith({ ...QUERY, parameters }))).toEqual([
      "officehum.json › tools[2].parameters: come from the data pack; remove them",
    ]);
  });

  it("comes from its pack alone", () => {
    expect(messages(manifestWith({ ...QUERY, engine: ["query"] }))).toContain(
      'officehum.json › tools[2]: "data_query" states 2 sources, engine and pack; a tool comes from exactly one (engine, mcp, cli, pack, or code with none)',
    );
  });

  it("states an approval decision when it writes, like any tool", () => {
    expect(messages(manifestWith({ ...QUERY, writes: true }))).toEqual([
      'officehum.json › tools[2]: "data_query" writes and states no approval decision; add an approval in approvals[], or a noApproval note saying why it needs none',
    ]);
  });

  it("names its pack in kebab-case", () => {
    expect(messages(manifestWith({ ...QUERY, pack: "Data Pack" }))).toEqual([
      expect.stringContaining("officehum.json › tools[2].pack:"),
    ]);
  });
});

describe("a role with pack tools", () => {
  it("loads without the pack and offers none of its tools", async () => {
    const manifest = manifestWith();
    const bundle = role(manifest);
    expect(offered(bundle)).not.toContain("data_query");
    expect((await checkAgent(bundle, manifest)).issues).toEqual([]);
  });

  it("offers the pack's tools it declares, and only those, when given the pack", async () => {
    const manifest = manifestWith();
    const bundle = role(manifest, [dataPack()]);
    expect(offered(bundle)).toContain("data_query");
    expect(offered(bundle)).not.toContain("data_export");
    expect((await checkAgent(bundle, manifest, { packs: ["data"] })).issues).toEqual([]);
  });

  it("is refused by checkAgent when it was given the pack but does not offer its tools", async () => {
    const manifest = manifestWith();
    expect((await checkAgent(role(manifest), manifest, { packs: ["data"] })).issues).toEqual([
      {
        source: "role",
        path: "sample-desk › data_query",
        message: "is declared in officehum.json but no extension provides it",
      },
    ]);
  });

  it("is refused when the pack it is given lacks a tool it declares", () => {
    expect(() => role(manifestWith(), [dataPack([packTool("data_export")])])).toThrow(
      RoleFilesError,
    );
    expect(() => role(manifestWith(), [dataPack([packTool("data_export")])])).toThrow(
      'role › tools[2].pack: the data pack has no tool "data_query"; it has "data_export"',
    );
  });

  it("is refused when two packs share an id", () => {
    expect(() => role(manifestWith(), [dataPack(), dataPack()])).toThrow(
      'role › packs: the pack "data" is given more than once',
    );
  });

  it("checks the pack tool's replay against the manifest", async () => {
    const manifest = manifestWith();
    const bundle = role(manifest, [dataPack([packTool("data_query", "unsafe")])]);
    expect((await checkAgent(bundle, manifest, { packs: ["data"] })).issues).toEqual([
      {
        source: "role",
        path: "sample-desk › data_query",
        message: 'replay is "unsafe" in code but "safe" in officehum.json',
      },
    ]);
  });

  it("runs the pack's own tool", async () => {
    const bundle = role(manifestWith(), [dataPack()]);
    const tool = bundle.extensions[0]?.tools?.find((candidate) => candidate.name === "data_query");
    expect(tool?.description).toBe("The pack's own data_query.");
    const result = await tool?.execute({ sql: "SELECT 1" } as never, {} as never, {} as never);
    expect(result?.output).toEqual([{ type: "text", text: "data_query ran" }]);
  });
});
