/**
 * pi-mcp is an optional peer: a role with no MCP tools never imports it (design section 11). The
 * mock below records every import of the package; it replaces nothing, so the real module is used
 * whenever it is loaded.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";

const loads = vi.hoisted(() => ({ count: 0 }));
vi.mock("@earendil-works/pi-mcp", async (importOriginal) => {
  loads.count++;
  return await importOriginal();
});

const api = { conversationId: "c", taskId: 1, callId: "call-1" } as unknown as ToolExecutionApi;

describe("loading pi-mcp", () => {
  it("never happens for a role with no MCP tools, and happens on an MCP tool's first call", async () => {
    const sdk = await import("./index.js");
    const { default: sampleStockroom, packageDir } = await import(
      "../fixtures/sample-stockroom/src/index.js"
    );
    const { default: stockroomManifest } = await import(
      "../fixtures/sample-stockroom/officehum.json",
      { with: { type: "json" } }
    );
    const engine = sdk.stubEngine({ levels: { findings: [{ id: "stock:BOLT-10" }] } });
    const stockroom = sampleStockroom({ engine });
    const manifest = stockroomManifest as unknown as import("./manifest.js").AgentManifest;
    expect(manifest.mcpServers).toBeUndefined();
    expect((await sdk.checkAgent(stockroom, manifest)).ok).toBe(true);
    expect((await sdk.validatePackage(packageDir)).ok).toBe(true);
    const levels = stockroom.extensions[0]?.tools?.find((tool) => tool.name === "stock_levels");
    await levels?.execute({}, api, BACKGROUND_CONTEXT);
    expect(loads.count).toBe(0);

    // Building a role with MCP tools does not load it either: only a call does.
    const { default: sampleTickets } = await import("../fixtures/sample-tickets/src/index.js");
    const client = {
      listTools: async () => [],
      callTool: async () => ({ content: [{ type: "text", text: "Opened ticket T-1" }] }),
    };
    const tickets = sampleTickets({ mcp: { tickets: client } });
    expect(loads.count).toBe(0);
    const create = tickets.extensions[0]?.tools?.find((tool) => tool.name === "create_ticket");
    const result = await create?.execute({ title: "x", priority: "low" }, api, BACKGROUND_CONTEXT);
    expect(JSON.stringify(result?.output)).toContain("Opened ticket T-1");
    expect(loads.count).toBe(1);
  });
});
