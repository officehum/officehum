/**
 * The real stdio path, end to end: pi-mcp's `StdioTransport` starts the fixture's own server
 * (`fixtures/sample-tickets/server/tickets-server.mjs`, plain Node with no dependencies) with this
 * Node binary, and the role's MCP tool calls it. The test starts the server itself, as a host would;
 * the role never does. No third-party server, no network.
 */
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { McpClient, StdioTransport } from "@earendil-works/pi-mcp";
import { afterEach, describe, expect, it } from "vitest";
import ticketsManifest from "../fixtures/sample-tickets/officehum.json" with { type: "json" };
import sampleTickets from "../fixtures/sample-tickets/src/index.js";
import { checkAgent } from "./agent.js";
import type { AgentManifest } from "./manifest.js";
import { checkMcpDrift } from "./mcp.js";

const manifest = ticketsManifest as unknown as AgentManifest;
const SERVER = fileURLToPath(
  new URL("../fixtures/sample-tickets/server/tickets-server.mjs", import.meta.url),
);

const open: McpClient[] = [];
afterEach(async () => {
  for (const client of open.splice(0)) await client.close();
});

/** Starts the fixture server as a child with only PATH in its environment, and connects to it. */
async function connect() {
  const transport = new StdioTransport({
    command: process.execPath,
    args: [SERVER],
    inheritEnv: false,
    env: { PATH: process.env.PATH ?? "" },
  });
  const client = new McpClient({ name: "officehum-sdk-test", version: "0.0.0" });
  open.push(client);
  await client.connect(transport);
  return { client, transport };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const api = (callId: string) =>
  ({ conversationId: "conversation-1", taskId: 1, callId }) as unknown as ToolExecutionApi;

describe("an MCP tool over a real stdio server", () => {
  it("connects, lists, drift-checks, calls, and closes with no process left behind", async () => {
    const { client, transport } = await connect();
    expect(client.serverInfo?.name).toBe("sample-tickets-server");
    const pid = transport.pid;
    expect(pid).toBeTypeOf("number");

    expect((await client.listTools()).map((tool) => tool.name)).toEqual([
      "create_ticket",
      "list_tickets",
    ]);
    expect(await checkMcpDrift(manifest, "tickets", client)).toEqual({
      issues: [],
      hidden: ["list_tickets"],
    });

    const role = sampleTickets({ mcp: { tickets: client } });
    expect((await checkAgent(role, manifest, { strict: true })).ok).toBe(true);
    const tool = role.extensions[0]?.tools?.find((candidate) => candidate.name === "create_ticket");
    const args = { title: "Login page is blank", priority: "normal" };
    const first = await tool?.execute(args, api("call-1"), BACKGROUND_CONTEXT);
    expect(first?.isError).toBeUndefined();
    expect(JSON.stringify(first?.output)).toContain("Opened ticket T-1");
    // The same call id is the same idempotency key, so the server answers with the same ticket.
    const again = await tool?.execute(args, api("call-1"), BACKGROUND_CONTEXT);
    expect(JSON.stringify(again?.output)).toContain("Opened ticket T-1");
    const other = await tool?.execute(args, api("call-2"), BACKGROUND_CONTEXT);
    expect(JSON.stringify(other?.output)).toContain("Opened ticket T-2");

    await client.close();
    expect(client.connectionState).toBe("closed");
    if (pid === undefined) throw new Error("the server had no pid");
    await expect.poll(() => alive(pid), { timeout: 5000 }).toBe(false);
  });

  it("carries a server-side failure through as an error result", async () => {
    const { client } = await connect();
    const role = sampleTickets({ mcp: { tickets: client } });
    const tool = role.extensions[0]?.tools?.find((candidate) => candidate.name === "create_ticket");
    const result = await tool?.execute(
      { title: "", priority: "low" },
      api("call-1"),
      BACKGROUND_CONTEXT,
    );
    expect(result?.isError).toBe(true);
    expect(JSON.stringify(result?.output)).toContain("title is required");
  });
});
