/** The manifest's MCP declarations and their rules (docs/design/tool-sources.md, sections 2 and 4). */
import { describe, expect, it } from "vitest";
import ticketsManifest from "../fixtures/sample-tickets/officehum.json" with { type: "json" };
import { formatIssue } from "./issues.js";
import { validateManifest } from "./manifest.js";

type Json = Record<string, unknown>;
const base = (): Json => structuredClone(ticketsManifest) as unknown as Json;
const tool = (): Json => structuredClone(ticketsManifest.tools[0]) as unknown as Json;

/** The fixture manifest with one tool and some fields replaced. */
function manifestWith(fields: Json = {}, toolFields: Json = {}): Json {
  return { ...base(), tools: [{ ...tool(), ...toolFields }], ...fields };
}

/** Stands in for the fixture's approval when a test drops it to isolate another rule. */
const NOTED = { noApproval: "test only: isolates another rule" };

/** The fixture's one server with its command replaced. */
const serverWith = (command: string[], extra: Json = {}) => ({
  mcpServers: { tickets: { transport: "stdio", command, ...extra } },
});

const messages = (value: unknown) => {
  const result = validateManifest(value);
  return result.ok ? [] : result.issues.map(formatIssue);
};

describe("MCP declarations in officehum.json", () => {
  it("accepts the Sample Tickets manifest", () => {
    expect(messages(base())).toEqual([]);
  });

  it("requires an MCP tool to state its description and parameters", () => {
    const { description: _description, parameters: _parameters, ...bare } = tool();
    // The approval names `priority`, which this tool no longer declares; drop it to isolate the rule.
    expect(messages({ ...base(), tools: [{ ...bare, ...NOTED }], approvals: [] })).toEqual([
      "officehum.json › tools[0].description: is required for an MCP tool: the model reads the manifest's description, never the server's",
      "officehum.json › tools[0].parameters: are required for an MCP tool, even when empty (\"parameters\": {}): the model reads the manifest's parameters, never the server's",
    ]);
  });

  it("accepts an MCP tool that declares no parameters as an empty object", () => {
    expect(messages(manifestWith({ approvals: [] }, { parameters: {}, ...NOTED }))).toEqual([]);
  });

  it("refuses a tool whose server is not declared", () => {
    expect(
      messages(manifestWith({}, { mcp: { server: "tracker", tool: "create_ticket" } })),
    ).toEqual(['officehum.json › tools[0].mcp.server: "tracker" is not declared in mcpServers']);
  });

  it("refuses a tool that states two sources", () => {
    const engine = { command: ["node", "engine.mjs"] };
    expect(messages(manifestWith({ engine }, { engine: ["create"] }))).toEqual([
      'officehum.json › tools[0]: "create_ticket" states 2 sources, engine and mcp; a tool comes from exactly one (engine, mcp, cli, pack, or code with none)',
    ]);
  });

  it.each([
    ["a bare name", ["npx", "-y", "@vendor/tickets-mcp"], '"@vendor/tickets-mcp"'],
    ["a range", ["npx", "-y", "@vendor/tickets-mcp@^1.4.2"], '"@vendor/tickets-mcp@^1.4.2"'],
    ["a tag", ["npx", "-y", "@vendor/tickets-mcp@latest"], '"@vendor/tickets-mcp@latest"'],
    ["a partial version", ["npx", "tickets-mcp@1.4"], '"tickets-mcp@1.4"'],
    ["no package at all", ["npx", "-y"], "null"],
    ["a --package range", ["npx", "--package=tickets-mcp@1.x", "tickets"], '"tickets-mcp@1.x"'],
  ])("refuses an npx server named with %s", (_label, command, got) => {
    expect(messages(manifestWith(serverWith(command)))).toEqual([
      `officehum.json › mcpServers.tickets.command: npx must name its package with an exact version, like "@vendor/tickets-mcp@1.4.2" (got ${got}); a bare name, a range or a tag runs a different program whenever the cache expires`,
    ]);
  });

  it.each([
    ["a scoped package", ["npx", "-y", "@vendor/tickets-mcp@1.4.2"]],
    ["an unscoped package", ["npx", "tickets-mcp@1.4.2", "--stdio"]],
    ["-p", ["npx", "-p", "@vendor/tickets-mcp@1.4.2", "tickets"]],
  ])("accepts an npx server pinned exactly, with %s", (_label, command) => {
    expect(messages(manifestWith(serverWith(command)))).toEqual([]);
  });

  it("refuses an unpinned uvx server and accepts a pinned one", () => {
    const python = { runtimes: [{ name: "python3", version: ">=3.10" }] };
    expect(messages(manifestWith({ ...python, ...serverWith(["uvx", "tickets-mcp"]) }))).toEqual([
      'officehum.json › mcpServers.tickets.command: uvx must name its package with an exact version, like "tickets-mcp==1.4.2" (got "tickets-mcp"); a bare name, a range or a tag runs a different program whenever the cache expires',
    ]);
    expect(
      messages(manifestWith({ ...python, ...serverWith(["uvx", "tickets-mcp>=1.4"]) })),
    ).toHaveLength(1);
    expect(
      messages(manifestWith({ ...python, ...serverWith(["uvx", "tickets-mcp==1.4.2"]) })),
    ).toEqual([]);
    expect(
      messages(
        manifestWith({ ...python, ...serverWith(["uvx", "--from", "tickets-mcp@2.0.0rc1", "t"]) }),
      ),
    ).toEqual([]);
  });

  it("requires the server's program in runtimes", () => {
    expect(messages(manifestWith({ runtimes: [] }))).toEqual([
      'officehum.json › mcpServers.tickets.command[0]: "node" needs "node" declared in runtimes, e.g. { "name": "node", "version": ">=22" }, so hosts know to provide it',
    ]);
    // npx runs on node and uvx on python3, so those are the runtimes they need.
    expect(
      messages(manifestWith({ runtimes: [], ...serverWith(["npx", "tickets-mcp@1.4.2"]) })),
    ).toEqual([
      'officehum.json › mcpServers.tickets.command[0]: "npx" needs "node" declared in runtimes, e.g. { "name": "node", "version": ">=22" }, so hosts know to provide it',
    ]);
    expect(messages(manifestWith(serverWith(["uvx", "tickets-mcp==1.4.2"])))).toEqual([
      'officehum.json › mcpServers.tickets.command[0]: "uvx" needs "python3" declared in runtimes, e.g. { "name": "python3", "version": ">=22" }, so hosts know to provide it',
    ]);
    // A program given by path is the package's own, like an engine's script.
    expect(messages(manifestWith({ runtimes: [], ...serverWith(["./bin/tickets"]) }))).toEqual([]);
  });

  it("refuses a value in env: it holds variable names only", () => {
    const server = serverWith(["node", "server/tickets-server.mjs"], {
      env: ["TICKETS_TOKEN", "TICKETS_URL=https://tickets.example"],
    });
    expect(messages(manifestWith(server))).toEqual([
      'officehum.json › mcpServers.tickets.env[1]: must be the NAME of an environment variable, like "TICKETS_TOKEN", never a value; the host supplies the value',
    ]);
  });

  it("refuses the office's own secret key in env, in any letter case", () => {
    const server = serverWith(["node", "server/tickets-server.mjs"], {
      env: ["TICKETS_TOKEN", "OfficeHum_Secret_Key"],
    });
    expect(messages(manifestWith(server))).toEqual([
      "officehum.json › mcpServers.tickets.env[1]: OfficeHum_Secret_Key is the office's own secret, which no role's program is given",
    ]);
  });

  it("refuses an idempotency argument that is also a declared parameter", () => {
    const mcp = { server: "tickets", tool: "create_ticket", idempotencyArg: "title" };
    expect(messages(manifestWith({}, { mcp }))).toEqual([
      'officehum.json › tools[0].mcp.idempotencyArg: "title" is also a declared parameter; the SDK fills the idempotency key itself, so the model must not be offered it',
    ]);
  });

  it("accepts an http server's shape and refuses a URL that does not parse", () => {
    const http = (url: string) => ({
      mcpServers: { tickets: { transport: "http", url, auth: { connector: "tickets" } } },
    });
    expect(messages(manifestWith(http("https://tickets.example/mcp")))).toEqual([]);
    expect(messages(manifestWith(http("https://")))).toEqual([
      'officehum.json › mcpServers.tickets.url: "https://" is not a URL',
    ]);
  });

  it("refuses an unknown transport and a server named outside kebab-case", () => {
    expect(
      messages(manifestWith({ mcpServers: { tickets: { transport: "ws", url: "wss://x" } } })),
    ).toEqual([
      'officehum.json › mcpServers.tickets: must be { "transport": "stdio", "command": ["program", …], "env": ["NAME", …] } or { "transport": "http", "url": "https://…", "auth": { "connector": "ID" } } (got {"transport":"ws","url":"wss://x"})',
    ]);
    const server = { transport: "stdio", command: ["node", "server/tickets-server.mjs"] };
    expect(
      messages(
        manifestWith(
          { mcpServers: { Tickets: server } },
          {
            mcp: { server: "Tickets", tool: "create_ticket" },
          },
        ),
      ),
    ).toEqual(['officehum.json › mcpServers.Tickets: must be named in kebab-case, like "tickets"']);
  });

  it("lets an MCP parameter keep the server's camelCase name, and refuses a non-identifier", () => {
    const parameters = {
      issueId: { type: "string", description: "The issue", required: true },
      "bad name": { type: "string", description: "Not an identifier" },
    };
    expect(messages(manifestWith({ approvals: [] }, { parameters, ...NOTED }))).toEqual([
      'officehum.json › tools[0].parameters.bad name: must be the server tool\'s argument name, a plain identifier like "title" or "issueId"',
    ]);
  });

  it("checks an approval's condition against an MCP tool's declared parameters", () => {
    const approvals = [
      {
        id: "urgent_ticket",
        tool: "create_ticket",
        description: "Urgent",
        when: [{ arg: "severity", op: "eq", value: "urgent" }],
      },
    ];
    expect(messages(manifestWith({ approvals }))).toEqual([
      'officehum.json › approvals[0].when[0].arg: "severity" is not a parameter of "create_ticket"',
    ]);
  });
});
