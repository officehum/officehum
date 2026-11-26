/**
 * The tool packs an office gives its roles: tools a role declares in its manifest with
 * `"pack"` and the office supplies. There is one, the data pack (`@officehum/tools-data`): questions
 * over spreadsheets and exports answered by DuckDB, and charts.
 *
 * The data pack is an optional peer of the CLI: its engine is tens of megabytes, so it is imported
 * only when an office file or an eval asks for it, and then only its light entry, which defines the
 * tools and loads the engine at a tool's first call. An eval's pack tools are stubs, so its engine
 * never loads at all.
 */
import type { AgentManifest, ToolPack, VersionedFileStore } from "@officehum/sdk";

/** The packs `officehum eval --pack` and an office file can give a role, by id. */
export const OFFICE_PACKS = ["data"] as const;

type DataPackModule = typeof import("@officehum/tools-data/pack");

/** The data pack's light entry, or an error saying how to install it. */
export async function importDataPack(): Promise<DataPackModule> {
  try {
    return await import("@officehum/tools-data/pack");
  } catch (error) {
    throw new Error(
      `The data pack (@officehum/tools-data) could not be loaded: ${error instanceof Error ? error.message : String(error)}. Install it beside @officehum/cli (npm install @officehum/tools-data), or remove "data" from the office file.`,
      { cause: error },
    );
  }
}

/** Whether a role's manifest declares a tool from the data pack. */
export function declaresDataTools(data: DataPackModule, manifest: AgentManifest): boolean {
  return manifest.tools.some((tool) => tool.pack === data.DATA_PACK_ID);
}

/**
 * The data pack for one role, over the office's file store, recording the role as the author of each
 * file it saves. `files` is undefined in an eval: the tools are stubs there and read nothing.
 */
export function dataPackFor(
  data: DataPackModule,
  manifest: AgentManifest,
  files: VersionedFileStore | undefined,
): ToolPack {
  return data.dataPack({ filesFor: async () => files, createdBy: `role:${manifest.id}` });
}
