/**
 * Tool packs: tools a role declares in its manifest with `"pack"` and its office supplies.
 *
 * A pack is a set of tool registrations under an id, such as the data pack's `data_inspect`,
 * `data_query`, `data_export` and `chart_render`. Its code can be heavy (the data pack's query engine
 * is tens of megabytes), so a role package never depends on it: the host builds the pack and hands
 * it to the role's factory as `packs`, which passes it on to `defineRole`. The role offers the pack's
 * tools it declares, and only those; without the pack it offers none of them and loads as before.
 */

import type { ToolRegistration } from "@earendil-works/pi-durable";
import { type Issue, show } from "./issues.js";
import type { AgentManifest } from "./manifest.js";

/** A set of tools a host supplies under one id, e.g. `{ id: "data", tools: [...] }`. */
export interface ToolPack {
  readonly id: string;
  readonly tools: readonly ToolRegistration[];
}

/** The ids of the packs a manifest's tools come from, in the order they are first declared. */
export function declaredPacks(manifest: Pick<AgentManifest, "tools">): string[] {
  return [
    ...new Set(manifest.tools.flatMap((tool) => (tool.pack === undefined ? [] : [tool.pack]))),
  ];
}

/**
 * The pack tools a role offers: for each tool the manifest declares from a pack it was given, that
 * pack's registration. A tool from a pack it was not given is left out. Problems are a pack given
 * twice and a declared tool the given pack does not have.
 */
export function packTools(
  manifest: Pick<AgentManifest, "tools">,
  packs: readonly ToolPack[],
): { readonly tools: ToolRegistration[]; readonly issues: Issue[] } {
  const issues: Issue[] = [];
  const byId = new Map<string, ToolPack>();
  for (const pack of packs) {
    if (byId.has(pack.id)) {
      issues.push({
        source: "role",
        path: "packs",
        message: `the pack ${show(pack.id)} is given more than once`,
      });
    }
    byId.set(pack.id, pack);
  }
  const tools: ToolRegistration[] = [];
  manifest.tools.forEach((declared, index) => {
    if (declared.pack === undefined) return;
    const pack = byId.get(declared.pack);
    if (pack === undefined) return;
    const tool = pack.tools.find((candidate) => candidate.name === declared.name);
    if (tool === undefined) {
      issues.push({
        source: "role",
        path: `tools[${index}].pack`,
        message: `the ${declared.pack} pack has no tool ${show(declared.name)}; it has ${pack.tools.map((candidate) => show(candidate.name)).join(", ")}`,
      });
      return;
    }
    tools.push(tool);
  });
  return { tools, issues };
}
