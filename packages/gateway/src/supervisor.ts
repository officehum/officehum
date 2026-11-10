/**
 * Runs the office's runtime as a child process and keeps it running.
 *
 * The runtime is a separate process so that its crash never takes the gateway, or any client
 * connection, down with it. The supervisor always reads the runtime's stdout (a full pipe would stall
 * the runtime), hands each frame to the gateway, and passes its stderr to the log. The runtime is
 * `up` once it says `welcome`. Any exit the gateway did not ask for restarts it after a backoff:
 * 1 s, 2 s, 4 s … up to 30 s, back to 1 s once it has stayed up for a minute.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { encode, LineDecoder } from "@officehum/protocol";

export interface Backoff {
  readonly initialMs: number;
  readonly maxMs: number;
  /** Up this long, and the next restart waits `initialMs` again. */
  readonly stableMs: number;
}

export const DEFAULT_BACKOFF: Backoff = { initialMs: 1_000, maxMs: 30_000, stableMs: 60_000 };

export interface SupervisorOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly backoff?: Backoff;
  /** Every frame the runtime writes, in order, `welcome` included. */
  readonly onFrame: (frame: unknown) => void;
  /** `up` after each `welcome`; `down` when the process exits or fails to start. */
  readonly onState: (state: "up" | "down") => void;
  readonly log: (line: string) => void;
}

export class RuntimeSupervisor {
  readonly #options: SupervisorOptions;
  readonly #backoff: Backoff;
  #child: ChildProcess | undefined;
  #up = false;
  #upSince = 0;
  #delay: number;
  #stopping = false;
  #restart: NodeJS.Timeout | undefined;
  #exited: Promise<void> = Promise.resolve();

  constructor(options: SupervisorOptions) {
    this.#options = options;
    this.#backoff = options.backoff ?? DEFAULT_BACKOFF;
    this.#delay = this.#backoff.initialMs;
  }

  /** Whether the runtime is running and has said `welcome`. */
  get up(): boolean {
    return this.#up;
  }

  /** The running runtime's process id, if any. */
  get pid(): number | undefined {
    return this.#child?.pid;
  }

  start(): void {
    this.#stopping = false;
    this.#spawn();
  }

  /** Sends one message to the runtime. False when it is not up, so the caller answers `busy`. */
  send(message: object): boolean {
    const stdin = this.#child?.stdin;
    if (!this.#up || stdin === undefined || stdin === null || stdin.destroyed) return false;
    stdin.write(encode(message));
    return true;
  }

  /**
   * Stops the runtime: closes its stdin so it closes the office cleanly, and kills it if it has not
   * exited within `graceMs`.
   */
  async stop(graceMs = 10_000): Promise<void> {
    this.#stopping = true;
    clearTimeout(this.#restart);
    const child = this.#child;
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
    child.stdin?.end();
    const killer = setTimeout(() => child.kill("SIGKILL"), graceMs);
    try {
      await this.#exited;
    } finally {
      clearTimeout(killer);
    }
  }

  #spawn(): void {
    const { command, args, cwd, env, log } = this.#options;
    const child = spawn(command, [...args], {
      cwd,
      env: env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;
    const decoder = new LineDecoder();
    let errorLine = "";

    this.#exited = new Promise<void>((resolve) => {
      let settled = false;
      const ended = (why: string) => {
        if (settled) return;
        settled = true;
        resolve();
        this.#ended(child, why);
      };
      // `close`, not `exit`: it comes once stdout is fully read, so no frame of this runtime can
      // arrive after the gateway has started counting the next one's.
      child.once("close", (code, signal) =>
        ended(signal === null ? `exited with code ${code}` : `was killed by ${signal}`),
      );
      // A runtime that cannot start (no such command) reports `error` and may never `exit`.
      child.once("error", (error) => ended(`could not start: ${error.message}`));
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      // A runtime already replaced speaks for nobody.
      if (this.#child !== child) return;
      for (const frame of decoder.push(chunk)) {
        if (!frame.ok) {
          log(`The runtime wrote a bad frame (${frame.code}): ${frame.message}`);
          continue;
        }
        if (!this.#up && isWelcome(frame.value)) {
          this.#up = true;
          this.#upSince = Date.now();
          this.#options.onState("up");
        }
        this.#options.onFrame(frame.value);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      errorLine += chunk.toString("utf8");
      const lines = errorLine.split("\n");
      errorLine = lines.pop() ?? "";
      for (const line of lines) if (line.trim() !== "") log(`runtime: ${line}`);
    });
    // Writes to a runtime that just died fail with EPIPE; the exit handler deals with the death.
    child.stdin?.on("error", (error) => log(`Could not write to the runtime: ${error.message}`));
  }

  #ended(child: ChildProcess, why: string): void {
    if (this.#child !== child) return;
    const wasUp = this.#up;
    this.#up = false;
    if (wasUp) this.#options.onState("down");
    if (this.#stopping) return;
    if (wasUp && Date.now() - this.#upSince >= this.#backoff.stableMs) {
      this.#delay = this.#backoff.initialMs;
    }
    const delay = this.#delay;
    this.#delay = Math.min(this.#delay * 2, this.#backoff.maxMs);
    this.#options.log(`The runtime ${why}; restarting it in ${delay} ms.`);
    this.#restart = setTimeout(() => {
      if (!this.#stopping) this.#spawn();
    }, delay);
  }
}

function isWelcome(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && (value as { type?: unknown }).type === "welcome"
  );
}
