/**
 * A role package with a pack tool, for tests of how a host gives a role a tool pack: a
 * copy of the SDK's Sample Desk whose manifest also declares `take_note` from a `notes` pack, and the
 * pack. The copy's entry imports the SDK by absolute URL, so it builds from its own changed manifest.
 */

import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import type { ToolPack } from "@officehum/sdk";

const SAMPLE_DESK = fileURLToPath(new URL("../../../sdk/fixtures/sample-desk", import.meta.url));
const SDK_ENTRY = new URL("../../../sdk/src/index.ts", import.meta.url).href;

/** The `notes` pack: one tool, `take_note`, that answers "kept". */
export const notesPack: ToolPack = {
  id: "notes",
  tools: [
    defineTool({
      name: "take_note",
      description: "Keep a note.",
      parameters: obj({ text: str() }),
      replay: "safe",
      execute: async () => ({ output: [{ type: "text" as const, text: "kept" }] }),
    }) as unknown as ToolRegistration,
  ],
};

/** `take_note` from the `notes` pack, as a manifest declares it. */
const TAKE_NOTE = {
  name: "take_note",
  replay: "safe",
  pack: "notes",
  description: "Keeps a note for later.",
};

/**
 * Copies the Sample Desk into a temporary directory (the caller removes it), declaring one more
 * tool: `take_note` from the `notes` pack unless another declaration is given.
 */
export async function packRole(
  tool: Readonly<Record<string, unknown>> = TAKE_NOTE,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "officehum-pack-role-"));
  await cp(SAMPLE_DESK, dir, { recursive: true });
  const manifestFile = join(dir, "officehum.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as { tools: unknown[] };
  manifest.tools.push(tool);
  await writeFile(manifestFile, JSON.stringify(manifest));
  const entry = join(dir, "src", "index.ts");
  await writeFile(
    entry,
    (await readFile(entry, "utf8")).replace('"../../../src/index.js"', JSON.stringify(SDK_ENTRY)),
  );
  return dir;
}
