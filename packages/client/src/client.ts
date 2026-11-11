import type { ApprovalInfo, Approve, Result, Submit } from "@officehum/protocol";
import { HttpTransport } from "./http-transport.js";
import { Run } from "./run.js";
import type { Transport, TransportOptions } from "./transport.js";
import { WebSocketTransport } from "./websocket-transport.js";

export interface ConnectOptions extends TransportOptions {
  /** `websocket` (default) for every command; `http` for submit and streaming only. */
  readonly transport?: "websocket" | "http";
}

/** What `submit` takes: an agent, a `requestId` (required: it is what makes a retry safe), input. */
export type SubmitOptions = Omit<Submit, "type" | "id">;
export type ApproveOptions = Omit<Approve, "type" | "id">;

export interface AgentSummary {
  readonly name: string;
  readonly role?: string;
  readonly model: string;
  readonly tools: readonly { readonly name: string; readonly replay: "safe" | "unsafe" }[];
}
export interface AgentState extends AgentSummary {
  readonly status: "busy" | "idle";
  readonly openRequests: number;
}

/**
 * A connection to an office's gateway.
 *
 * ```ts
 * const client = await GatewayClient.connect({ url, token: () => getToken() });
 * const run = await client.submit({ agent: "frontdesk", requestId, input: { kind: "message", text } });
 * for await (const event of run.events()) { … }
 * ```
 *
 * The client re-sends nothing by itself except a `submit` or `subscribe` with the same `requestId`,
 * which the gateway answers with the stored request instead of running it again.
 */
export class GatewayClient {
  readonly #transport: Transport;
  /** Runs still in progress, so a repeated submit or subscribe shares one stream. */
  readonly #runs = new Map<string, Run>();

  private constructor(transport: Transport) {
    this.#transport = transport;
  }

  /** Connects and signs in. Over WebSocket this rejects with `unauthorized` for a bad token. */
  static async connect(options: ConnectOptions): Promise<GatewayClient> {
    const transport =
      options.transport === "http"
        ? new HttpTransport(options)
        : await WebSocketTransport.open(options);
    return new GatewayClient(transport);
  }

  /** Gives an agent work. Submitting a `requestId` again returns that request, not a new run. */
  async submit(options: SubmitOptions): Promise<Run> {
    const { run, created } = this.#runFor(options.requestId);
    try {
      const accepted = await this.#transport.request({ type: "submit", ...options }, run);
      if (accepted.type === "accepted") run.disposition = accepted.disposition;
      return run;
    } catch (error) {
      if (created) this.#drop(run);
      throw error;
    }
  }

  /** Follows a request submitted earlier (by this caller, from anywhere). */
  async subscribe(requestId: string): Promise<Run> {
    const { run, created } = this.#runFor(requestId);
    try {
      await this.#transport.request({ type: "subscribe", requestId }, run);
      return run;
    } catch (error) {
      if (created) this.#drop(run);
      throw error;
    }
  }

  /**
   * Decides an action waiting on approval, as the signed-in caller, and returns the approval as it
   * now stands. Rejects with `conflict` when someone decided it first, and `forbidden` when it is
   * outside what the caller may approve.
   */
  async approve(options: ApproveOptions): Promise<ApprovalInfo> {
    const reply = await this.#transport.request({ type: "approve", ...options });
    return ((reply as Result).data as { approval: ApprovalInfo }).approval;
  }

  /**
   * The approvals waiting for someone like the caller, then each one asked for or decided as it
   * happens, passed to `listener` (WebSocket only). After a reconnect the client watches again and
   * passes on whatever is waiting then.
   */
  async watchApprovals(
    listener: (approval: ApprovalInfo) => void,
  ): Promise<readonly ApprovalInfo[]> {
    return await this.#transport.watchApprovals(listener);
  }

  /** Stops a request; its run ends with `settled` and `status: "aborted"`. */
  async abort(requestId: string): Promise<void> {
    await this.#transport.request({ type: "abort", requestId });
  }

  async listAgents(): Promise<readonly AgentSummary[]> {
    return agentsOf(await this.#transport.request({ type: "list_agents" })) as AgentSummary[];
  }

  /** The office's agents with their status, or one agent's. */
  async getState(agent?: string): Promise<readonly AgentState[]> {
    return agentsOf(
      await this.#transport.request({
        type: "get_state",
        ...(agent === undefined ? {} : { agent }),
      }),
    ) as AgentState[];
  }

  async ping(): Promise<void> {
    await this.#transport.request({ type: "ping" });
  }

  /** Closes the connection; runs still open end with an error. */
  async close(): Promise<void> {
    await this.#transport.close();
  }

  /** The run already following `requestId`, or a new one (`created`) this call may drop on failure. */
  #runFor(requestId: string): { run: Run; created: boolean } {
    const known = this.#runs.get(requestId);
    if (known !== undefined && !known.done) return { run: known, created: false };
    const run = new Run(requestId);
    this.#runs.set(requestId, run);
    void run.settled().then(
      () => this.#drop(run),
      () => this.#drop(run),
    );
    return { run, created: true };
  }

  #drop(run: Run): void {
    if (this.#runs.get(run.requestId) === run && (run.done || run.lastSeq === 0)) {
      this.#runs.delete(run.requestId);
    }
  }
}

function agentsOf(reply: { type: string }): unknown[] {
  const data = (reply as Result).data as { agents?: unknown } | undefined;
  return Array.isArray(data?.agents) ? data.agents : [];
}
