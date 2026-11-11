import type { Accepted, EventMessage, RequestEvent } from "@officehum/protocol";

/** One event of a request, with its `seq` (the gateway's number for it, growing from 1). */
export type RunEvent = RequestEvent & { readonly seq: number };
/** How a request ended. */
export type Settled = Extract<RequestEvent, { kind: "settled" }>;

/**
 * One request as this client follows it. Events are kept in order and deduplicated by `seq`, so a
 * reconnect that replays some of them never shows one twice. `settled` is always taken, whatever its
 * `seq`: a restarted gateway numbers a request's events from 1 again, but the result still counts.
 */
export class Run {
  readonly requestId: string;
  /** How `submit` was taken; undefined for a run from `subscribe`. */
  disposition: Accepted["disposition"] | undefined;
  readonly #events: RunEvent[] = [];
  #lastSeq = 0;
  #settled: Settled | undefined;
  #failure: Error | undefined;
  #wake: (() => void)[] = [];

  constructor(requestId: string, disposition?: Accepted["disposition"]) {
    this.requestId = requestId;
    this.disposition = disposition;
  }

  /** The highest `seq` taken, for resuming with `afterSeq`. */
  get lastSeq(): number {
    return this.#lastSeq;
  }

  /** Whether the run has ended, with its result or a failure. */
  get done(): boolean {
    return this.#settled !== undefined || this.#failure !== undefined;
  }

  /** Takes an event for this request; false if it was already seen or the run is over. */
  push(message: EventMessage): boolean {
    if (this.done) return false;
    const { event, seq } = message;
    if (event.kind !== "settled" && seq <= this.#lastSeq) return false;
    this.#lastSeq = Math.max(this.#lastSeq, seq);
    this.#events.push({ ...event, seq });
    if (event.kind === "settled") this.#settled = event;
    this.#notify();
    return true;
  }

  /** Ends the run without a result: its events end with `error` and `settled()` rejects with it. */
  fail(error: Error): void {
    if (this.done) return;
    this.#failure = error;
    this.#notify();
  }

  /** Every event of the run from the first, then each new one as it arrives, ending after `settled`. */
  async *events(): AsyncGenerator<RunEvent, void, undefined> {
    let next = 0;
    for (;;) {
      while (next < this.#events.length) yield this.#events[next++] as RunEvent;
      if (this.#settled !== undefined) return;
      if (this.#failure !== undefined) throw this.#failure;
      await new Promise<void>((resolve) => this.#wake.push(resolve));
    }
  }

  /** The run's `settled` event, once it arrives. Aborted and failed runs resolve too, by `status`. */
  async settled(): Promise<Settled> {
    while (this.#settled === undefined) {
      if (this.#failure !== undefined) throw this.#failure;
      await new Promise<void>((resolve) => this.#wake.push(resolve));
    }
    return this.#settled;
  }

  #notify(): void {
    for (const wake of this.#wake.splice(0)) wake();
  }
}
