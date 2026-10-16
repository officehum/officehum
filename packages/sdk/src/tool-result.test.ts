/**
 * The tool-result shape guard: `defineRole` wraps every tool it returns, so a tool that still
 * returns the pre-1.2.0 `content` field fails loudly at the call instead of handing the model an
 * empty result. No model, no network.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import sampleManifest from "../fixtures/sample-desk/officehum.json" with { type: "json" };
import { defineRole } from "./role.js";
import { SAMPLE_DIR } from "./test-helpers.js";
import { guardToolResultShape } from "./tool-result.js";

/** A fixture tool whose result still uses `content`, the field Pi Durable renamed to `output`. */
function leakyTool(): ToolRegistration {
  return defineTool({
    name: "leaky_tool",
    description: "Returns its result under the field Pi Durable 1.2.0 renamed.",
    parameters: Type.Object({}),
    replay: "safe",
    // A known field, `details`, overlaps, so TypeScript does not flag the stray `content`.
    execute: async () => ({ content: [{ type: "text", text: "looks fine" }], details: {} }),
  });
}

/** A fixture tool that returns a correct result, for the pass case. */
function goodTool(): ToolRegistration {
  return defineTool({
    name: "good_tool",
    description: "Returns its result under `output`.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async () => ({ output: [{ type: "text", text: "ok" }], details: {} }),
  });
}

function toolNamed(tools: readonly ToolRegistration[] | undefined, name: string): ToolRegistration {
  const tool = tools?.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return tool;
}

describe("tool-result shape guard", () => {
  it("fails a fixture tool that returns content instead of output, naming the tool", async () => {
    const role = defineRole({
      packageDir: SAMPLE_DIR,
      manifest: sampleManifest,
      tools: [leakyTool()],
    });
    // The guard is installed by defineRole, so the tool in the built bundle is the wrapped one.
    const leaky = toolNamed(role.extensions[0]?.tools, "leaky_tool");
    await expect(leaky.execute({}, {} as never, {} as never)).rejects.toThrow(
      /leaky_tool[\s\S]*"output"/,
    );
  });

  it("passes a tool whose result uses output, and passes the result through unchanged", async () => {
    const role = defineRole({
      packageDir: SAMPLE_DIR,
      manifest: sampleManifest,
      tools: [goodTool()],
    });
    const good = toolNamed(role.extensions[0]?.tools, "good_tool");
    expect(await good.execute({}, {} as never, {} as never)).toMatchObject({
      output: [{ type: "text", text: "ok" }],
    });
  });

  it("fires on content whether or not the result also sets output", () => {
    expect(() => guardToolResultShape("t", { output: [] })).not.toThrow();
    expect(() => guardToolResultShape("t", { output: [], isError: true })).not.toThrow();
    expect(() => guardToolResultShape("t", { details: { nested: { content: [] } } })).not.toThrow();
    expect(() => guardToolResultShape("t", undefined)).not.toThrow();
    expect(() => guardToolResultShape("t", { content: [], output: [] })).toThrow(/t/);
  });
});
