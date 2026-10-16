/**
 * The `officehum run ROLE_DIR` pieces: a terminal approver, the app-client config reader, model
 * selection, and the interactive loop. The command itself is wired in `cli.ts`, where the session is
 * registered so a SIGINT closes it; everything here is pure enough to test without a TTY.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { RoleRun } from "@officehum/office";
import { PAPER_MODEL_REF, paperProvider } from "@officehum/provider-paper";
import { type Approver, formatIssue } from "@officehum/sdk";
import type { CliDependencies, CliIo } from "./cli.js";
import { UsageError } from "./usage-error.js";

/** Who is sitting at the terminal, for the approval audit trail. */
export function terminalUser(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? "unknown";
  }
}

/**
 * The terminal approver: prints the approval's description and arguments, reads one line, and treats
 * only an explicit `y`/`yes` as consent. Anything else — `n`, an empty line, an unrecognized word, or
 * end of input — declines, so a guardrail never depends on the operator meaning to say no.
 */
export function terminalApprover(io: CliIo, user: string = terminalUser()): Approver {
  return async (request) => {
    io.output(`Approval required: ${request.description}`);
    io.output(`Tool: ${request.tool}`);
    io.output(`Arguments: ${JSON.stringify(request.arguments)}`);
    const answer = (await io.readApproval("Approve? [y/n] "))?.trim().toLowerCase();
    if (answer === "y" || answer === "yes") return { approved: true, by: user };
    if (answer !== "n" && answer !== "no") {
      io.error(
        answer === undefined
          ? "No answer at the terminal; treating it as no."
          : `Unrecognized answer ${JSON.stringify(answer)}; treating it as no.`,
      );
    }
    return { approved: false, by: user, note: "Declined at the terminal" };
  };
}

export interface RunArguments {
  readonly roleDir: string;
  readonly overlays: readonly string[];
  readonly database?: string;
  readonly dataDir?: string;
  readonly workDir?: string;
  readonly model?: string;
  readonly clientFile?: string;
}

const RUN_USAGE =
  "usage: officehum run ROLE_DIR [--overlay DIR]... [--db FILE] [--data DIR] [--work DIR] [--model provider/model] [--clients FILE]";

/** Parses the run command's arguments: one positional role directory, then the flags above. */
export function parseRunArguments(args: readonly string[]): RunArguments {
  const overlays: string[] = [];
  let roleDir: string | undefined;
  let database: string | undefined;
  let dataDir: string | undefined;
  let workDir: string | undefined;
  let model: string | undefined;
  let clientFile: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) continue;
    if (!token.startsWith("--")) {
      if (roleDir !== undefined)
        throw new UsageError(`Only one role directory is allowed.\n${RUN_USAGE}`);
      roleDir = token;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`${token} requires a value.\n${RUN_USAGE}`);
    }
    index += 1;
    if (token === "--overlay") overlays.push(value);
    else if (token === "--db") database = value;
    else if (token === "--data") dataDir = value;
    else if (token === "--work") workDir = value;
    else if (token === "--model") model = value;
    else if (token === "--clients") clientFile = value;
    else throw new UsageError(`Unknown option: ${token}\n${RUN_USAGE}`);
  }
  if (roleDir === undefined) throw new UsageError(`run requires a role directory.\n${RUN_USAGE}`);
  return {
    roleDir,
    overlays,
    ...(database === undefined ? {} : { database }),
    ...(dataDir === undefined ? {} : { dataDir }),
    ...(workDir === undefined ? {} : { workDir }),
    ...(model === undefined ? {} : { model }),
    ...(clientFile === undefined ? {} : { clientFile }),
  };
}

/** Splits `provider/modelId`, with the split at the first slash so a model id may contain slashes. */
export function parseModelRef(spec: string): ModelRef {
  const slash = spec.indexOf("/");
  const provider = slash === -1 ? "" : spec.slice(0, slash);
  const modelId = slash === -1 ? "" : spec.slice(slash + 1);
  if (provider.length === 0 || modelId.length === 0) {
    throw new UsageError(
      `--model must be provider/model, e.g. paper/${PAPER_MODEL_REF.modelId} (got ${JSON.stringify(spec)}).`,
    );
  }
  return { provider, modelId };
}

/**
 * The models the run command talks to. An injected runtime (tests, scripted provider) wins; otherwise
 * paper and openai are the selectable providers and the credential is required before any work starts.
 */
export function runModels(
  ref: ModelRef,
  dependencies: Pick<CliDependencies, "createRunModels">,
): { models: ReturnType<typeof createModels>; model: ModelRef } {
  const injected = dependencies.createRunModels?.(ref);
  if (injected !== undefined) {
    if (injected.model.provider !== ref.provider || injected.model.modelId !== ref.modelId) {
      throw new Error("Injected run model does not match the requested provider/model.");
    }
    if (injected.models.getModel(ref.provider, ref.modelId) === undefined) {
      throw new Error(`Unknown ${ref.provider} model: ${ref.modelId}`);
    }
    return injected;
  }
  if (ref.provider !== "paper" && ref.provider !== "openai") {
    throw new Error(
      `The run command runs paper or openai models, not ${JSON.stringify(ref.provider)}. Pass --model paper/${PAPER_MODEL_REF.modelId} or openai/gpt-6-sol.`,
    );
  }
  const keyName = ref.provider === "paper" ? "PAPERINSTRUMENTS_API_KEY" : "OPENAI_API_KEY";
  if (!process.env[keyName]?.trim()) {
    throw new Error(`Set ${keyName} in your shell before running against ${ref.provider}.`);
  }
  const models = createModels();
  models.setProvider(ref.provider === "paper" ? paperProvider() : openaiProvider());
  if (models.getModel(ref.provider, ref.modelId) === undefined) {
    throw new Error(`Unknown ${ref.provider} model: ${ref.modelId}`);
  }
  return { models, model: ref };
}

type ClientEntry = { readonly module: string; readonly export?: string };

/**
 * Reads the `--clients` file: client name → the module that exports its factory. Each factory is
 * called with no arguments and reads its own configuration from the environment, so nothing in this
 * file can hold a credential. Only `module` and `export` are allowed per entry, and that is enforced
 * rather than trusted.
 */
export async function readClientConfig(file: string): Promise<Readonly<Record<string, unknown>>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`Could not read the --clients file ${file}: ${String(error)}.`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `The --clients file ${file} must hold an object of client name → { "module": … }.`,
    );
  }
  const clients: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(parsed as Record<string, unknown>)) {
    const entry = clientEntry(name, raw, file);
    const specifier = entry.module;
    const url =
      specifier.startsWith(".") || isAbsolute(specifier)
        ? pathToFileURL(resolve(dirname(file), specifier)).href
        : specifier;
    let module: Record<string, unknown>;
    try {
      module = (await import(url)) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`Client "${name}" could not import ${specifier}: ${String(error)}.`);
    }
    const exported = entry.export === undefined ? module.default : module[entry.export];
    if (typeof exported !== "function") {
      throw new Error(
        `Client "${name}": ${specifier} does not export a factory${entry.export === undefined ? "" : ` named "${entry.export}"`}.`,
      );
    }
    clients[name] = (exported as () => unknown)();
  }
  return clients;
}

function clientEntry(name: string, raw: unknown, file: string): ClientEntry {
  if (typeof raw === "string") return { module: raw };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Client "${name}" in ${file} must be a module path, or { "module": … }.`);
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "module" && key !== "export") {
      throw new Error(
        `Client "${name}" in ${file} has an unsupported field "${key}"; only "module" and "export" are allowed, so a credential can never live in this file.`,
      );
    }
  }
  if (typeof record.module !== "string" || record.module.length === 0) {
    throw new Error(`Client "${name}" in ${file} needs a non-empty "module".`);
  }
  if (record.export !== undefined && typeof record.export !== "string") {
    throw new Error(`Client "${name}" in ${file}: "export" must be a string.`);
  }
  return {
    module: record.module,
    ...(record.export === undefined ? {} : { export: record.export }),
  };
}

/** The idempotency key for a submitted line: a hash of the line and its position in the session. */
export function requestIdFor(line: string, position: number): string {
  return createHash("sha256").update(`${position}\u0000${line}`).digest("hex");
}

function printResult(result: Awaited<ReturnType<RoleRun["submit"]>>, io: CliIo): void {
  io.output(`Submission: ${result.submissionId}`);
  io.output(`Outcome: ${result.settlement.status}`);
  if (result.text !== undefined && result.text.length > 0) io.output(result.text);
  if (result.settlement.status === "unanswered") {
    io.error(`Unanswered: ${result.settlement.reason}`);
  }
}

/** Prints a role-run result the way `resume` and each submitted line do. */
export function printRunResult(result: Awaited<ReturnType<RoleRun["submit"]>>, io: CliIo): void {
  printResult(result, io);
}

async function handleSlashCommand(session: RoleRun, line: string, io: CliIo): Promise<void> {
  const name = line.slice(1);
  if (name === "help") {
    io.output(
      "Type a message to talk to the role. /commands lists operator commands, /reload re-reads overlays, /quit or Ctrl-D exits.",
    );
    return;
  }
  if (name === "reload") {
    const issues = await session.reload();
    if (issues.length === 0) io.output("Reloaded the role's files and overlays.");
    else for (const issue of issues) io.error(formatIssue(issue));
    return;
  }
  if (name === "commands") {
    const commands = session.role.manifest.commands ?? [];
    if (commands.length === 0) {
      io.output("No operator commands.");
      return;
    }
    for (const command of commands) io.output(`${command.name}: ${command.description}`);
    return;
  }
  const declared = (session.role.manifest.commands ?? []).some((command) => command.name === name);
  if (!declared) {
    io.error(`Unknown command: /${name}. /commands lists the operator commands.`);
    return;
  }
  const result = await session.command(name);
  io.output(JSON.stringify(result, null, 2));
}

/**
 * The interactive loop: reads lines and submits each as an idempotent submission, runs `/reload`,
 * `/commands` and the manifest's operator commands, and exits on end of input.
 */
export async function runInteractive(session: RoleRun, io: CliIo): Promise<number> {
  if (io.readLine === undefined) {
    io.error("The run command needs a terminal to read input from.");
    return 1;
  }
  let position = 0;
  for (;;) {
    const line = await io.readLine("> ");
    if (line === undefined) return 0;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed === "/quit" || trimmed === "/exit") return 0;
    try {
      if (trimmed.startsWith("/")) {
        await handleSlashCommand(session, trimmed, io);
        continue;
      }
      const result = await session.submit(trimmed, requestIdFor(trimmed, position));
      position += 1;
      printResult(result, io);
    } catch (error) {
      io.error(error instanceof Error ? error.message : String(error));
    }
  }
}
