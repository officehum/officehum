/**
 * `officehum runtime --db FILE --office FILE`: one office's harness behind the Gateway Protocol on
 * stdin/stdout. The gateway supervises it; it can also be run directly for development, by typing
 * protocol frames (one JSON object per line) at it.
 *
 * stdout carries protocol frames only. Everything for a person (what loaded, failures) goes to stderr
 * through `io.error`; `io.output` is never used here.
 */

import type { Readable, Writable } from "node:stream";
import type { ModelRef } from "@earendil-works/pi-durable";
import {
  approvalTimeoutsMs,
  loadOfficeRoles,
  RemoteApprovals,
  readOfficeFile,
  serveRuntime,
} from "@officehum/office";
import type { CliDependencies, CliIo } from "./cli.js";
import { modelsFor, parseModelRef } from "./run.js";
import { UsageError } from "./usage-error.js";

export const RUNTIME_USAGE =
  "officehum runtime --db FILE --office FILE [--model provider/model] [--demo]";

export interface RuntimeArguments {
  readonly database: string;
  readonly officeFile: string;
  readonly model?: string;
  readonly demo: boolean;
}

export function parseRuntimeArguments(args: readonly string[]): RuntimeArguments {
  let database: string | undefined;
  let officeFile: string | undefined;
  let model: string | undefined;
  let demo = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--demo") {
      demo = true;
      continue;
    }
    const value = args[index + 1];
    if (flag !== "--db" && flag !== "--office" && flag !== "--model") {
      throw new UsageError(`Unknown runtime option: ${flag}\nUsage: ${RUNTIME_USAGE}`);
    }
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`${flag} needs a value.\nUsage: ${RUNTIME_USAGE}`);
    }
    index++;
    if (flag === "--db") database = value;
    else if (flag === "--office") officeFile = value;
    else model = value;
  }
  if (database === undefined || officeFile === undefined) {
    throw new UsageError(`The runtime needs --db and --office.\nUsage: ${RUNTIME_USAGE}`);
  }
  return { database, officeFile, demo, ...(model === undefined ? {} : { model }) };
}

/** The streams the runtime speaks on; tests inject their own. */
export interface RuntimeStdio {
  readonly input: Readable;
  readonly output: Writable;
}

export async function runRuntimeCommand(
  args: readonly string[],
  io: CliIo,
  dependencies: CliDependencies,
  register: (session: { close(): Promise<void> }) => () => void,
): Promise<number> {
  const parsed = parseRuntimeArguments(args);
  const override = parsed.model === undefined ? undefined : parseModelRef(parsed.model);
  const file = await readOfficeFile(parsed.officeFile);
  // Every role's gate asks the runtime's remote approvals, which the gateway's approvers answer.
  const approvals = new RemoteApprovals();
  const roles = await loadOfficeRoles(file, {
    approve: approvals.approve,
    ...(parsed.demo ? { demo: true } : {}),
  });
  const refs: ModelRef[] =
    override === undefined
      ? roles.map((role) => ({
          provider: role.manifest.defaultModel.provider,
          modelId: role.manifest.defaultModel.modelId,
        }))
      : [override];
  const models = modelsFor(refs, dependencies, "runtime");

  for (const [index, role] of roles.entries()) {
    const ref = refs[index] ?? refs[0];
    io.error(`Agent ${role.manifest.id}: ${ref?.provider}/${ref?.modelId}`);
  }
  io.error(
    `Office ${file.id} on ${parsed.database}${parsed.demo ? ", on demonstration data" : ""}`,
  );

  const stop = new AbortController();
  const unregister = register({ close: async () => stop.abort() });
  // An operator or process manager stops a runtime with SIGTERM (the gateway closes stdin instead):
  // close the office cleanly rather than die mid-commit.
  const terminate = () => stop.abort();
  process.once("SIGTERM", terminate);
  try {
    await serveRuntime({
      serverId: file.id,
      roles,
      storage: { sqlite: parsed.database },
      approvals,
      approvalTimeoutsMs: approvalTimeoutsMs(file, roles),
      models,
      ...(override === undefined ? {} : { model: override }),
      input: dependencies.stdio?.input ?? process.stdin,
      output: dependencies.stdio?.output ?? process.stdout,
      signal: stop.signal,
      log: (line) => io.error(line),
    });
  } finally {
    process.removeListener("SIGTERM", terminate);
    unregister();
  }
  return 0;
}
