import {
  type Accepted,
  type ApprovalInfo,
  type ErrorMessage,
  PROTOCOL_VERSION,
  type Result,
  type ServerMessage,
  validateMessage,
} from "@officehum/protocol";
import { backoffDelay, sleep } from "./backoff.js";
import { GatewayError, isGatewayError } from "./errors.js";
import type { Run } from "./run.js";
import {
  type ApprovalsLost,
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
  /** Aborted by `close()`: ends backoff waits and the reconnect loop. */
  readonly #stop = new AbortController();
  #socket: WebSocket | undefined;
  #ready = false;
  #closed = false;
  #ids = 0;
  /** Commands sent on the current socket, by their wire id. */
  readonly #pending = new Map<string, Pending>();
  /** Commands waiting for a socket: never sent, or sent on one that dropped and safe to send again. */
  #queue: Pending[] = [];
  /** Commands answered `busy`, waiting out their backoff before they are sent again. */
  readonly #waiting = new Map<Pending, ReturnType<typeof setTimeout>>();
  /** Unfinished runs, by request id, which this connection's events are delivered to. */
  readonly #runs = new Map<string, Run>();
  /**
   * Who hears of approvals asked for and decided, each with whom to tell if the watch is lost;
   * non-empty once `watchApprovals` was called.
   */
  readonly #approvalListeners = new Map<
    (approval: ApprovalInfo) => void,
    ApprovalsLost | undefined
  >();

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
    this.#end(new Error("The gateway client is closed."));
  }

  /** Stops for good: every waiting command and unfinished run ends with `error`. */
  #end(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stop.abort();
    for (const timer of this.#waiting.values()) clearTimeout(timer);
    const waiting = [...this.#pending.values(), ...this.#queue, ...this.#waiting.keys()];
    this.#pending.clear();
    this.#queue = [];
    this.#waiting.clear();
    for (const pending of waiting) pending.reject(error);
    for (const run of this.#runs.values()) run.fail(error);
    this.#runs.clear();
    this.#socket?.close();
    this.#socket = undefined;
    this.#ready = false;
  }

  async #connect(): Promise<void> {
    const url = `${this.#options.url.replace(/^http/, "ws").replace(/\/$/, "")}/v1/ws`;
    const socket = new WebSocket(url);
    // The handshake's listeners go away with it, so later frames and closes are not mistaken for it.
    const handshake = new AbortController();
    const listen = { signal: handshake.signal };
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => fail(new GatewayError("busy", `The gateway at ${url} did not answer in time.`)),
          HANDSHAKE_TIMEOUT_MS,
        );
        handshake.signal.addEventListener("abort", () => clearTimeout(timer));
        // close() during the handshake ends it now, socket and all.
        this.#stop.signal.addEventListener(
          "abort",
          () => fail(new Error("The gateway client is closed.")),
          listen,
        );
        const fail = (error: Error) => {
          socket.close();
          reject(error);
        };
        socket.addEventListener(
          "error",
          () => fail(new GatewayError("busy", `Could not connect to the gateway at ${url}.`)),
          listen,
        );
        socket.addEventListener(
          "close",
          () => fail(new GatewayError("busy", `The gateway at ${url} closed the connection.`)),
          listen,
        );
        socket.addEventListener(
          "open",
          async () => {
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
          },
          listen,
        );
        socket.addEventListener(
          "message",
          (event: MessageEvent) => {
            const message = parse(event.data);
            if (message?.type === "welcome") resolve();
            else if (message?.type === "error") fail(GatewayError.from(message));
          },
          listen,
        );
      });
    } finally {
      handshake.abort();
    }
    if (this.#closed) {
      // close() ran while this handshake was under way.
      socket.close();
      throw new Error("The gateway client is closed.");
    }
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
    if (this.#closed) {
      pending.reject(new Error("The gateway client is closed."));
      return;
    }
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
    if (message.type === "approval") {
      for (const listener of this.#approvalListeners.keys()) listener(message.approval);
      return;
    }
    if (message.type === "event") {
      const run = this.#runs.get(message.requestId);
      if (run === undefined) return;
      run.push(message);
      if (run.done) this.#runs.delete(message.requestId);
      return;
    }
    if (message.type === "welcome") return;
    if (message.id === undefined) {
      if (message.type !== "error") return;
      // The token expired: sign in again on a new socket, which also re-subscribes every run.
      if (message.code === "unauthorized") this.#socket?.close();
      // The gateway lost track of a request when its runtime restarted, and cannot say which one in
      // a way this client can route: subscribe every run again. A request still known carries on (its
      // events deduplicated by seq); one that is gone fails with `not_found`.
      else if (message.code === "internal") this.#resubscribe();
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
      this.#waiting.set(
        pending,
        setTimeout(() => {
          this.#waiting.delete(pending);
          this.#dispatch(pending);
        }, delay),
      );
      return;
    }
    const { run } = pending;
    if (
      run !== undefined &&
      pending.added &&
      run.lastSeq === 0 &&
      this.#runs.get(run.requestId) === run
    ) {
      this.#runs.delete(run.requestId);
    }
    pending.reject(GatewayError.from(error));
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

  /**
   * Reconnects with backoff for as long as the gateway is unreachable. Sign-in refused more than
   * `retries` times, with no successful sign-in between, is not going to get better, so it ends the
   * client with that error instead of leaving every run and every approvals watch waiting.
   */
  async #reconnect(): Promise<void> {
    let refused = 0;
    for (let attempt = 0; !this.#closed; attempt++) {
      await sleep(backoffDelay(attempt, this.#options.backoff), this.#stop.signal);
      if (this.#closed) return;
      try {
        await this.#connect();
        return;
      } catch (error) {
        if (isGatewayError(error, "unauthorized") && ++refused > this.#retries) {
          // A caller that only watches approvals has no run to fail, so this is how it hears.
          this.#loseApprovals(error);
          this.#end(error);
          return;
        }
      }
    }
  }

  /** On a new socket: send what waited, then re-subscribe each run nothing in flight covers. */
  #resume(): void {
    const waiting = this.#queue;
    this.#queue = [];
    for (const pending of waiting) this.#dispatch(pending);
    this.#resubscribe();
    // Approvals asked for or decided while the socket was down: watch again, and pass on what waits.
    if (this.#approvalListeners.size > 0 && this.#socket !== undefined) this.#rewatch(this.#socket);
  }

  /**
   * Watches approvals again on a new socket. Until the gateway takes the watch it sends this
   * connection no approvals, so a `busy` answer (its runtime is restarting) is tried again, with
   * backoff, for as long as this socket lasts; the next socket starts over. Any other refusal
   * (`forbidden`: the caller may no longer approve) will not get better by asking again, so the
   * watch is over: every listener is dropped and told why.
   */
  #rewatch(socket: WebSocket, attempt = 0): void {
    this.#dispatch({
      command: { type: "watch_approvals" },
      run: undefined,
      added: false,
      resolve: (reply) => this.#tellApprovals(reply),
      reject: (error) => {
        // Not the gateway's answer: the client is closing.
        if (!isGatewayError(error)) return;
        if (error.code !== "busy") {
          this.#loseApprovals(error);
          return;
        }
        const delay = backoffDelay(attempt, this.#options.backoff);
        void sleep(delay, this.#stop.signal).then(() => {
          if (this.#socket === socket && !this.#closed) this.#rewatch(socket, attempt + 1);
        });
      },
      attempts: 0,
    });
  }

  async watchApprovals(
    listener: (approval: ApprovalInfo) => void,
    onLost?: ApprovalsLost,
  ): Promise<readonly ApprovalInfo[]> {
    const added = !this.#approvalListeners.has(listener);
    const before = this.#approvalListeners.get(listener);
    this.#approvalListeners.set(listener, onLost);
    try {
      const reply = await this.request({ type: "watch_approvals" });
      return approvalsOf(reply);
    } catch (error) {
      // A listener whose own watch failed is not left hearing through someone else's.
      if (added) this.#approvalListeners.delete(listener);
      else if (this.#approvalListeners.has(listener)) this.#approvalListeners.set(listener, before);
      throw error;
    }
  }

  /** Ends the watch for every listener, so none is left registered as if it still heard. */
  #loseApprovals(error: GatewayError): void {
    const lost = [...this.#approvalListeners.values()];
    this.#approvalListeners.clear();
    for (const onLost of lost) onLost?.(error);
  }

  #tellApprovals(reply: Accepted | Result): void {
    for (const approval of approvalsOf(reply)) {
      for (const listener of this.#approvalListeners.keys()) listener(approval);
    }
  }

  /** Subscribes each unfinished run again after its last `seq`, unless a command in flight covers it. */
  #resubscribe(): void {
    const covered = new Set<string>();
    for (const pending of [...this.#pending.values(), ...this.#waiting.keys()]) {
      if (pending.run !== undefined) covered.add(pending.run.requestId);
    }
    for (const run of this.#runs.values()) {
      if (run.done || covered.has(run.requestId)) continue;
      this.#dispatch({
        command: { type: "subscribe", requestId: run.requestId },
        run,
        added: false,
        resolve: () => {},
        reject: (error) => {
          run.fail(error);
          if (this.#runs.get(run.requestId) === run) this.#runs.delete(run.requestId);
        },
        attempts: 0,
      });
    }
  }
}

function approvalsOf(reply: Accepted | Result): ApprovalInfo[] {
  const data = (reply as Result).data as { approvals?: unknown } | undefined;
  return Array.isArray(data?.approvals) ? (data.approvals as ApprovalInfo[]) : [];
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
