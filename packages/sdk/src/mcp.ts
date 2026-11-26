/**
 * MCP tools: tools a role declares in `officehum.json` that an MCP server carries out. The manifest
 * states each one's name, description, parameters and `replay`; the server only runs it. A role never
 * starts a server: its factory takes connected clients, keyed by server id, the way it takes any app
 * client. See docs/design/tool-sources.md.
 *
 * `@earendil-works/pi-mcp` is an optional peer. Nothing here imports it at load time: it is imported
 * on the first call of an MCP tool, or by `stubMcp`, so a role with no MCP tools never loads it. The
 * public types below are structural, so the SDK's own type declarations never name the package
 * either; pi-mcp's `McpClient` satisfies `McpToolClient`.
 */

import { defineTool, type JsonObject, type ToolRegistration } from "@earendil-works/pi-durable";
import { declaredDescription, declaredParameters } from "./declared-tool.js";
import { type Issue, show } from "./issues.js";
import {
  type AgentManifest,
  MANIFEST_FILE,
  type ParameterDeclaration,
  type ToolDeclaration,
} from "./manifest.js";
import { frameOutsideOutput, type LlmBlock } from "./outside-output.js";

/** The MCP client package, and the exact version this SDK is built and tested against. */
export const PI_MCP_PACKAGE = "@earendil-works/pi-mcp";
export const PI_MCP_VERSION = "1.6.0";

/** A server tool as `tools/list` reports it: the fields the SDK reads. */
export interface McpServerTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** The server's opinion of the tool. Never used to set `replay` or to skip an approval. */
  readonly annotations?: unknown;
}

/** What a server returned for one call. A failure is `isError: true`, not a thrown error. */
export interface McpCallResult {
  /** MCP content blocks: text, images, resources. Only their shape is checked here. */
  readonly content: readonly { readonly type: string; readonly text?: string }[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

/** What the SDK needs of a connected MCP client. pi-mcp's `McpClient` is one. */
export interface McpToolClient {
  listTools(options?: { signal?: AbortSignal }): Promise<readonly McpServerTool[]>;
  callTool(
    name: string,
    args?: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<McpCallResult>;
}

/** Connected clients by `mcpServers` id. A declared server with no client answers "not connected". */
export type McpClients = Readonly<Record<string, McpToolClient | undefined>>;

type PiMcp = typeof import("@earendil-works/pi-mcp");
type PiMcpTesting = typeof import("@earendil-works/pi-mcp/testing");

let piMcp: Promise<PiMcp> | undefined;

/** Loads pi-mcp on first use, or says exactly what to install. */
function loadPiMcp(): Promise<PiMcp> {
  piMcp ??= import("@earendil-works/pi-mcp").catch((error: unknown) => {
    piMcp = undefined;
    throw notInstalled(error);
  });
  return piMcp;
}

async function loadPiMcpTesting(): Promise<PiMcpTesting> {
  try {
    return await import("@earendil-works/pi-mcp/testing");
  } catch (error) {
    throw notInstalled(error);
  }
}

function notInstalled(cause: unknown): Error {
  return new Error(
    `MCP tools need ${PI_MCP_PACKAGE} ${PI_MCP_VERSION}, which could not be loaded; install it beside @officehum/sdk: npm install --save-exact ${PI_MCP_PACKAGE}@${PI_MCP_VERSION}`,
    { cause },
  );
}

/**
 * Builds one Pi Durable tool for each tool the manifest declares with `mcp`. A tool the server offers
 * that the manifest does not declare is never built, so the model cannot see it.
 */
export function mcpTools(manifest: AgentManifest, clients: McpClients = {}): ToolRegistration[] {
  return manifest.tools.flatMap((tool) =>
    tool.mcp === undefined ? [] : [mcpTool(tool, tool.mcp, clients[tool.mcp.server])],
  );
}

function mcpTool(
  tool: ToolDeclaration,
  source: NonNullable<ToolDeclaration["mcp"]>,
  client: McpToolClient | undefined,
): ToolRegistration {
  const details: JsonObject = { server: source.server, tool: source.tool };
  return defineTool({
    name: tool.name,
    description: declaredDescription(tool),
    parameters: declaredParameters(tool),
    replay: tool.replay,
    execute: async (args, api, context) => {
      if (client === undefined) {
        return {
          isError: true,
          output: [{ type: "text", text: notConnectedText(tool.name, source.server) }],
          details: { ...details, connected: false },
        };
      }
      let toLlmContent: PiMcp["toLlmContent"];
      try {
        ({ toLlmContent } = await loadPiMcp());
      } catch (error) {
        return { isError: true, output: [{ type: "text", text: message(error) }], details };
      }
      const sent = declaredArguments(tool.parameters ?? {}, args as Record<string, unknown>);
      // The call's durable identity: the same when Pi Durable runs the call again, so a server that
      // honours the key does the work once.
      if (source.idempotencyArg !== undefined)
        sent[source.idempotencyArg] = `${String(api.conversationId)}:${api.callId}`;
      let result: McpCallResult;
      try {
        result = await client.callTool(
          source.tool,
          sent,
          context.abortSignal === undefined ? {} : { signal: context.abortSignal },
        );
      } catch (error) {
        // A cancelled call (the harness closing, a crash) is not the server's answer: let Pi Durable
        // see the cancellation, so it recovers the call by its replay policy.
        if (context.abortSignal?.aborted === true) throw error;
        // A server's JSON-RPC error message is its text too, so it is framed like its output.
        return {
          isError: true,
          output: framedOutput(tool.name, source, [
            { type: "text", text: `The call failed: ${message(error)}` },
          ]),
          details,
        };
      }
      return {
        output: framedOutput(
          tool.name,
          source,
          toLlmContent(result as Parameters<PiMcp["toLlmContent"]>[0]),
        ),
        ...(result.isError === true ? { isError: true } : {}),
        details,
      };
    },
  }) as unknown as ToolRegistration;
}

/** Only the parameters the manifest declares reach the server; anything else the model sent is dropped. */
function declaredArguments(
  parameters: Readonly<Record<string, ParameterDeclaration>>,
  args: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const sent: Record<string, unknown> = {};
  for (const name of Object.keys(parameters)) {
    if (args[name] !== undefined) sent[name] = args[name];
  }
  return sent;
}

/** The answer a declared tool gives when the host connected no client for its server. */
export function notConnectedText(tool: string, server: string): string {
  return `${tool} is not available: the MCP server ${show(server)} is not connected, so nothing was done. (For the host: pass mcp: { ${show(server)}: client } to the role, with a client from ${PI_MCP_PACKAGE} ${PI_MCP_VERSION} that you connected.)`;
}

/**
 * An MCP result as the model reads it: inside the fixed frame every outside program's output gets
 * (design section 8), naming the server and its tool.
 */
export function framedOutput(
  tool: string,
  source: { readonly server: string; readonly tool: string },
  content: readonly LlmBlock[],
): LlmBlock[] {
  return frameOutsideOutput(
    {
      tool,
      origin: `the MCP server ${show(source.server)} (its tool ${show(source.tool)})`,
      tag: "mcp-output",
    },
    content,
  );
}

/** What `checkMcpDrift` found. */
export interface McpDrift {
  /** Each one keeps the role from going live (design section 5). */
  readonly issues: readonly Issue[];
  /** Tools the server offers that the manifest does not declare: never shown to the model. */
  readonly hidden: readonly string[];
}

/**
 * Compares a server's `tools/list` with what the manifest declares for that server (design section
 * 5). A declared tool the server lacks, a declared parameter (or idempotency argument) its schema
 * lacks, a parameter it requires that the manifest does not declare, and a declared parameter whose
 * type differs are issues. Tools it offers that the manifest does not declare are `hidden`. Server
 * annotations are never consulted.
 */
export async function checkMcpDrift(
  manifest: AgentManifest,
  serverId: string,
  client: McpToolClient,
): Promise<McpDrift> {
  const offered = await client.listTools();
  const byName = new Map(offered.map((tool) => [tool.name, tool]));
  const issues: Issue[] = [];
  const add = (path: string, text: string) =>
    issues.push({ source: MANIFEST_FILE, path, message: text });
  const declared = new Set<string>();

  manifest.tools.forEach((tool, index) => {
    if (tool.mcp?.server !== serverId) return;
    declared.add(tool.mcp.tool);
    const at = `tools[${index}]`;
    const server = byName.get(tool.mcp.tool);
    if (server === undefined) {
      add(
        `${at}.mcp.tool`,
        `${show(tool.name)} calls ${show(tool.mcp.tool)}, which the MCP server ${show(serverId)} does not offer`,
      );
      return;
    }
    const schema = server.inputSchema;
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === "string")
      : [];
    const parameters = tool.parameters ?? {};

    for (const [name, parameter] of Object.entries(parameters)) {
      const property = properties[name];
      if (property === undefined) {
        add(
          `${at}.parameters.${name}`,
          `the MCP server ${show(serverId)}'s ${show(tool.mcp.tool)} takes no argument ${show(name)}`,
        );
      } else if (!typeMatches(parameter.type, isRecord(property) ? property.type : undefined)) {
        add(
          `${at}.parameters.${name}.type`,
          `is ${show(parameter.type)}, but the MCP server ${show(serverId)}'s ${show(tool.mcp.tool)} takes ${show((property as { type?: unknown }).type)}`,
        );
      }
    }
    const key = tool.mcp.idempotencyArg;
    if (key !== undefined && properties[key] === undefined) {
      add(
        `${at}.mcp.idempotencyArg`,
        `the MCP server ${show(serverId)}'s ${show(tool.mcp.tool)} takes no argument ${show(key)}`,
      );
    }
    for (const name of required) {
      if (Object.hasOwn(parameters, name) || name === key) continue;
      add(
        `${at}.parameters`,
        `the MCP server ${show(serverId)}'s ${show(tool.mcp.tool)} requires ${show(name)}, which is not declared`,
      );
    }
  });

  const hidden = offered.map((tool) => tool.name).filter((name) => !declared.has(name));
  return { issues, hidden };
}

/** A declared type fits a server's JSON Schema type; an integer fits a number. No type: anything. */
function typeMatches(declared: ParameterDeclaration["type"], server: unknown): boolean {
  if (server === undefined) return true;
  const types = Array.isArray(server) ? server : [server];
  return types.some((type) => type === declared || (declared === "integer" && type === "number"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One tool of a `stubMcp` server, and how it answers. */
export interface StubMcpTool {
  readonly name: string;
  readonly description?: string;
  /** Default `{ "type": "object" }`. */
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  readonly annotations?: Readonly<Record<string, unknown>>;
  /**
   * The answer: a string (one text block), a full result, or a function of the arguments. A function
   * that throws answers with a JSON-RPC error. Omitted: `"ok: <name>"`.
   */
  readonly call?:
    | string
    | McpCallResult
    | ((
        args: Readonly<Record<string, unknown>>,
      ) => string | McpCallResult | Promise<string | McpCallResult>);
}

/** A client connected to a `stubMcp` server, with every call the server received. */
export interface StubMcpClient extends McpToolClient {
  readonly calls: readonly { readonly tool: string; readonly args: Record<string, unknown> }[];
  close(): Promise<void>;
}

/**
 * A real pi-mcp `McpClient`, connected over pi-mcp's in-memory transport to a small in-process server
 * that offers `tools`: for tests and evals, with no process and no network. A call of a tool the
 * server does not offer answers `isError: true`, as a real server does.
 */
export async function stubMcp(tools: readonly StubMcpTool[]): Promise<StubMcpClient> {
  const { McpClient } = await loadPiMcp();
  const { createInMemoryTransportPair } = await loadPiMcpTesting();
  const { client: clientEnd, server } = createInMemoryTransportPair();
  const calls: { tool: string; args: Record<string, unknown> }[] = [];

  server.onMessage((incoming) => {
    if (!("id" in incoming) || !("method" in incoming)) return;
    const reply = (result: unknown) =>
      server.send({ jsonrpc: "2.0", id: incoming.id, result } as never);
    const params = (incoming.params ?? {}) as Record<string, unknown>;
    switch (incoming.method) {
      case "initialize":
        void reply({
          protocolVersion: params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "officehum-stub-mcp", version: "0.0.0" },
        });
        return;
      case "ping":
        void reply({});
        return;
      case "tools/list":
        void reply({
          tools: tools.map(({ call: _call, ...tool }) => ({
            ...tool,
            inputSchema: tool.inputSchema ?? { type: "object" },
          })),
        });
        return;
      case "tools/call": {
        const name = String(params.name);
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        calls.push({ tool: name, args });
        const tool = tools.find((candidate) => candidate.name === name);
        if (tool === undefined) {
          void reply({ content: [{ type: "text", text: `unknown tool ${name}` }], isError: true });
          return;
        }
        void answer(tool, args).then(reply, (error: unknown) =>
          server.send({
            jsonrpc: "2.0",
            id: incoming.id,
            error: { code: -32603, message: message(error) },
          } as never),
        );
        return;
      }
      default:
        void server.send({
          jsonrpc: "2.0",
          id: incoming.id,
          error: { code: -32601, message: `method not found: ${incoming.method}` },
        } as never);
    }
  });
  await server.start();

  const client = new McpClient({ name: "officehum-stub", version: "0.0.0" });
  await client.connect(clientEnd);
  return Object.assign(client, { calls }) as unknown as StubMcpClient;
}

async function answer(
  tool: StubMcpTool,
  args: Readonly<Record<string, unknown>>,
): Promise<McpCallResult> {
  const call = tool.call ?? `ok: ${tool.name}`;
  const value = typeof call === "function" ? await call(args) : call;
  return typeof value === "string" ? { content: [{ type: "text", text: value }] } : value;
}
