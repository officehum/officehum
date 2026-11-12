/**
 * `generateRole`: compile one `ROLE_SPEC.md` into a complete Pi Durable role package, with no hand
 * edits afterwards. The spec is the document a person reviews (docs/design/role-spec.md); this module
 * is everything the generator writes from it, and the rules that make the output trustworthy:
 *
 * - **A layer becomes files or manifest data.** Context is `AGENTS.md` and `APPEND_SYSTEM.md`,
 *   knowledge is `skills/`, wisdom and workflow are `officehum.json`, and the spec's scenarios are
 *   `evals/spec.json`. The only code written is `src/index.ts` (the factory, and a typed
 *   not-implemented stub for a tool with no engine, cli or mcp source) and `src/role.test.ts`. No
 *   guardrail is ever generated TypeScript: approvals, limits and replay policy are manifest fields
 *   the SDK enforces.
 * - **The output is checked before it is written.** The merged manifest goes through
 *   `validateManifest`, the spec's scenarios and the generated ones through `validateSuite` together
 *   (so a duplicate id or an unknown approval is caught here), and the package's files through
 *   `checkFourLayers` in strict mode, in a scratch directory. Any of the three failing, or an overlay
 *   that cannot be written, refuses the run, lists what is wrong and leaves both directories alone.
 * - **Deterministic.** The same spec writes byte-identical files: the builders are pure, key order is
 *   the spec's own, and nothing reads a clock, an environment variable or a random source. Generating
 *   twice is a diff that comes back empty, which is what lets a reviewer read a regeneration instead
 *   of the whole package.
 * - **It never overwrites.** An existing, non-empty `outDir` is refused — this is not an in-place
 *   editor — and so is any file already at a path it would write, in the package or in an overlay. A
 *   regeneration goes into a fresh directory; the diff is the empty thing above.
 *
 * See docs/design/role-spec.md, "What the generator writes".
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
  type AgentManifest,
  checkFourLayers,
  formatIssue,
  type Issue,
  MANIFEST_FILE,
  ROLE_FILES,
  validateManifest,
  validateSuite,
} from "@officehum/sdk";
import {
  agentsMd,
  appendSystemMd,
  GENERATED_EVALS_FILE,
  generatedEvalsJson,
  generatedScenarios,
  indexTs,
  json,
  overlayFiles as overlayOf,
  packageJson,
  readmeMd,
  roleTestTs,
  SPEC_EVALS_FILE,
  skillFiles,
  specEvalsJson,
} from "./render.js";
import { EVALS_DIR, manifestFromRoleSpec, ROLE_SPEC_FILE, type RoleSpec } from "./spec.js";

/** The role's own test, which the generated package runs the way every other role package does. */
const ROLE_TEST_FILE = "src/role.test.ts";

export interface GenerateRoleOptions {
  /**
   * One business's overlay directory. The spec's `business` block is written there — its `AGENTS.md`
   * additions and its `settings.json` — and never into the package, so the package stays the same one
   * every business installs.
   */
  readonly overlayDir?: string;
}

/** What a run wrote: the package's files, and the overlay's, relative to each directory. */
export interface GeneratedRole {
  readonly dir: string;
  /** Every file written, relative to the package root, sorted. */
  readonly files: readonly string[];
  /** Every overlay file written, relative to the overlay; empty when no overlay was written. */
  readonly overlayFiles: readonly string[];
  readonly overlayDir?: string;
}

/** Thrown when a spec cannot be written as a package, with every issue that stopped it. */
export class RoleGenerationError extends Error {
  readonly issues: readonly Issue[];

  constructor(issues: readonly Issue[]) {
    super(
      `The role cannot be generated:\n${issues.map((issue) => `  ${formatIssue(issue)}`).join("\n")}`,
    );
    this.name = "RoleGenerationError";
    this.issues = issues;
  }
}

/**
 * Writes the complete package for `spec` into `outDir`: the prompt files, the skills and their
 * references, the merged manifest, `package.json`, the README, the entry point and its test, and the
 * evals. Throws `RoleGenerationError` when the spec does not survive the checks, and lists every
 * problem it found; nothing is written to `outDir` or the overlay unless every check passes.
 */
export function generateRole(
  spec: RoleSpec,
  outDir: string,
  options: GenerateRoleOptions = {},
): GeneratedRole {
  const manifest = manifestFromRoleSpec(spec);
  const merged = validateManifest(manifest);
  if (!merged.ok) throw new RoleGenerationError(merged.issues);

  // The spec's scenarios and the generated ones are checked together: an id used twice in one
  // package, an approval that is not declared, a tool that is not stubbed, or a ticket type this role
  // does not accept is refused here rather than by the first host that runs the evals.
  const suite = validateSuite(
    { scenarios: [...spec.evals, ...generatedScenarios(spec)] },
    manifest,
    `${EVALS_DIR}/${GENERATED_EVALS_FILE}`,
  );
  if (!suite.ok) throw new RoleGenerationError(suite.issues);

  // Everything that can refuse the run does so here, before either directory is touched: a package
  // is generated into a fresh directory, never edited, and an overlay only where nothing is.
  const packaged = packageFiles(spec, manifest);
  const overlay = options.overlayDir === undefined ? undefined : businessOverlay(spec);
  assertWritableOutDir(outDir);
  assertWritableWithin(outDir, Object.keys(packaged));
  if (options.overlayDir !== undefined && overlay !== undefined) {
    assertWritableWithin(options.overlayDir, Object.keys(overlay));
  }
  const layers = fourLayerIssues(packaged, manifest);
  if (layers.length > 0) throw new RoleGenerationError(layers);

  const files = writeAll(outDir, packaged);
  const writtenOverlay =
    options.overlayDir === undefined || overlay === undefined
      ? []
      : writeAll(options.overlayDir, overlay);

  return {
    dir: outDir,
    files,
    overlayFiles: writtenOverlay,
    ...(options.overlayDir === undefined ? {} : { overlayDir: options.overlayDir }),
  };
}

/**
 * Every file of the package, by path relative to its root. This is the whole of a generated role: the
 * list is fixed, so a reviewer knows what to read, and the merge into `officehum.json` is the only
 * place a spec field changes shape.
 */
export function packageFiles(spec: RoleSpec, manifest: AgentManifest): Record<string, string> {
  return {
    [ROLE_FILES.agents]: agentsMd(spec),
    [ROLE_FILES.appendSystem]: appendSystemMd(spec),
    [MANIFEST_FILE]: json(manifest),
    "package.json": packageJson(spec),
    "README.md": readmeMd(spec),
    "src/index.ts": indexTs(spec),
    [ROLE_TEST_FILE]: roleTestTs(spec),
    [`${EVALS_DIR}/${SPEC_EVALS_FILE}`]: specEvalsJson(spec),
    [`${EVALS_DIR}/${GENERATED_EVALS_FILE}`]: generatedEvalsJson(spec),
    ...skillFiles(spec),
  };
}

/** The business's overlay, refused when the spec has one but nothing to write into it. */
function businessOverlay(spec: RoleSpec): Record<string, string> {
  const files = overlayOf(spec);
  if (Object.keys(files).length === 0) {
    throw new RoleGenerationError([
      {
        source: ROLE_SPEC_FILE,
        path: "business",
        message:
          "has nothing to write: an overlay carries the business's agents_md additions and its settings, and this spec declares neither",
      },
    ]);
  }
  return files;
}

/**
 * A package is written into an empty directory. An existing, non-empty `outDir` is refused rather than
 * merged into: the generator is not an in-place editor, and the output being byte-identical means a
 * regeneration belongs in a fresh directory, where the diff shows exactly what the spec change did.
 */
function assertWritableOutDir(outDir: string): void {
  if (!existsSync(outDir)) return;
  if (!statSync(outDir).isDirectory()) {
    throw new RoleGenerationError([{ source: outDir, path: "", message: "is not a directory" }]);
  }
  const entries = readdirSync(outDir);
  if (entries.length > 0) {
    throw new RoleGenerationError([
      {
        source: outDir,
        path: "",
        message: `is not empty (${entries.length} entries): the generator writes a new package into an empty directory, it does not edit one in place — regenerate into a fresh directory and diff it`,
      },
    ]);
  }
}

/**
 * The strict four-layer check on the package's files. The check reads a package directory, so the
 * files go into a scratch one that is removed again: the role's own directory is written only once
 * this has passed.
 */
function fourLayerIssues(files: Record<string, string>, manifest: AgentManifest): readonly Issue[] {
  const scratch = mkdtempSync(join(tmpdir(), "officehum-role-check-"));
  try {
    writeAll(scratch, files);
    return checkFourLayers(scratch, manifest, { strict: true });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Every path stays below `root` and names no file that is already there. Both are the generator's
 * promise that it overwrites nothing a person did not ask it to write, and every problem is reported.
 */
function assertWritableWithin(root: string, paths: readonly string[]): void {
  const base = resolve(root);
  const issues: Issue[] = [];
  for (const path of [...paths].sort()) {
    const target = resolve(base, path);
    if (target !== base && !target.startsWith(`${base}${sep}`)) {
      issues.push({
        source: path,
        path: "",
        message: `would be written outside ${base}; the generator writes only below the directory it was given`,
      });
    } else if (existsSync(target)) {
      issues.push({
        source: join(root, path),
        path: "",
        message: "already exists; the generator never overwrites a file it did not just write",
      });
    }
  }
  if (issues.length > 0) throw new RoleGenerationError(issues);
}

/**
 * Writes every file below `root`, in sorted path order, and returns the paths it wrote. The paths
 * have been through `assertWritableWithin` by now.
 */
function writeAll(root: string, files: Record<string, string>): string[] {
  const paths = Object.keys(files).sort();
  for (const path of paths) {
    const target = resolve(root, path);
    mkdirSync(dirname(target), { recursive: true });
    // `wx`: a file that appeared since the check is still never overwritten.
    writeFileSync(target, files[path] ?? "", { flag: "wx" });
  }
  return paths;
}
