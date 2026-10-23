/**
 * The `officehum-role generate` command: the same `generateRole` a host calls, with arguments and
 * exit codes around it. It reads one `ROLE_SPEC.md`, prints every problem the spec has if it cannot be
 * parsed, writes the package, and fails when anything refused the run — so it is safe in a script: a
 * command that exits 0 wrote a package the SDK's checks passed in strict mode.
 *
 * `cli.ts` is the binary and holds no logic; keeping the process out of this file means the command can
 * be run, and its output read, from a test.
 */

import { readFileSync } from "node:fs";
import { formatIssue } from "@officehum/sdk";
import { generateRole, RoleGenerationError } from "./generate.js";
import { parseRoleSpec } from "./spec.js";

export const USAGE = `officehum-role generate <spec.md> <out-dir> [--overlay <dir>]

Compiles one ROLE_SPEC.md into a complete Pi Durable role package: AGENTS.md and APPEND_SYSTEM.md,
skills/ and their references, officehum.json, package.json, README.md, the role's entry point and its
test, and the evals.

  <spec.md>          the ROLE_SPEC.md to compile
  <out-dir>          where the package is written; it must not exist, or must be empty
  --overlay <dir>    write the spec's business block there: AGENTS.md and settings.json

The output is deterministic: the same spec writes byte-identical files, so regenerate into a fresh
directory and diff it. Nothing is overwritten — a non-empty <out-dir>, or a file already at a path the
command would write, is refused.

Exit codes: 0 wrote the package, 1 the spec or the output was refused, 2 the command was malformed.`;

/** Where the command's lines go; a host passes its own, a terminal passes stdout and stderr. */
export interface GenerateIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** Runs one command line and returns its exit code, writing everything through `io`. */
export function runCli(args: readonly string[], io: GenerateIo): number {
  const [command, ...rest] = args;
  if (command === undefined) {
    io.err("officehum-role: needs a command");
    io.err(USAGE);
    return 2;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    io.out(USAGE);
    return 0;
  }
  if (command !== "generate") {
    io.err(`officehum-role: unknown command "${command}"; the only one is "generate"`);
    io.err(USAGE);
    return 2;
  }

  const positional: string[] = [];
  let overlayDir: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] ?? "";
    if (arg === "--overlay") {
      const value = rest[index + 1];
      if (value === undefined) {
        io.err("officehum-role: --overlay needs a directory");
        io.err(USAGE);
        return 2;
      }
      overlayDir = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      io.err(`officehum-role: unknown option "${arg}"`);
      io.err(USAGE);
      return 2;
    }
    positional.push(arg);
  }

  const [specPath, outDir] = positional;
  if (specPath === undefined || outDir === undefined || positional.length > 2) {
    io.err("officehum-role: generate needs a spec file and an output directory");
    io.err(USAGE);
    return 2;
  }

  let text: string;
  try {
    text = readFileSync(specPath, "utf8");
  } catch (error) {
    io.err(
      `officehum-role: cannot read ${specPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  const parsed = parseRoleSpec(text, specPath);
  if (!parsed.ok) {
    io.err(`${specPath} has problems:`);
    for (const issue of parsed.issues) io.err(`  ${formatIssue(issue)}`);
    return 1;
  }

  try {
    const generated = generateRole(
      parsed.value,
      outDir,
      overlayDir === undefined ? {} : { overlayDir },
    );
    io.out(`wrote ${generated.files.length} files to ${generated.dir}`);
    for (const file of generated.files) io.out(`  ${file}`);
    if (generated.overlayDir !== undefined) {
      io.out(`wrote ${generated.overlayFiles.length} overlay files to ${generated.overlayDir}`);
      for (const file of generated.overlayFiles) io.out(`  ${file}`);
    }
    return 0;
  } catch (error) {
    if (error instanceof RoleGenerationError) {
      io.err(error.message);
      return 1;
    }
    throw error;
  }
}
