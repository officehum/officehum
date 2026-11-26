/**
 * Sample Labels: a portable role whose one tool runs a command-line program, used to test
 * @officehum/sdk. The tool is declared in officehum.json and built by defineRole, which runs the
 * declared program once per call: no shell, an empty temporary directory, and an environment of PATH
 * plus the variables the manifest names. The program here is the fixture's own `cli/fake-cli.mjs`.
 */

import { fileURLToPath } from "node:url";
import { type Approver, type DefinedRole, defineRole } from "../../../src/index.js";
import manifest from "../officehum.json" with { type: "json" };

export const packageDir = fileURLToPath(new URL("..", import.meta.url));

export interface SampleLabelsOptions {
  readonly overlays?: readonly string[];
  /** Decides release and security labels. Omitted: they are blocked. */
  readonly approve?: Approver;
  /** A manifest to use instead of the package's own, for tests that vary it. */
  readonly manifest?: unknown;
}

export default function sampleLabels(options: SampleLabelsOptions = {}): DefinedRole {
  return defineRole({
    packageDir,
    manifest: options.manifest ?? manifest,
    overlays: options.overlays,
    approve: options.approve,
  });
}
