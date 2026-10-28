/**
 * The budget's teeth: the mid-turn hooks and the refusal text (RASF-3141).
 *
 * Three seats enforce one number, and none of them is the prompt:
 *
 * - **The board is the authority.** `admitCall` counts a tool call and answers whether the ceiling
 *   allows it inside one `BEGIN IMMEDIATE`; `chargeUsage` adds tokens and cents exactly once per call
 *   id and rolls the deltas up to every ancestor. Two counters that can disagree are not a budget.
 * - **These hooks are the sensor and the gate.** `beforeTool` refuses a call the ceiling will not pay
 *   for; `afterTool` and `afterResponse` charge the spend they observe. In Pi Durable 1.3.0
 *   `beforeTool` is the one hook that can refuse a call before it runs (`{ block }`, or a throw), and
 *   the gate therefore lives there rather than in the prompt or in a wrapper around the tool.
 * - **The relay's door** (`boardGuards`) refuses a delivery to a ticket that is already spent, so an
 *   exhausted chain gets no further turn at all.
 *
 * What this cannot do, stated plainly:
 *
 * - A turn is billed after it finishes, so a token or dollar ceiling overruns by at most one turn. The
 *   next `beforeTool` sees the spend and refuses; the ceiling is not per token and no provider offers
 *   one.
 * - The turn that is already running may keep asking for tools. Every call is refused and the ticket is
 *   blocked, so the work cannot extend — but the model is not killed mid-turn, and a model that loops
 *   on refusals loops until its own turn ends.
 * - A tool that reports no usage (a deterministic worker, an engine) spends tokens nobody sees, which
 *   is why the *call* ceiling, not the token ceiling, is what fences it.
 *
 * The ticket a conversation is working comes from the board's `ticket_conversations` row, which the
 * relay writes when it opens a delivery. A conversation with no binding (a role's own root, an office
 * conversation outside the relay) spends nobody's budget and is left alone: this hook is a policy for
 * ticket work, not a tax on every conversation in the harness.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  GenerationTask,
  type HookApi,
  type HookRegistration,
  hook,
  type ToolHookCall,
  ToolTask,
} from "@earendil-works/pi-durable";
import { type Board, type Budget, budgetSpent, type ConversationTicket } from "../board/index.js";
import { centsFor, DEFAULT_PRICE_TABLE, formatCents, type PriceTable, tokensOf } from "./prices.js";

/** The actor a budget's block is recorded as. Not a role: this is the office itself. */
export const BUDGET_ACTOR = "budget";

/**
 * Why a ticket stopped, as the board records it.
 *
 * The numbers are the ticket's own spend and the ceilings it ran into, so a reader of the board can see
 * which limit closed the work without asking a model what it thought happened.
 */
export function spendRefusal(budget: Budget): string {
  const spent = budgetSpent(budget);
  const ceilings = spent.length === 0 ? "a ceiling" : `the ${spent.join(", ")} ceiling`;
  return (
    `budget reached (${budget.usedCalls} calls / ${budget.usedTokens} tokens / ` +
    `${formatCents(budget.usedUsdCents)} against ${ceilings})`
  );
}

/**
 * Block the ticket and hand it to a person. The board's `block` is idempotent, so every later refusal of
 * the same exhausted budget lands on the same one `blocked` event rather than appending a second.
 *
 * The person is the office's first — the same fallback the relay's routing uses — because the board has
 * no notion of "the owner of this ceiling". An office that knows no person still blocks: the reason is
 * on the board, and the missing hand-off is visible in the event instead of hidden.
 */
export function blockTicket(board: Board, ticketId: string, budget: Budget): void {
  const person = board.people()[0];
  board.block(ticketId, BUDGET_ACTOR, {
    reason: spendRefusal(budget),
    ...(person === undefined ? {} : { assignee: { kind: "person" as const, id: person.id } }),
  });
}

/**
 * The refusal, as the model is told it. Pi Durable wraps this in its own blocked result — the model sees
 * `Tool call blocked: <this>` as a tool error — so the sentence has to carry the whole story: what ran
 * out, that the ticket has left the harness, and that asking again is not a way forward.
 */
export function refusalText(budget: Budget, person: string | undefined): string {
  const handoff =
    person === undefined
      ? "This ticket is blocked, and this office knows no person to hand it to"
      : `This ticket is blocked and with ${person}`;
  return `${spendRefusal(budget)}. ${handoff}; do not retry, do not open children.`;
}

export interface BudgetHookOptions {
  /** The office's workboard: the authority over every number these hooks enforce. */
  readonly board: Board;
  /** The rate table tokens are converted with. Omitted: `DEFAULT_PRICE_TABLE`. */
  readonly prices?: PriceTable;
}

/** A charge as the board wants it: counts, never negative. */
type Charge = { readonly tokens: number; readonly usdCents: number };

/**
 * `budgetHooks({ board })` — the registrations an office installs on its roles' conversations.
 *
 * Two registrations, one per built-in task, because a hook matches a task by name: the tool task can
 * refuse a call, and the generation task can only report what a turn cost. Anything that needed a third
 * would be a second place that decides "spent", which is the drift this design exists to avoid.
 */
export function budgetHooks(options: BudgetHookOptions): readonly HookRegistration[] {
  const { board } = options;
  const prices = options.prices ?? DEFAULT_PRICE_TABLE;

  /**
   * The ticket and role a conversation is working, or `undefined` for a conversation with no ticket.
   *
   * A board that cannot answer throws, and the throw blocks the tool call: a guardrail that treats an
   * unreadable budget as permission is not a guardrail. Nothing is invented for a conversation the board
   * has never heard of — that is every conversation outside a delivery, and it spends nobody's budget.
   */
  const bound = (api: HookApi): ConversationTicket | undefined =>
    board.conversationTicket(api.conversationId);

  /** Charge spend to a ticket, once per call id. A zero charge writes no ledger row. */
  const charge = (ticket: ConversationTicket, callId: string, spend: Charge): void => {
    if (spend.tokens === 0 && spend.usdCents === 0) return;
    board.chargeUsage(ticket.ticketId, callId, { ...spend, agent: ticket.agent });
  };

  /** Refuse a call: block the ticket with a person, and tell the model why. */
  const refuse = (ticketId: string, budget: Budget): { block: string } => {
    blockTicket(board, ticketId, budget);
    return { block: refusalText(budget, board.people()[0]?.name) };
  };

  return [
    hook(ToolTask, {
      /**
       * The gate. One call costs one slot against the chain's call ceiling, and the board decides inside
       * its own transaction whether that slot exists — so two calls in a parallel round cannot both take
       * the last one.
       *
       * `admitCall` reads the ceiling before incrementing, so the call that would cross it is refused
       * without being counted and `used_calls` never runs past the ceiling. A replay of the same call id
       * is admitted without being counted again.
       */
      beforeTool(call, api) {
        const ticket = bound(api);
        if (ticket === undefined) return undefined;
        const budget = board.budget(ticket.ticketId);
        if (budget === undefined) return undefined;
        // Every ceiling is asked before the call: tokens and dollars are charged after the turn that
        // spent them, so this is where that spend is first seen.
        if (budgetSpent(budget).length > 0) return refuse(ticket.ticketId, budget);
        const admission = board.admitCall(ticket.ticketId, callKey(api, call), ticket.agent);
        if (admission.admitted) return undefined;
        return refuse(ticket.ticketId, admission.budget);
      },
      /**
       * A tool's own spend, when it reports any. Most do not: a deterministic worker answers from a
       * library, not a model. Tokens are counted and no cents are charged, because a tool's usage has no
       * model identity to look up — inventing a rate for it would be a number nobody wrote down.
       */
      afterTool(call, result, api) {
        const ticket = bound(api);
        if (ticket === undefined || result.usage === undefined) return undefined;
        charge(ticket, `${callKey(api, call)}:usage`, {
          tokens: tokensOf(result.usage),
          usdCents: 0,
        });
        return undefined;
      },
    }),
    hook(GenerationTask, {
      /**
       * Every terminal provider message, before classification: a turn's tokens and its cents, charged to
       * the ticket this conversation is working. The whole turn is one charge, keyed on the response's own
       * identity so observing the same response twice adds nothing.
       *
       * This runs after the response exists, which is the honest limit of the token and dollar ceilings:
       * the next `beforeTool` sees the spend and refuses. One turn of overrun, no more.
       */
      afterResponse(message, api) {
        const ticket = bound(api);
        if (ticket === undefined) return undefined;
        const tokens = tokensOf(message.usage);
        if (tokens === 0) return undefined;
        charge(ticket, turnKey(api, message), {
          tokens,
          usdCents: centsFor(
            prices,
            { provider: message.provider, modelId: message.model },
            message.usage,
          ),
        });
        return undefined;
      },
    }),
  ];
}

/**
 * A call's identity on the ledger: the conversation, the word `tool`, and Pi Durable's own call id.
 *
 * The call id is what makes dedupe correct: a replayed attempt carries the same one and is not charged
 * twice, while a re-executed turn mints fresh ids and is charged again — which is honest, because both
 * executions really did run.
 */
function callKey(api: HookApi, call: ToolHookCall): string {
  return `${api.conversationId}:tool:${call.id}`;
}

/**
 * A model turn's identity on the ledger: the conversation, the word `turn`, and the best identity the
 * response carries.
 *
 * The provider's own response id when there is one. Faux and some providers give none, so the fallback
 * is the timestamp *plus* the token count — the same turn re-observed carries both, and two different
 * turns cannot: a turn's prompt contains everything before it, so the count moves. Two turns that agreed
 * on timestamp, tokens and stop reason would be indistinguishable to any reader of the transcript, and
 * they would be charged once; that is the one under-charge this design accepts, taken in exchange for
 * never billing a replayed observation twice.
 */
function turnKey(api: HookApi, message: AssistantMessage): string {
  const identity =
    message.responseId ?? `${message.timestamp}:${tokensOf(message.usage)}:${message.stopReason}`;
  return `${api.conversationId}:turn:${identity}`;
}
