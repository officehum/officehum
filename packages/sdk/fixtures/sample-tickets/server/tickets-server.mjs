// A tiny stdio MCP server for the SDK's tests: plain Node, no dependencies, no network. It speaks
// newline-delimited JSON-RPC on stdin and stdout, as the MCP stdio transport does, and offers two
// tools: create_ticket (which Sample Tickets declares) and list_tickets (which it does not, so the
// model must never see it). A repeated request_id returns the ticket it already opened.
//
// For the runtime's supervision tests: with TICKETS_LOG set, it appends one JSON line per event to
// that file (its start with its pid and the NAMES of its environment variables, never their values,
// and each request's method and tool), and it never answers a create_ticket titled "Hold this call",
// so a test can kill a process while a call is in flight.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const HOLD = "Hold this call";
const record = (event) => {
  const file = process.env.TICKETS_LOG;
  if (file !== undefined)
    appendFileSync(file, `${JSON.stringify({ pid: process.pid, ...event })}\n`);
};
record({ event: "start", env: Object.keys(process.env).sort() });

const TOOLS = [
  {
    name: "create_ticket",
    description: "Create a ticket (the server's own description, never shown to the model)",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        priority: { type: "string", enum: ["low", "normal", "urgent"] },
        request_id: { type: "string" },
      },
      required: ["title"],
    },
    annotations: { readOnlyHint: true },
  },
  { name: "list_tickets", description: "List tickets", inputSchema: { type: "object" } },
];

const tickets = [];
const byRequest = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function call(name, args) {
  if (name === "list_tickets") {
    return { content: [{ type: "text", text: tickets.map((t) => t.id).join(", ") || "none" }] };
  }
  if (name !== "create_ticket") {
    return { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true };
  }
  if (typeof args.title !== "string" || args.title === "") {
    return { content: [{ type: "text", text: "title is required" }], isError: true };
  }
  const known = args.request_id === undefined ? undefined : byRequest.get(args.request_id);
  if (known !== undefined)
    return { content: [{ type: "text", text: `Opened ticket ${known.id}` }] };
  const ticket = { id: `T-${tickets.length + 1}`, title: args.title };
  tickets.push(ticket);
  if (args.request_id !== undefined) byRequest.set(args.request_id, ticket);
  return { content: [{ type: "text", text: `Opened ticket ${ticket.id}` }] };
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (line.trim() === "") return;
  const message = JSON.parse(line);
  if (message.id === undefined || message.method === undefined) return;
  record({ event: message.method, ...(message.params?.name ? { tool: message.params.name } : {}) });
  const reply = (result) => send({ jsonrpc: "2.0", id: message.id, result });
  switch (message.method) {
    case "initialize":
      reply({
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "sample-tickets-server", version: "1.0.0" },
      });
      break;
    case "ping":
      reply({});
      break;
    case "tools/list":
      reply({ tools: TOOLS });
      break;
    case "tools/call":
      if (message.params.name === "create_ticket" && message.params.arguments?.title === HOLD)
        break;
      reply(call(message.params.name, message.params.arguments ?? {}));
      break;
    default:
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `method not found: ${message.method}` },
      });
  }
});
lines.on("close", () => process.exit(0));
