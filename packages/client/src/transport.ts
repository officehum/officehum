import type { Accepted, ApprovalInfo, ClientCommand, Result } from "@officehum/protocol";
import type { BackoffOptions } from "./backoff.js";
import type { Run } from "./run.js";

/** A command as the client builds it; the transport gives it its `id`. */
export type Outgoing = ClientCommand extends infer C
  ? C extends unknown
    ? Omit<C, "id">
    : never
  : never;

/** The token to sign in with: a string, or a function asked again on every (re)connect. */
export type TokenSource = string | (() => string | Promise<string>);

export interface TransportOptions {
  /** The gateway's base URL, `http(s)://host:port`. */
  readonly url: string;
  readonly token: TokenSource;
  /** Names this software in `hello`. Default `officehum-client`. */
  readonly client?: string;
  readonly backoff?: BackoffOptions;
  /** How many times a `submit` or `subscribe` answered `busy` is sent again. Default 8. */
  readonly retries?: number;
}

/** How the client reaches a gateway: WebSocket, or the HTTP/SSE fallback. */
export interface Transport {
  /**
   * Sends a command and resolves with its reply. A command that has a run (`submit`, `subscribe`)
   * also delivers that request's events to the run until it is done, across reconnects.
   */
  request(command: Outgoing, run?: Run): Promise<Accepted | Result>;
  /**
   * Starts hearing of approvals the caller may decide: resolves with those waiting now, then calls
   * `listener` for each one asked for or decided, across reconnects.
   */
  watchApprovals(listener: (approval: ApprovalInfo) => void): Promise<readonly ApprovalInfo[]>;
  close(): Promise<void>;
}

export const tokenOf = async (token: TokenSource): Promise<string> =>
  typeof token === "string" ? token : await token();

/** Only these are re-sent without the caller: repeating the same `requestId` is safe. */
export const retryable = (command: Outgoing) =>
  command.type === "submit" || command.type === "subscribe";
