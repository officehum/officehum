/**
 * Sample Stockroom: an engine-backed portable role, used to test @officehum/sdk. Its tools are
 * declared in officehum.json and built by defineRole around the engine the host passes in.
 *
 *   const role = sampleStockroom({
 *     engine: engineFromManifest(packageDir, manifest, { dataDir, workDir }),
 *   });
 */

import { fileURLToPath } from "node:url";
import { type Approver, type DefinedRole, defineRole, type Engine } from "../../../src/index.js";
import manifest from "../officehum.json" with { type: "json" };

export const packageDir = fileURLToPath(new URL("..", import.meta.url));

export interface SampleStockroomOptions {
  readonly engine: Engine;
  readonly overlays?: readonly string[];
  readonly approve?: Approver;
}

export default function sampleStockroom(options: SampleStockroomOptions): DefinedRole {
  return defineRole({
    packageDir,
    manifest,
    engine: options.engine,
    overlays: options.overlays,
    approve: options.approve,
  });
}
