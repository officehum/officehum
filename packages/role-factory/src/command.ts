/**
 * The `officehum-role` commands: `generate` compiles a `ROLE_SPEC.md` into a role package, and
 * `interview` asks a person everything a role needs and writes one. Both are the same work a host
 * does — `generateRole` and `runInterview` — with arguments and exit codes around them, so a script
 * can rely on a zero exit meaning the package or the spec was actually written.
 *
 * `cli.ts` is the binary and holds no logic; keeping the process out of this file means the commands
 * can be run, and their output read, from a test.
 */

import { readFileSync } from "node:fs";
import { formatIssue } from "@officehum/sdk";
import { generateRole, RoleGenerationError } from "./generate.js";
import {
  InterviewCancelledError,
  type InterviewIo,
  type InterviewOptions,
  runInterview,
} from "./interview.js";
import { parseRoleSpec } from "./spec.js";

export const USAGE = `officehum-role generate <spec.md> <out-dir> [--overlay <dir>]
officehum-role interview [out.md]

Compiles one ROLE_SPEC.md into a complete Pi Durable role package: AGENTS.md and APPEND_SYSTEM.md,
skills/ and their references, officehum.json, package.json, README.md, the role's entry point and its
test, and the evals.

  <spec.md>          the ROLE_SPEC.md to compile
  <out-dir>          where the package is written; it must not exist, or must be empty
  --overlay <dir>    write the spec's business block there: AGENTS.md and settings.json

The output is deterministic: the same spec writes byte-identical files, so regenerate into a fresh
directory and diff it. Nothing is overwritten — a non-empty <out-dir>, or a file already at a path the
command would write, is refused.

The interview asks a person everything a role needs, in plain language: what it is for, what waits for a
person, its own program and the tools it works through, the work that arrives, its procedures, the views
for whoever runs the office, and a few situations to try it on. It writes one ROLE_SPEC.md, which
generate then compiles. Every answer is checked as it comes and a wrong one is asked again with the
reason; if the answers still do not make a role, it says what is wrong and writes nothing.

  [out.md]           where the spec is written (default ROLE_SPEC.md, in this directory)

Exit codes: 0 wrote the package or the spec, 1 the spec or the output was refused, or the interview could
not produce one, 2 the command was malformed.`;

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
  if (command === "interview") {
    // The interview asks a person questions, so it has no synchronous command line: the binary runs it
    // through `runOfficehumRole`, which hands it a terminal.
    io.err("officehum-role: interview asks a person, so it needs a terminal to ask through");
    io.err(USAGE);
    return 2;
  }
  if (command !== "generate") {
    io.err(
      `officehum-role: unknown command "${command}"; the commands are "generate" and "interview"`,
    );
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

/**
 * Runs `officehum-role interview [out.md]`, asking through `interview`. Exit 0 wrote the spec; exit 1
 * produced none — the interview has already said which answers are still wrong — and exit 2 was a
 * command line it cannot read.
 */
export async function runInterviewCommand(
  args: readonly string[],
  io: GenerateIo,
  interview: InterviewIo,
): Promise<number> {
  const positional: string[] = [];
  for (const arg of args) {
    if (arg === "help" || arg === "--help" || arg === "-h") {
      io.out(USAGE);
      return 0;
    }
    if (arg.startsWith("-")) {
      io.err(`officehum-role: unknown option "${arg}"`);
      io.err(USAGE);
      return 2;
    }
    positional.push(arg);
  }
  const [outPath, ...extra] = positional;
  if (extra.length > 0) {
    io.err("officehum-role: interview writes one file, so it takes one path at most");
    io.err(USAGE);
    return 2;
  }

  const options: InterviewOptions = outPath === undefined ? {} : { outPath };
  try {
    const result = await runInterview(interview, options);
    return result.ok ? 0 : 1;
  } catch (error) {
    if (error instanceof InterviewCancelledError) {
      io.err(`officehum-role: ${error.message}; nothing was written`);
      return 1;
    }
    throw error;
  }
}

/**
 * The whole `officehum-role` command line, as the binary runs it: `generate` is a straight run, and
 * `interview` is the one command that asks a person, so it is handed the terminal `cli.ts` passes in —
 * as a function, so a `generate` run never opens the input stream. The terminal it makes is closed
 * here, whoever created it.
 */
export async function runOfficehumRole(
  args: readonly string[],
  io: GenerateIo,
  terminal: () => InterviewIo,
): Promise<number> {
  const [command, ...rest] = args;
  if (command !== "interview") return runCli(args, io);
  const interview = terminal();
  try {
    return await runInterviewCommand(rest, io, interview);
  } finally {
    interview.close?.();
  }
}
