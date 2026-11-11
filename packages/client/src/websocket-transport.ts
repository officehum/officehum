import {
  type Accepted,
  type ErrorMessage,
  PROTOCOL_VERSION,
  type Result,
  type ServerMessage,
  validateMessage,
} from "@officehum/protocol";
import { backoffDelay, sleep } from "./backoff.js";
import { GatewayError } from "./errors.js";
import type { Run } from "./run.js";
import {
  type Outgoing,
  retryable,
  type Transport,
  type TransportOptions,
  tokenOf,
} from "./transport.js";

const HANDSHAKE_TIMEOUT_MS = 15_000;

interface Pending {
  readonly command: Outgoing;
  readonly run: Run | undefined;
  /** Whether sending this command is what put its run in the routing table. */
  added: boolean;
  readonly resolve: (reply: Accepted | Result) => void;
  readonly reject: (error: Error) => void;
  attempts: number;
}

/**
 * One WebSocket to the gateway's `/v1/ws`, signed in with `hello.token` (which works in browsers,
 * where an upgrade cannot carry a header). When the socket drops it reconnects with backoff, sends
 * `submit` and `subscribe` commands that were waiting on a reply again (the same `requestId`, so no
 * work repeats), fails any other unanswered command with `busy`, and re-subscribes every unfinished
 * run after the last `seq` it saw.
 */
export class WebSocketTransport implements Transport {
  readonly #options: TransportOptions;
  readonly #retries: number;
  #socket: WebSocket | undefined;
  #ready = false;
  #closed = false;
  #ids = 0;
  /** Commands sent on the current socket, by their wire id. */
  readonly #pending = new Map<string, Pending>();
  /** Commands waiting for a socket: never sent, or sent on one that dropped and safe to send again. */
  #queue: Pending[] = [];
  /** Unfinished runs, by request id, which this connection's events are delivered to. */
  readonly #runs = new Map<string, Run>();

  private constructor(options: TransportOptions) {
    this.#options = options;
    this.#retries = options.retries ?? 8;
  }

  /** Connects and signs in; rejects with the gateway's error (`unauthorized` …) if it cannot. */
  static async open(options: TransportOptions): Promise<WebSocketTransport> {
    const transport = new WebSocketTransport(options);
    await transport.#connect();
    return transport;
  }

  request(command: Outgoing, run?: Run): Promise<Accepted | Result> {
    if (this.#closed) return Promise.reject(new Error("The gateway client is closed."));
    return new Promise((resolve, reject) => {
      this.#dispatch({ command, run, added: false, resolve, reject, attempts: 0 });
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const closed = new Error("The gateway client is closed.");
    for (const pending of [...this.#pending.values(), ...this.#queue]) pending.reject(closed);
    this.#pending.clear();
    this.#queue = [];
    for (const run of this.#runs.values()) run.fail(closed);
    this.#runs.clear();
    this.#socket?.close();
  }

  async #connect(): Promise<void> {
    const url = `${this.#options.url.replace(/^http/, "ws").replace(/\/$/, "")}/v1/ws`;
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new GatewayError("busy", `The gateway at ${url} did not answer in time.`));
      }, HANDSHAKE_TIMEOUT_MS);
      const fail = (error: Error) => {
        clearTimeout(timer);
        socket.close();
        reject(error);
      };
      socket.addEventListener("error", () =>
        fail(new GatewayError("busy", `Could not connect to the gateway at ${url}.`)),
      );
      socket.addEventListener("close", () =>
        fail(new GatewayError("busy", `The gateway at ${url} closed the connection.`)),
      );
      socket.addEventListener("open", async () => {
        try {
          const token = await tokenOf(this.#options.token);
          socket.send(
            JSON.stringify({
              type: "hello",
              version: PROTOCOL_VERSION,
              client: this.#options.client ?? "officehum-client",
              token,
            }),
          );
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.addEventListener("message", (event: MessageEvent) => {
        const message = parse(event.data);
        if (message?.type === "welcome") {
          clearTimeout(timer);
          resolve();
        } else if (message?.type === "error") {
          fail(GatewayError.from(message));
        }
      });
    });
    // Handshake done: from here the socket's own listeners take over.
    this.#socket = socket;
    this.#ready = true;
    socket.addEventListener("message", (event: MessageEvent) => {
      if (this.#socket !== socket) return;
      const message = parse(event.data);
      if (message !== undefined && message.type !== "welcome") this.#onMessage(message);
    });
    socket.addEventListener("close", () => {
      if (this.#socket === socket) this.#onClose();
    });
    this.#resume();
  }

  #dispatch(pending: Pending): void {
    if (!this.#ready || this.#socket === undefined) {
      this.#queue.push(pending);
      return;
    }
    const { command, run } = pending;
    if (run !== undefined && !run.done && this.#runs.get(run.requestId) !== run) {
      this.#runs.set(run.requestId, run);
      pending.added = true;
    }
    const id = `c${++this.#ids}`;
    const wire =
      command.type === "subscribe" && run !== undefined && run.lastSeq > 0
        ? { ...command, id, afterSeq: run.lastSeq }
        : { ...command, id };
    this.#pending.set(id, pending);
    this.#socket.send(JSON.stringify(wire));
  }

  #onMessage(message: ServerMessage): void {
    if (message.type === "event") {
      const run = this.#runs.get(message.requestId);
      if (run === undefined) return;
      run.push(message);
      if (run.done) this.#runs.delete(message.requestId);
      return;
    }
    if (message.type === "welcome") return;
    if (message.id === undefined) {
      // The token expired: sign in again on a new socket, which also re-subscribes every run.
      if (message.type === "error" && message.code === "unauthorized") this.#socket?.close();
      return;
    }
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    this.#pending.delete(message.id);
    if (message.type === "error") this.#onError(pending, message);
    else pending.resolve(message);
  }

  #onError(pending: Pending, error: ErrorMessage): void {
    // `busy` (the runtime is restarting) and `unauthorized` (the token just expired; a reconnect is
    // under way) are worth another try for a command that is safe to repeat.
    const transient = error.code === "busy" || error.code === "unauthorized";
    if (transient && retryable(pending.command) && pending.attempts < this.#retries) {
      const delay = backoffDelay(pending.attempts++, this.#options.backoff);
      setTimeout(() => {
        if (!this.#closed) this.#dispatch(pending);
      }, delay);
      return;
    }
    const failure = GatewayError.from(error);
    const { run } = pending;
    if (
      run !== undefined &&
      pending.added &&
      run.lastSeq === 0 &&
      this.#runs.get(run.requestId) === run
    ) {
      this.#runs.delete(run.requestId);
    }
    pending.reject(failure);
  }

  #onClose(): void {
    this.#ready = false;
    this.#socket = undefined;
    if (this.#closed) return;
    const lost = new GatewayError(
      "busy",
      "The connection to the gateway closed before it answered; send the command again if it is still wanted.",
    );
    const resend: Pending[] = [];
    for (const pending of this.#pending.values()) {
      if (retryable(pending.command)) resend.push(pending);
      else pending.reject(lost);
    }
    this.#pending.clear();
    this.#queue = [...resend, ...this.#queue];
    void this.#reconnect();
  }

  async #reconnect(): Promise<void> {
    for (let attempt = 0; !this.#closed; attempt++) {
      await sleep(backoffDelay(attempt, this.#options.backoff));
      if (this.#closed) return;
      try {
        await this.#connect();
        return;
      } catch {
        // Try again after a longer wait; a failing token source gets the same patience.
      }
    }
  }

  /** On a new socket: send what waited, then re-subscribe each run nothing in flight covers. */
  #resume(): void {
    const waiting = this.#queue;
    this.#queue = [];
    for (const pending of waiting) this.#dispatch(pending);
    const covered = new Set(
      [...this.#pending.values()].map((pending) => pending.run?.requestId).filter(Boolean),
    );
    for (const run of this.#runs.values()) {
      if (run.done || covered.has(run.requestId)) continue;
      this.#dispatch({
        command: { type: "subscribe", requestId: run.requestId },
        run,
        added: false,
        resolve: () => {},
        reject: (error) => {
          run.fail(error);
          this.#runs.delete(run.requestId);
        },
        attempts: 0,
      });
    }
  }
}

/** A server message from a WebSocket frame, or undefined for anything else. */
function parse(data: unknown): ServerMessage | undefined {
  if (typeof data !== "string") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return undefined;
  }
  const checked = validateMessage(value, "server");
  return checked.ok ? checked.message : undefined;
}
