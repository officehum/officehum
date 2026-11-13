/**
 * `officehum runtime --db FILE --office FILE`: one office's harness behind the Gateway Protocol on
 * stdin/stdout. The gateway supervises it; it can also be run directly for development, by typing
 * protocol frames (one JSON object per line) at it.
 *
 * With `--board FILE` the office has a workboard: the people on the roles' company records are
 * loaded onto it, and the agents hand work to each other through it. Without one, each agent works
 * alone.
 *
 * stdout carries protocol frames only. Everything for a person (what loaded, failures) goes to stderr
 * through `io.error`; `io.output` is never used here.
 */

import { dirname, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { ModelRef } from "@earendil-works/pi-durable";
import {
  approvalTimeoutsMs,
  loadOfficeRoles,
  RemoteApprovals,
  readOfficeCompany,
  readOfficeFile,
  serveRuntime,
} from "@officehum/office";
import { openOfficeBoard } from "@officehum/office/board";
import { localVersionedFileStore } from "@officehum/sdk";
import type { CliDependencies, CliIo } from "./cli.js";
import { openConnections } from "./connections.js";
import { withDocumentTools } from "./documents.js";
import { modelsFor, parseModelRef } from "./run.js";
import { UsageError } from "./usage-error.js";

export const RUNTIME_USAGE =
  "officehum runtime --db FILE --office FILE [--board FILE] [--model provider/model] [--demo]";

interface RuntimeArguments {
  readonly database: string;
  readonly officeFile: string;
  /** The office's workboard file. Omitted: the agents work alone. */
  readonly board?: string;
  readonly model?: string;
  readonly demo: boolean;
}

export function parseRuntimeArguments(args: readonly string[]): RuntimeArguments {
  let database: string | undefined;
  let officeFile: string | undefined;
  let board: string | undefined;
  let model: string | undefined;
  let demo = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--demo") {
      demo = true;
      continue;
    }
    const value = args[index + 1];
    if (flag !== "--db" && flag !== "--office" && flag !== "--board" && flag !== "--model") {
      throw new UsageError(`Unknown runtime option: ${flag}\nUsage: ${RUNTIME_USAGE}`);
    }
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`${flag} needs a value.\nUsage: ${RUNTIME_USAGE}`);
    }
    index++;
    if (flag === "--db") database = value;
    else if (flag === "--office") officeFile = value;
    else if (flag === "--board") board = value;
    else model = value;
  }
  if (database === undefined || officeFile === undefined) {
    throw new UsageError(`The runtime needs --db and --office.\nUsage: ${RUNTIME_USAGE}`);
  }
  if (board !== undefined && resolve(board) === resolve(database)) {
    throw new UsageError(
      `--board and --db must be different files: --db is the harness's store and --board is the workboard (got ${database} for both).`,
    );
  }
  return {
    database,
    officeFile,
    demo,
    ...(board === undefined ? {} : { board }),
    ...(model === undefined ? {} : { model }),
  };
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
  // The outside systems the file names for its roles, opened before any role is built on them.
  const connections = openConnections(file, dependencies.connections);
  let roles: Awaited<ReturnType<typeof loadOfficeRoles>>;
  try {
    roles = await loadOfficeRoles(file, {
      approve: approvals.approve,
      clientsFor: connections.clientsFor,
      ...(parsed.demo ? { demo: true } : {}),
    });
  } catch (error) {
    connections.close();
    throw error;
  }
  // The office's one file store, beside its board (or its database when it has no board): where a
  // role's document tools put a file, and where a ticket reply's attached file is looked up.
  const stateDirectory = dirname(resolve(parsed.board ?? parsed.database));
  const files = localVersionedFileStore(join(stateDirectory, "files"));
  // `approvalTimeoutsMs` reads the roles in the file's order, so the order is kept.
  roles = roles.map((role, index) =>
    withDocumentTools(role, file.roles[index]?.documents, {
      store: files,
      ledgerDir: join(stateDirectory, "document-runs"),
      log: (line) => io.error(line),
      ...(dependencies.documents === undefined ? {} : { dependencies: dependencies.documents }),
    }),
  );
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

  // The board is the host's to open and to close, after the runtime has let go of it.
  const board = parsed.board === undefined ? undefined : openOfficeBoard(parsed.board);
  const stop = new AbortController();
  const unregister = register({ close: async () => stop.abort() });
  // An operator or process manager stops a runtime with SIGTERM (the gateway closes stdin instead):
  // close the office cleanly rather than die mid-commit.
  const terminate = () => stop.abort();
  process.once("SIGTERM", terminate);
  try {
    const company = board === undefined ? undefined : readOfficeCompany(roles);
    if (company !== undefined) {
      io.error(`Board ${parsed.board}: ${company.people.length} people from the company record`);
    }
    await serveRuntime({
      serverId: file.id,
      roles,
      storage: { sqlite: parsed.database },
      ...(board === undefined || company === undefined
        ? {}
        : {
            board,
            people: company.people,
            personRoutes: company.personRoutes,
            files,
          }),
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
    board?.close();
    connections.close();
  }
  return 0;
}
