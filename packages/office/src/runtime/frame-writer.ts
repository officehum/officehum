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

  /**
   * Resolves once every queued frame has been handed to the stream, the stream broke, or `timeoutMs`
   * passed: a reader that never reads again must not keep the process from exiting. False when it
   * gave up, so the caller can destroy the stream.
   */
  async flush(timeoutMs = Number.POSITIVE_INFINITY): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<"expired">((resolve) => {
      if (Number.isFinite(timeoutMs)) timer = setTimeout(() => resolve("expired"), timeoutMs);
    });
    try {
      while (this.#pumping) {
        if ((await Promise.race([this.#running, expired])) === "expired") {
          this.#log(
            `Gave up waiting for the gateway to read ${this.#queue.length} queued frame(s).`,
          );
          return false;
        }
      }
    } finally {
      clearTimeout(timer);
    }
    return true;
  }

  /**
   * Waits for `drain`. A stream closed without an error never drains, so a close is the break it is;
   * an `error` rejects through `once`. Both listeners are removed whichever comes first.
   */
  async #drained(): Promise<void> {
    const cancel = new AbortController();
    const drained = once(this.#output, "drain", { signal: cancel.signal }).then(() => "drain");
    const closed = once(this.#output, "close", { signal: cancel.signal }).then(() => "close");
    try {
      if ((await Promise.race([drained, closed])) === "close") {
        throw new Error("the output closed");
      }
    } finally {
      cancel.abort();
      drained.catch(() => {});
      closed.catch(() => {});
    }
  }

  async #pump(): Promise<void> {
    this.#pumping = true;
    try {
      while (this.#queue.length > 0 && !this.#broken) {
        const frames = this.#queue.join("");
        this.#queue = [];
        if (!this.#output.write(frames)) await this.#drained();
      }
    } catch (error) {
      this.#break(error);
    } finally {
      this.#pumping = false;
    }
  }
}
