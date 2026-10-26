/**
 * The relay's delivery guards, and the seam a later issue fills in (RASF-3067).
 *
 * The relay calls all three checks for every delivery, in order, and refuses closed: a thrown check
 * and a `{ allowed: false }` both stop the delivery, and nothing is submitted. `openGuards` allows
 * everything, so today the seam costs three calls and no policy — which is the point. The checks
 * arrive in RASF-3074 (budget) and RASF-3073 (approval); landing the calls now means a delivery path
 * cannot quietly exist that the checks were never wired into, and a test that injects a refusing
 * guard proves the wiring rather than the policy.
 *
 * The context carries the board's own columns (`budgets` ceilings and `hop_count`, `approvals`)
 * rather than resolved answers, because deciding is the guard's job: the relay hands over facts and
 * asks a yes/no question, and a fact it pre-decided would make a real check impossible to add.
 */

/** A yes/no answer with the reason a `no` carries onto the delivery's ledger row. */
export type GuardDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

/** The event as a guard sees it: identity and kind, not the message text. */
export interface GuardEvent {
  readonly id: string;
  readonly kind: string;
  readonly ticketId: string;
}

/** The ticket as a guard sees it: the board's row, whatever the delivery does with it. */
export interface GuardTicket {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly assignee: string | null;
}

/** Facts the relay passes to every check, so a real check needs no extra read. */
export interface GuardContext {
  /** Depth of the ticket in its delegation chain; 0 for a root. */
  readonly hop: number;
  /** The conversation key the delivery would use. */
  readonly conversationKey: string;
}

/**
 * The three checks, in the order the relay runs them. A later implementation reads its own board
 * rows; this interface is the contract, and adding a fourth check is a change to this file.
 */
export interface DeliveryGuards {
  /** Spend so far against the ticket's ceilings (RASF-3074). */
  checkBudget(
    event: GuardEvent,
    ticket: GuardTicket,
    context: GuardContext,
  ): Promise<GuardDecision>;
  /** Whether the ticket may take another delegation hop (the board's `max_hops` rule, surfaced). */
  checkHops(event: GuardEvent, ticket: GuardTicket, context: GuardContext): Promise<GuardDecision>;
  /** Whether an approval the ticket needs is in place (RASF-3073). */
  checkApproval(
    event: GuardEvent,
    ticket: GuardTicket,
    context: GuardContext,
  ): Promise<GuardDecision>;
}

/**
 * The guards as they stand: allow everything, refuse nothing. Deliberately permissive rather than
 * absent — the relay must call through the seam, and a no-op is a check that has been wired up and
 * not yet given a policy.
 */
export function openGuards(): DeliveryGuards {
  return {
    async checkBudget() {
      return { allowed: true };
    },
    async checkHops() {
      return { allowed: true };
    },
    async checkApproval() {
      return { allowed: true };
    },
  };
}
