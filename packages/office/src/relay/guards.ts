/**
 * The relay's delivery guards, and the seam a later issue fills in (RASF-3067).
 *
 * The relay calls all three checks for every delivery, in order, and refuses closed: a thrown check
 * and a `{ allowed: false }` both stop the delivery, and nothing is submitted. The checks arrive in
 * RASF-3141 (budget and hops) and RASF-3073 (approval); landing the calls now means a delivery path
 * cannot quietly exist that the checks were never wired into, and a test that injects a refusing
 * guard proves the wiring rather than the policy.
 *
 * The context carries the board's own columns (`budgets` ceilings and `hop_count`, `approvals`)
 * rather than resolved answers, because deciding is the guard's job: the relay hands over facts and
 * asks a yes/no question, and a fact it pre-decided would make a real check impossible to add.
 */
import type { Board } from "../board/index.js";
import { budgetSpent } from "../board/index.js";
import { blockTicket, spendRefusal } from "../spend/budget.js";

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
  /** Spend so far against the ticket's ceilings (RASF-3141). */
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
 *
 * This is what a caller gets when it has no board to check against, such as a relay test that is only
 * about routing. An office that holds a board passes `boardGuards({ board })` instead, and the two
 * cannot be confused at the call site because one names the board it reads.
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

export interface BoardGuardOptions {
  /** The office's workboard: the ceilings, the spend and the hop columns are all its rows. */
  readonly board: Board;
}

/**
 * The guard set RASF-3141 fills in: the budget and the hop limit, both from the board's own columns,
 * plus the approval seat left open for RASF-3073.
 *
 * This is the door, not the teeth. `budgetHooks` refuses a call inside a running turn; this refuses a
 * delivery before a turn starts, which is what makes exhaustion durable — an exhausted or blocked
 * ticket never reaches an agent again, however the event arrived and whether or not the process
 * restarted in between.
 *
 * A refusal here is *recorded*, not merely returned: the ticket is blocked with a person, so a reader
 * of the board sees a stopped chain rather than a delivery row that says `failed` for a reason only the
 * log remembers. Budgets and hops end the same way, in the same place, which is the "uniform exhaustion
 * outcome" the plan asks for.
 *
 * `checkHops` reads `hop_count`/`max_hops` and nothing else. There is no second counter here: the board
 * refuses the `max+1`-th agent child at `create`, and re-counting hops in the guard would be the drift
 * the plan warns about. `hop_count == max_hops` is still allowed, past it is not.
 *
 * `checkApproval` stays a no-op: RASF-3073 owns approvals outright, and this issue touches neither the
 * `approvals` table nor the approver seam.
 */
export function boardGuards(options: BoardGuardOptions): DeliveryGuards {
  const { board } = options;
  return {
    async checkBudget(_event, ticket) {
      // A ticket that has left the harness does not come back for a comment, whatever its numbers say.
      if (ticket.status === "blocked") {
        return { allowed: false, reason: "the ticket is blocked and with a person" };
      }
      const budget = board.budget(ticket.id);
      if (budget === undefined) return { allowed: true };
      if (budgetSpent(budget).length === 0) return { allowed: true };
      blockTicket(board, ticket.id, budget);
      return { allowed: false, reason: `${spendRefusal(budget)}; no agent turn ran` };
    },
    async checkHops(_event, ticket) {
      const budget = board.budget(ticket.id);
      if (budget === undefined) return { allowed: true };
      if (budget.hopCount <= budget.maxHops) return { allowed: true };
      blockTicket(board, ticket.id, budget);
      return {
        allowed: false,
        reason: `delegation is exhausted at ${budget.maxHops} hops; this delivery is past it`,
      };
    },
    async checkApproval() {
      return { allowed: true };
    },
  };
}
