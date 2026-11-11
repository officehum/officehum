import {
  type Accepted,
  ERROR_CODES,
  type ErrorCode,
  type Result,
  validateMessage,
} from "@officehum/protocol";
import { backoffDelay, sleep } from "./backoff.js";
import { GatewayError } from "./errors.js";
import type { Run } from "./run.js";
import { type Outgoing, type Transport, type TransportOptions, tokenOf } from "./transport.js";

/**
 * The fallback for where a WebSocket cannot go: `POST /v1/submit`, and each run's events over
 * Server-Sent Events from `/v1/requests/:id/events`, resumed with `Last-Event-ID` after a drop. The
 * gateway's HTTP API has no route for the other commands, so they need the WebSocket transport.
 */
export class HttpTransport implements Transport {
  readonly #options: TransportOptions;
  readonly #base: string;
  readonly #retries: number;
  readonly #stop = new AbortController();
  readonly #following = new Set<Run>();

  constructor(options: TransportOptions) {
    this.#options = options;
    this.#base = options.url.replace(/\/$/, "");
    this.#retries = options.retries ?? 8;
  }

  async request(command: Outgoing, run?: Run): Promise<Accepted | Result> {
    if (this.#stop.signal.aborted) throw new Error("The gateway client is closed.");
    if (command.type === "submit") {
      const { type: _type, ...body } = command;
      const reply = await this.#retry(() =>
        this.#fetch("/v1/submit", { method: "POST", body: JSON.stringify(body) }),
      );
      const accepted = expect(reply, "accepted");
      if (run !== undefined) this.#follow(run);
      return accepted;
    }
    if (command.type === "subscribe") {
      const status = await this.#retry(() =>
        this.#fetch(`/v1/requests/${encodeURIComponent(command.requestId)}`, { method: "GET" }),
      );
      const settled = (status as { status?: unknown }).status === "settled";
      if (run !== undefined) this.#follow(run);
      return { type: "result", id: "http", ok: true, data: { settled } };
    }
    throw new Error(
      `${command.type} needs the WebSocket transport: the gateway's HTTP API has no route for it.`,
    );
  }

  async close(): Promise<void> {
    this.#stop.abort();
    const closed = new Error("The gateway client is closed.");
    for (const run of this.#following) run.fail(closed);
    this.#following.clear();
  }

  /** Sends again after `busy` or a network failure (safe: only `submit` and status come here). */
  async #retry(call: () => Promise<unknown>): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await call();
      } catch (error) {
        const transient =
          !(error instanceof GatewayError) || error.code === "busy" || error.code === "internal";
        if (!transient || attempt >= this.#retries || this.#stop.signal.aborted) throw error;
        await sleep(backoffDelay(attempt, this.#options.backoff));
      }
    }
  }

  async #fetch(path: string, init: RequestInit): Promise<unknown> {
    const response = await fetch(`${this.#base}${path}`, {
      ...init,
      signal: this.#stop.signal,
      headers: {
        authorization: `Bearer ${await tokenOf(this.#options.token)}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (response.ok) return body;
    throw errorFrom(body, response.status);
  }

  #follow(run: Run): void {
    if (this.#following.has(run) || run.done) return;
    this.#following.add(run);
    void this.#stream(run).finally(() => this.#following.delete(run));
  }

  /** Reads a run's event stream, reconnecting after the last `seq` until it settles. */
  async #stream(run: Run): Promise<void> {
    for (let attempt = 0; !run.done && !this.#stop.signal.aborted; ) {
      try {
        const response = await fetch(
          `${this.#base}/v1/requests/${encodeURIComponent(run.requestId)}/events`,
          {
            signal: this.#stop.signal,
            headers: {
              authorization: `Bearer ${await tokenOf(this.#options.token)}`,
              ...(run.lastSeq > 0 ? { "last-event-id": String(run.lastSeq) } : {}),
            },
          },
        );
        if (!response.ok || response.body === null) {
          throw errorFrom(await response.json().catch(() => undefined), response.status);
        }
        for await (const block of sseBlocks(response.body)) {
          attempt = 0;
          const data = block.data === undefined ? undefined : safeJson(block.data);
          const checked = validateMessage(data, "server");
          if (!checked.ok) continue;
          const message = checked.message;
          if (message.type === "event" && message.requestId === run.requestId) run.push(message);
          // `unauthorized` (the token expired) ends the stream; reconnecting asks for a fresh one.
          else if (message.type === "error" && message.code !== "unauthorized") {
            throw GatewayError.from(message);
          }
        }
      } catch (error) {
        if (this.#stop.signal.aborted) return;
        if (
          error instanceof GatewayError &&
          !["busy", "internal", "unauthorized"].includes(error.code)
        ) {
          run.fail(error);
          return;
        }
      }
      if (run.done) return;
      await sleep(backoffDelay(attempt++, this.#options.backoff));
    }
  }
}

function expect<T extends "accepted">(reply: unknown, type: T): Accepted {
  const checked = validateMessage(reply, "server");
  if (checked.ok && checked.message.type === type) return checked.message as Accepted;
  throw new GatewayError(
    "internal",
    `The gateway's reply was not ${type}: ${JSON.stringify(reply)}`,
  );
}

const STATUS_CODES: Record<number, ErrorCode> = {
  400: "invalid_message",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  503: "busy",
};

/** The gateway's error body as a `GatewayError`, or one made from the HTTP status. */
function errorFrom(body: unknown, status: number): GatewayError {
  const checked = validateMessage(body, "server");
  if (checked.ok && checked.message.type === "error") return GatewayError.from(checked.message);
  const code = (body as { code?: unknown } | undefined)?.code;
  return new GatewayError(
    (ERROR_CODES as readonly unknown[]).includes(code)
      ? (code as ErrorCode)
      : (STATUS_CODES[status] ?? "internal"),
    `The gateway answered HTTP ${status}.`,
  );
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The `id`, `event` and `data` fields of each Server-Sent Events block (LF-separated, as the gateway writes them). */
async function* sseBlocks(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ id?: string; event?: string; data?: string }> {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let end = buffer.indexOf("\n\n");
      while (end !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const fields: { id?: string; event?: string; data?: string } = {};
        for (const line of block.split("\n")) {
          const colon = line.indexOf(":");
          if (colon <= 0) continue;
          const name = line.slice(0, colon);
          const value = line.slice(colon + 1).replace(/^ /, "");
          if (name === "data")
            fields.data = fields.data === undefined ? value : `${fields.data}\n${value}`;
          else if (name === "id" || name === "event") fields[name] = value;
        }
        yield fields;
        end = buffer.indexOf("\n\n");
      }
      if (done) return;
    }
  } finally {
    // Stops the download when the reader leaves early (the run settled, or the client closed).
    await reader.cancel().catch(() => {});
  }
}
