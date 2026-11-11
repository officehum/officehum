/**
 * Connection limits (RASF-3559): how many connections the gateway holds at once, so one caller cannot
 * exhaust it.
 *
 * Every connection takes a lease when it arrives: WebSockets, event streams, and other HTTP requests
 * while they run (`/healthz` excepted, so a load balancer can always ask). A lease counts against its
 * remote address and the total. Once the connection is signed in as a principal, WebSockets and event
 * streams count against that principal too. A lease is released when the connection ends.
 */

import type { ConnectionLimitsConfig } from "./config.js";

/** Why a connection was refused: `status` is 429 for a principal's or an address's limit, 503 for the total. */
export interface Refusal {
  readonly status: 429 | 503;
  readonly scope: "principal" | "address" | "total";
  readonly message: string;
}

export interface Lease {
  /**
   * Counts the connection against a principal; a refusal when that principal already holds its
   * limit. Assigning again (signing in as someone else) moves the count.
   */
  assign(principalId: string): Refusal | undefined;
  /** Ends the lease. Safe to call more than once. */
  release(): void;
}

export class ConnectionLimits {
  readonly #limits: ConnectionLimitsConfig;
  readonly #byAddress = new Map<string, number>();
  readonly #byPrincipal = new Map<string, number>();
  #total = 0;

  constructor(limits: ConnectionLimitsConfig) {
    this.#limits = limits;
  }

  /** A lease for a new connection from `address`, or why it is refused. */
  open(address: string): { readonly lease: Lease } | { readonly refusal: Refusal } {
    if (this.#total >= this.#limits.total) {
      return {
        refusal: {
          status: 503,
          scope: "total",
          message: "The gateway is at its connection limit; try again shortly.",
        },
      };
    }
    if ((this.#byAddress.get(address) ?? 0) >= this.#limits.perAddress) {
      return {
        refusal: {
          status: 429,
          scope: "address",
          message: `Too many connections from your address (the limit is ${this.#limits.perAddress}); close one and try again.`,
        },
      };
    }
    this.#total++;
    increment(this.#byAddress, address);
    let principal: string | undefined;
    let released = false;
    const lease: Lease = {
      assign: (principalId) => {
        if (released || principal === principalId) return undefined;
        if ((this.#byPrincipal.get(principalId) ?? 0) >= this.#limits.perPrincipal) {
          return {
            status: 429,
            scope: "principal",
            message: `You have too many connections open (the limit is ${this.#limits.perPrincipal}); close one and try again.`,
          };
        }
        if (principal !== undefined) decrement(this.#byPrincipal, principal);
        principal = principalId;
        increment(this.#byPrincipal, principalId);
        return undefined;
      },
      release: () => {
        if (released) return;
        released = true;
        this.#total--;
        decrement(this.#byAddress, address);
        if (principal !== undefined) decrement(this.#byPrincipal, principal);
      },
    };
    return { lease };
  }

  /** Current counts, for tests and operators. */
  counts(): { total: number; addresses: number; principals: number } {
    return {
      total: this.#total,
      addresses: this.#byAddress.size,
      principals: this.#byPrincipal.size,
    };
  }
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function decrement(map: Map<string, number>, key: string): void {
  const next = (map.get(key) ?? 1) - 1;
  if (next <= 0) map.delete(key);
  else map.set(key, next);
}
