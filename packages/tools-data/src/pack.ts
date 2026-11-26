/**
 * The data pack's tools, as Pi Durable registrations: `data_inspect`, `data_query`, `data_export` and
 * `chart_render`. All are `replay: "safe"`: each call loads its files into a fresh in-memory DuckDB and
 * reads them, and the one file a call may save is saved under the call's operation ID, so a replay
 * returns the file the first run saved instead of saving another.
 *
 * This module is the pack's light entry (`@officehum/tools-data/pack`): building the pack defines the
 * tools and loads no engine. DuckDB, Vega and resvg are imported the first time a tool runs
 * (`./engine.ts`), so a host that offers the tools, or stubs them in an eval, never loads them.
 */

import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ToolPack } from "@officehum/sdk";
import {
  type DocumentLease,
  type DocumentService,
  type LeaseLookup,
  operationIdForCall,
} from "@officehum/tools-paper-office";
import { DATA_PACK_ID, DATA_TOOLS } from "./definitions.js";
import type { ToolResult } from "./engine.js";
import { DataError } from "./errors.js";
import type { DataFiles } from "./load.js";
import type { DataLimits } from "./sandbox.js";

export {
  CHART_RENDER,
  DATA_EXPORT,
  DATA_INSPECT,
  DATA_PACK_ID,
  DATA_QUERY,
  DATA_TOOLS,
  type DataToolDefinition,
} from "./definitions.js";

export interface DataPackOptions {
  /**
   * The host's view of the file store for this task, or `undefined` when the task may read no files.
   * CSV, Parquet and JSON files are read from it, and results, exports and charts are saved into it.
   */
  readonly filesFor: (lookup: LeaseLookup) => Promise<DataFiles | undefined>;
  /** The task's document lease, which Excel input and `.xlsx` export need. */
  readonly leaseFor?: (lookup: LeaseLookup) => Promise<DocumentLease | undefined>;
  /** The Paper Office service that reads leased workbooks and writes `.xlsx` exports. */
  readonly service?: DocumentService;
  /** Who the store records as having saved a file, e.g. `role:finance-analyst`. */
  readonly createdBy: string;
  /** Lower limits than the defaults (20 s, 512 MB, 50 MB per file, 100,000 rows); never higher. */
  readonly limits?: Partial<DataLimits>;
}

/** The data pack, as a role's `packs` takes it. */
export type DataPack = ToolPack;

export function dataPack(options: DataPackOptions): DataPack {
  return {
    id: DATA_PACK_ID,
    tools: DATA_TOOLS.map(
      (definition) =>
        defineTool({
          name: definition.name,
          description: definition.description,
          parameters: definition.parameters,
          replay: "safe",
          execute: async (args: unknown, api): Promise<ToolResult> => {
            const lookup = {
              taskId: String(api.taskId),
              conversationId: String(api.conversationId),
            };
            const operationId = operationIdForCall({
              conversationId: lookup.conversationId,
              callId: api.callId,
            });
            try {
              if (typeof args !== "object" || args === null) {
                throw new DataError("invalid-request", "the arguments must be a JSON object");
              }
              // The engine, and DuckDB, Vega and resvg with it, load at the first call, not before.
              const { runDataTool } = await import("./engine.js");
              return await runDataTool(definition.name, options, args as Record<string, unknown>, {
                lookup,
                operationId,
              });
            } catch (error) {
              if (error instanceof DataError) {
                return {
                  output: [
                    {
                      type: "text",
                      text: `${definition.name} refused (${error.code}): ${error.message}`,
                    },
                  ],
                  isError: true,
                  details: { code: error.code },
                };
              }
              throw error;
            }
          },
        }) as unknown as ToolRegistration,
    ),
  };
}
