/**
 * Sample Tickets: a portable role whose one tool comes from an MCP server, used to test
 * @officehum/sdk. The tool is declared in officehum.json and built by defineRole around the client
 * the host passes in. The role never starts the server; whoever runs it connects one.
 *
 *   const role = sampleTickets({ mcp: { tickets: client } }); // an McpClient the caller connected
 */

import { fileURLToPath } from "node:url";
import {
  type Approver,
  type DefinedRole,
  defineRole,
  type McpClients,
} from "../../../src/index.js";
import manifest from "../officehum.json" with { type: "json" };

export const packageDir = fileURLToPath(new URL("..", import.meta.url));

export interface SampleTicketsOptions {
  /** Connected MCP clients by server id. Omitted: create_ticket answers "not connected". */
  readonly mcp?: McpClients;
  readonly overlays?: readonly string[];
  /** Decides urgent tickets. Omitted: they are blocked. */
  readonly approve?: Approver;
}

export default function sampleTickets(options: SampleTicketsOptions = {}): DefinedRole {
  return defineRole({
    packageDir,
    manifest,
    mcp: options.mcp,
    overlays: options.overlays,
    approve: options.approve,
  });
}
