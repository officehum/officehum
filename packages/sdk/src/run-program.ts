/**
 * The one subprocess runner the SDK has: engines and CLI tools both start their programs here. A
 * program is an argv array started directly, never through a shell, so no argument is ever parsed as
 * a command line. See "Engines" in docs/design/agent-package.md and docs/design/tool-sources.md.
 */

import { spawn } from "node:child_process";

export interface RunProgramOptions {
  /** The program, looked up on the given environment's `PATH` unless it is a path. */
  readonly program: string;
  /** Each element reaches the program as exactly one argument. */
  readonly args: readonly string[];
  readonly cwd: string;
  /** The program's whole environment. Nothing is inherited from the host's. */
  readonly env: Readonly<Record<string, string>>;
  /** Milliseconds before the process is killed. */
  readonly timeoutMs: number;
  /** Cancels the run: the process is killed and the run rejects with the signal's reason. */
  readonly signal?: AbortSignal | undefined;
  /** Bytes of stdout or stderr kept before the process is killed. Default 32 MiB. */
  readonly maxBuffer?: number;
}

/** How a program ended. */
export interface ProgramRun {
  readonly stdout: string;
  readonly stderr: string;
  /** `null` when the process was killed by a signal, or never started. */
  readonly exitCode: number | null;
  /** True when the run took longer than `timeoutMs` and the process was killed. */
  readonly timedOut: boolean;
  /** Set when the program could not be started (for example, it is not installed). */
  readonly startError?: Error;
}

/**
 * Runs a program to completion with no standard input. It never rejects for the program's own
 * failure (a non-zero exit, a timeout, a missing program): those are in the result. It rejects only
 * when `signal` cancels the run, after the process has been killed.
 */
export function runProgram(options: RunProgramOptions): Promise<ProgramRun> {
  const maxBuffer = options.maxBuffer ?? 32 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted === true) {
      reject(options.signal.reason);
      return;
    }
    const child = spawn(options.program, [...options.args], {
      cwd: options.cwd,
      env: { ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let sizes = { stdout: 0, stderr: 0 };
    let timedOut = false;
    let startError: Error | undefined;
    let settled = false;

    // SIGKILL, not SIGTERM: a program that ignores SIGTERM would otherwise outlive its timeout.
    const kill = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    const onAbort = () => kill();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const collect = (stream: "stdout" | "stderr", into: Buffer[]) => (chunk: Buffer) => {
      sizes = { ...sizes, [stream]: sizes[stream] + chunk.length };
      if (sizes[stream] > maxBuffer) kill();
      else into.push(chunk);
    };
    child.stdout.on("data", collect("stdout", stdout));
    child.stderr.on("data", collect("stderr", stderr));
    child.on("error", (error) => {
      startError = error;
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (options.signal?.aborted === true) {
        reject(options.signal.reason);
        return;
      }
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code,
        timedOut,
        ...(startError === undefined ? {} : { startError }),
      });
    });
  });
}
