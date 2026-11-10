/**
 * Writes protocol frames to the runtime's stdout without ever making the harness wait.
 *
 * `write` only queues. A pump drains the queue into the stream and, when the stream says it is full,
 * waits for `drain` before writing more, so a slow or stalled reader costs memory, not progress: the
 * harness keeps running and its events queue up. A broken stream (the parent went away) is reported
 * once and the rest dropped; stdout carries frames only, so the report goes to the log.
 */

import { once } from "node:events";
import type { Writable } from "node:stream";
import { encode } from "@officehum/protocol";

export class FrameWriter {
  readonly #output: Writable;
  readonly #log: (line: string) => void;
  #queue: string[] = [];
  /**
   * Whether a pump is running. Set and cleared synchronously by the pump itself, never in a later
   * microtask: a pump that writes everything without waiting finishes inside `write`, and a frame
   * queued right after it must start a new pump rather than wait on one that has already ended.
   */
  #pumping = false;
  #running: Promise<void> = Promise.resolve();
  #broken = false;

  constructor(output: Writable, log: (line: string) => void) {
    this.#output = output;
    this.#log = log;
    // An EPIPE after the parent exits arrives as an `error` event; unhandled, it would crash the
    // process before the harness could close cleanly.
    output.on("error", (error) => this.#break(error));
  }

  #break(error: unknown): void {
    if (this.#broken) return;
    this.#broken = true;
    this.#queue = [];
    this.#log(`Could not write to the gateway; dropping further frames: ${String(error)}`);
  }

  /** Queues one message as a frame. Never blocks and never throws. */
  write(message: object): void {
    if (this.#broken) return;
    this.#queue.push(encode(message));
    if (!this.#pumping) this.#running = this.#pump();
  }

  /** Resolves once every queued frame has been handed to the stream (or the stream broke). */
  async flush(): Promise<void> {
    while (this.#pumping) await this.#running;
  }

  async #pump(): Promise<void> {
    this.#pumping = true;
    try {
      while (this.#queue.length > 0 && !this.#broken) {
        const frames = this.#queue.join("");
        this.#queue = [];
        if (!this.#output.write(frames)) await once(this.#output, "drain");
      }
    } catch (error) {
      this.#break(error);
    } finally {
      this.#pumping = false;
    }
  }
}
