/**
 * The isolated Python worker, as the host sees it.
 *
 * One run gets a fresh directory: `inputs/` holds a read-only copy of every leased version, `staging/`
 * is the only writable place, and `tmp/` is the process's own temporary directory. The interpreter is
 * spawned with an explicit environment — a fixed `PATH`, no `HOME`, no credential — and a wall-clock
 * kill as a backstop under the worker's own alarm. Everything the worker reports is validated here
 * before it can enter a receipt, and the input copies are hashed again afterwards so a refusal or a
 * crash can be shown to have left the sources untouched.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type DocumentRefusalCode, refusal, refusalCodeFromWorker } from "./errors.js";
import { type DocumentFormat, isDocumentFormat } from "./formats.js";
import type { ResourceLimits } from "./lease.js";
import { validateWorkerIdentity, type WorkerIdentity } from "./operation.js";
import { assertHash, assertPathSegment, assertSize, hasCode, messageOf } from "./validate.js";

/** The environment variable a host sets to name the isolated Python 3.13 worker interpreter. */
export const PAPER_INTERPRETER_VARIABLE = "OFFICEHUM_PAPER_PYTHON";

/** The checked-in worker script, next to this module's `dist` or `src` directory. */
export function defaultWorkerScript(): string {
  return fileURLToPath(new URL("../python/worker.py", import.meta.url));
}

export interface PaperWorkerInput {
  readonly fileId: string;
  readonly versionId: string;
  readonly name: string;
  readonly format: DocumentFormat;
  readonly sha256: string;
  readonly size: number;
  readonly writable: boolean;
  readonly bytes: Uint8Array;
}

export interface PaperWorkerRequest {
  readonly operationId: string;
  readonly code: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly inputs: readonly PaperWorkerInput[];
  readonly outputFormats: readonly DocumentFormat[];
  readonly limits: ResourceLimits;
}

export interface DeclaredOutput {
  readonly name: string;
  readonly format: DocumentFormat;
  readonly size: number;
  readonly sha256: string;
  /** The leased source version this output proposes a new version of, or `null` for a new document. */
  readonly editOf: string | null;
  readonly bytes: Uint8Array;
}

/** What the worker said about itself and about the run. Recorded in the receipt. */
export interface PaperWorkerEvidence {
  readonly identity: WorkerIdentity;
  /** The leased input versions the run actually opened, in order. */
  readonly reads: readonly string[];
  /** One reopen witness per output, e.g. `report.docx: 3 paragraphs`. */
  readonly reopen: readonly string[];
  readonly enforcement: Readonly<Record<string, unknown>>;
  readonly notes: readonly string[];
  readonly stdout: string;
  readonly result: unknown;
  readonly resultDeclared: boolean;
}

export type PaperWorkerOutcome =
  | {
      readonly kind: "completed";
      readonly outputs: readonly DeclaredOutput[];
      readonly evidence: PaperWorkerEvidence;
    }
  | {
      readonly kind: "refused";
      readonly code: DocumentRefusalCode;
      readonly message: string;
    };

export interface PaperWorker {
  run(request: PaperWorkerRequest): Promise<PaperWorkerOutcome>;
}

export interface SubprocessPaperWorkerOptions {
  /** The Python 3.13 interpreter with the pinned Paper forks. Absolute paths only. */
  readonly interpreter: string;
  readonly workerScript?: string;
  /** Where run directories are created. Defaults to the host's temporary directory. */
  readonly root?: string;
  /** More environment for the interpreter. Credential-shaped names and `HOME` are removed again. */
  readonly env?: Readonly<Record<string, string>>;
  /** Seconds added to the lease's wall-clock budget before the backstop kill. Default 10. */
  readonly graceSeconds?: number;
  readonly maxResponseBytes?: number;
}

/**
 * The interpreter a host configured, or `undefined`. A test that needs a real interpreter skips
 * visibly when this is undefined rather than guessing at a path.
 */
export function resolvePaperInterpreter(
  env: Readonly<Record<string, string | undefined>>,
  explicit?: string,
): string | undefined {
  if (explicit !== undefined && explicit !== "") return explicit;
  const fromEnv = env[PAPER_INTERPRETER_VARIABLE];
  return fromEnv === undefined || fromEnv === "" ? undefined : fromEnv;
}

const BASE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|SESSION|COOKIE|PRIVATE)/iu;
const REMOVED_NAMES = new Set(["HOME", "USER", "LOGNAME", "SSH_AUTH_SOCK", "AWS_PROFILE"]);

/** The environment the interpreter gets: explicit, bounded, and free of anything secret-shaped. */
export function workerEnvironment(
  runDir: string,
  extra: Readonly<Record<string, string>> = {},
): { env: Record<string, string>; removed: readonly string[] } {
  const env: Record<string, string> = {
    PATH: BASE_PATH,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PYTHONHASHSEED: "0",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
    PYTHONUNBUFFERED: "1",
    TMPDIR: join(runDir, "tmp"),
  };
  const removed: string[] = [];
  for (const [name, value] of Object.entries(extra)) {
    if (SECRET_NAME.test(name) || REMOVED_NAMES.has(name)) {
      removed.push(name);
      continue;
    }
    env[name] = value;
  }
  return { env, removed };
}

export function subprocessPaperWorker(options: SubprocessPaperWorkerOptions): PaperWorker {
  const workerScript = options.workerScript ?? defaultWorkerScript();
  const grace = options.graceSeconds ?? 10;
  const root = options.root ?? tmpdir();

  return {
    async run(request) {
      const runDir = await mkdtemp(join(root, "paper-run-"));
      try {
        return await execute(request, runDir);
      } finally {
        // The worker makes its input copies read-only, which also stops this process removing them.
        // Restore enough permission to clean the run directory up; nothing else is left behind.
        await chmod(join(runDir, "inputs"), 0o700).catch(() => undefined);
        await rm(runDir, { recursive: true, force: true });
      }
    },
  };

  async function execute(request: PaperWorkerRequest, runDir: string): Promise<PaperWorkerOutcome> {
    const inputsDir = join(runDir, "inputs");
    const stagingDir = join(runDir, "staging");
    await mkdir(inputsDir, { recursive: false, mode: 0o700 });
    await mkdir(stagingDir, { recursive: false, mode: 0o700 });
    await mkdir(join(runDir, "tmp"), { recursive: false, mode: 0o700 });

    const names = new Set<string>();
    for (const input of request.inputs) {
      assertPathSegment(input.name, "a staged input name");
      assertHash(input.sha256, "a staged input hash");
      if (names.has(input.name)) {
        throw refusal("invalid-lease", "the lease lists the same input name twice");
      }
      names.add(input.name);
      if (sha256(input.bytes) !== input.sha256 || input.bytes.byteLength !== input.size) {
        throw refusal(
          "input-integrity",
          `the source bytes for ${input.name} do not match the lease`,
        );
      }
      await writeFile(join(inputsDir, input.name), input.bytes, { flag: "wx", mode: 0o400 });
    }

    const requestPath = join(runDir, "request.json");
    await writeFile(
      requestPath,
      JSON.stringify({
        protocol: "officehum.paper-worker/1",
        operationId: request.operationId,
        code: request.code,
        arguments: request.arguments,
        libraries: { "paper-docx": "0.2.0", "paper-pptx": "0.2.0", "paper-xlsx": "0.2.1" },
        inputs: request.inputs.map((input) => ({
          versionId: input.versionId,
          fileId: input.fileId,
          name: input.name,
          format: input.format,
          sha256: input.sha256,
          size: input.size,
          writable: input.writable,
        })),
        inputsDir,
        staging: stagingDir,
        outputFormats: [...request.outputFormats],
        limits: { ...request.limits },
      }),
      { flag: "wx", mode: 0o600 },
    );

    const { env, removed } = workerEnvironment(runDir, options.env ?? {});
    const timeoutMs = (request.limits.wallSeconds + grace) * 1_000;
    const answer = await spawn(workerScript, requestPath, stagingDir, env, timeoutMs);
    const parsed = parseAnswer(answer.stdout);

    if (parsed !== undefined) {
      if (parsed.ok !== true) {
        return {
          kind: "refused",
          code: refusalCodeFromWorker(parsed.code),
          message: text(parsed.message, "the worker refused the run"),
        };
      }
      return complete(parsed, stagingDir, request, removed);
    }
    if (answer.failure !== undefined) {
      return { kind: "refused", code: answer.failure.code, message: answer.failure.message };
    }
    return {
      kind: "refused",
      code: "worker-crash",
      message: `the worker gave no JSON answer: ${answer.detail || "no output"}`,
    };
  }

  interface SpawnAnswer {
    readonly stdout: string;
    readonly detail: string;
    readonly failure?: { readonly code: DocumentRefusalCode; readonly message: string };
  }

  function spawn(
    script: string,
    requestPath: string,
    cwd: string,
    env: Record<string, string>,
    timeoutMs: number,
  ): Promise<SpawnAnswer> {
    return new Promise((resolve) => {
      execFile(
        options.interpreter,
        [script, "--request", requestPath],
        {
          cwd,
          env,
          timeout: timeoutMs,
          killSignal: "SIGKILL",
          maxBuffer: options.maxResponseBytes ?? 4 * 1024 * 1024,
          windowsHide: true,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          const detail = lastLines(stderr, 3);
          if (hasCode(error, "ENOENT")) {
            resolve({
              stdout,
              detail,
              failure: {
                code: "interpreter-missing",
                message: `no Python interpreter at the configured path (${PAPER_INTERPRETER_VARIABLE})`,
              },
            });
            return;
          }
          if (isTimeout(error)) {
            resolve({
              stdout,
              detail,
              failure: {
                code: "timeout",
                message: "the run exceeded its wall-clock budget and was killed",
              },
            });
            return;
          }
          const signal = (error as { signal?: string } | null)?.signal;
          if (signal !== undefined && signal !== null) {
            resolve({ stdout, detail, failure: signalFailure(signal) });
            return;
          }
          if (error) {
            resolve({
              stdout,
              detail,
              failure: { code: "worker-crash", message: `the worker failed: ${messageOf(error)}` },
            });
            return;
          }
          resolve({ stdout, detail: detail === "" ? "the worker printed nothing" : detail });
        },
      );
    });
  }
}

async function complete(
  parsed: Record<string, unknown>,
  stagingDir: string,
  request: PaperWorkerRequest,
  removed: readonly string[],
): Promise<PaperWorkerOutcome> {
  const identity = validateWorkerIdentity({
    python: parsed.python,
    modules: parsed.modules,
    enforcement: parsed.enforcement,
  });
  const reads = stringList(parsed.reads, "reads");
  const leased = new Map(request.inputs.map((input) => [input.versionId, input]));
  for (const versionId of reads) {
    if (!leased.has(versionId)) {
      throw refusal("ungranted-input", "the worker reported reading a version outside the lease");
    }
  }
  const declared = arrayOf(parsed.outputs, "outputs");
  if (declared.length > request.limits.fileCount) {
    throw refusal("file-count", "the worker reported more outputs than the lease allows");
  }
  const outputs: DeclaredOutput[] = [];
  let total = 0;
  const names = new Set<string>();
  for (const raw of declared) {
    const entry = recordOf(raw, "an output");
    const name = requireString(entry.name, "an output name");
    assertPathSegment(name, "an output name");
    if (names.has(name)) throw refusal("undeclared-output", "the worker declared one name twice");
    names.add(name);
    const format = entry.format;
    if (!isDocumentFormat(format)) {
      throw refusal("output-format", "the worker declared an unsupported output format");
    }
    if (!request.outputFormats.includes(format)) {
      throw refusal("output-format", `the lease does not permit a ${format} output`);
    }
    if (!name.toLowerCase().endsWith(`.${format}`)) {
      throw refusal("output-format", `${name} does not carry the extension of its format`);
    }
    const editOf = entry.editOf === null ? null : requireString(entry.editOf, "editOf");
    if (editOf !== null && leased.get(editOf)?.writable !== true) {
      throw refusal(
        "unleased-path",
        "the worker proposed an edit of an input the lease holds read-only",
      );
    }
    const path = join(stagingDir, name);
    const info = await lstat(path).catch(() => undefined);
    if (info === undefined || !info.isFile() || info.isSymbolicLink()) {
      throw refusal("missing-output", `the worker declared ${name} but staging holds no such file`);
    }
    if (dirname(await realpath(path)) !== (await realpath(stagingDir))) {
      throw refusal("traversal", `${name} is not inside the staging directory`);
    }
    const bytes = Uint8Array.from(await readFile(path));
    assertSize(entry.size, "an output size");
    assertHash(entry.sha256, "an output hash");
    if (bytes.byteLength !== entry.size || sha256(bytes) !== entry.sha256) {
      throw refusal("output-invalid", `the staged bytes of ${name} do not match what was reported`);
    }
    total += bytes.byteLength;
    if (total > request.limits.outputBytes) {
      throw refusal("output-bytes", "the declared outputs exceed the lease's byte allowance");
    }
    outputs.push({
      name,
      format,
      size: bytes.byteLength,
      sha256: entry.sha256,
      editOf,
      bytes,
    });
  }

  const notes = [...stringList(parsed.notes, "notes")];
  if (removed.length > 0) {
    notes.push(`removed from the worker environment: ${[...removed].sort().join(", ")}`);
  }
  return {
    kind: "completed",
    outputs,
    evidence: {
      identity,
      reads,
      reopen: stringList(parsed.reopen, "reopen"),
      enforcement: recordOf(parsed.enforcement ?? {}, "enforcement"),
      notes,
      stdout: typeof parsed.stdout === "string" ? parsed.stdout.slice(0, 8 * 1024) : "",
      result: parsed.result,
      resultDeclared: parsed.resultDeclared === true,
    },
  };
}

function parseAnswer(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout.split("\n").map((line) => line.trim());
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined || !line.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        typeof (parsed as { ok?: unknown }).ok === "boolean"
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not the worker's answer; keep looking for one.
    }
  }
  return undefined;
}

function signalFailure(signal: string): { code: DocumentRefusalCode; message: string } {
  if (signal === "SIGXCPU") {
    return { code: "cpu-limit", message: "the run exceeded its CPU allowance" };
  }
  if (signal === "SIGXFSZ") {
    return { code: "file-size-limit", message: "a written file exceeded the size allowance" };
  }
  return { code: "resource-limit", message: `the worker was killed by ${signal}` };
}

function isTimeout(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const candidate = error as { killed?: unknown; code?: unknown; signal?: unknown };
  return candidate.killed === true && candidate.signal === "SIGKILL";
}

function lastLines(text: string, count: number): string {
  return text.trim().split("\n").slice(-count).join("\n").slice(0, 400);
}

function recordOf(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw refusal("worker-refused", `the worker's ${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

function arrayOf(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) throw refusal("worker-refused", `the worker's ${what} is not a list`);
  return value;
}

function stringList(value: unknown, what: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw refusal("worker-refused", `the worker's ${what} is not a list`);
  return value.map((item) => {
    if (typeof item !== "string") {
      throw refusal("worker-refused", `the worker's ${what} holds a non-string entry`);
    }
    return item;
  });
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") {
    throw refusal("worker-refused", `the worker's ${what} is not a string`);
  }
  return value;
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value.slice(0, 400) : fallback;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
