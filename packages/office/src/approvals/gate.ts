/**
 * The office's approval gate: a `beforeTool` hook that will not run a gated call until a person has
 * approved exactly those arguments (RASF-3138).
 *
 * This is the office's own seat, and it is deliberately not the SDK's `approvalGate`. That gate asks an
 * approver and keeps the answer in the tool task's memo, which is durable for the length of the task
 * and no longer. This one reads the board, where a decision lives for as long as the office does: a
 * decision made while the process was down, from a Teams card or an Inbox screen, is the same fact to
 * this hook as one made a second ago.
 *
 * The hook is the last word before a tool runs, so every path is explicit:
 *
 * - no ticket bound to the conversation → allow. There is nothing to record an approval against, and
 *   this is a policy for ticket work, not a tax on every conversation in the harness. It is the same
 *   rule `budgetHooks` follows.
 * - no declaration applies to this call → allow, and write nothing. A declaration applies when its
 *   `tool` is the call's and its `when` holds for the call's arguments; one with no `when` applies to
 *   every call of its tool. A small invoice and an undiscounted booking are calls the role itself says
 *   do not need a person, and a gate that gated them anyway would be a stricter policy than the one
 *   the manifest states (RASF-3439).
 * - covered — a granted decision on the board for this ticket, this tool and this exact arguments hash
 *   → allow.
 * - settled against it — a person declined these arguments, or the ticket was cancelled — block and say
 *   so. Asking again is the same question to the same person about the same call, and a model that
 *   retried every turn would write a row per turn.
 * - otherwise → record the request once and block. The model is told which person has been asked and
 *   that retrying is not the way through, because the answer arrives as a decision, not as a second
 *   attempt.
 * - anything throws → block. A check that could not be completed is not a yes.
 *
 * The declarations and the limits are passed in rather than guessed. `officehum.json` already says
 * which tools wait for a person, under which conditions — the manifest's `approvals` and its named
 * `limits` — and `registerOfficeHooks` reads both. A gate that invented its own policy would be a
 * second, unstated one.
 */

import { type HookRegistration, hook, ToolTask } from "@earendil-works/pi-durable";
import { type ApprovalDeclaration, conditionsHold } from "@officehum/sdk";
import { type Approval, argsHash, type Board, type Person } from "../board/index.js";

/** Why a call was blocked because a person has been asked. Exported so tests assert the sentence. */
export function approvalAskedText(tool: string, person: Person | undefined): string {
  const asked =
    person === undefined
      ? "This office knows no person to ask, and the request is on the record"
      : `${person.name} has been asked, and the request is on the record`;
  return (
    `${tool} was not run: it needs a person's approval for exactly these arguments. ${asked}. ` +
    "Do not retry this call; the answer arrives as a decision, not as another attempt."
  );
}

/** Why a call was blocked because the check itself failed. */
export function approvalUncheckedText(tool: string): string {
  return (
    `${tool} was not run: the office could not check whether these arguments are approved, ` +
    "and a call that cannot be checked is not run. Tell the user; do not retry this call."
  );
}

/**
 * Why a call was blocked because a person already answered no, or the work was called off. Asking
 * again is the one thing this must not invite: the decision is on the record and it was about these
 * exact arguments.
 */
export function approvalSettledText(tool: string, approval: Approval): string {
  if (approval.status === "cancelled") {
    return (
      `${tool} was not run: the request for these exact arguments was cancelled when the ticket was ` +
      "cancelled. Do not retry this call."
    );
  }
  const by = approval.decidedBy === null ? "A person" : approval.decidedBy;
  const note = approval.decidedNote === null ? "" : `: ${approval.decidedNote}`;
  return (
    `${tool} was not run: ${by} declined these exact arguments${note}. The decision stands, so ` +
    "asking again will not change it; do the work another way or tell the user."
  );
}

export interface ApprovalHookOptions {
  /** The office's workboard: the durable record of what was asked and what a person decided. */
  readonly board: Board;
  /**
   * What waits for a person: the manifest's `approvals`, id, tool and optional `when` intact. Empty
   * registers a gate that allows everything, so pass what is declared.
   */
  readonly declarations: readonly ApprovalDeclaration[];
  /**
   * The role's resolved named limits, e.g. `{ large_invoice: 2500 }`, which a condition written as
   * `{ "limit": "large_invoice" }` is compared against. Omitted: no limit resolves, and
   * `conditionsHold`'s fail-safe makes the declaration hold, so the call waits for a person.
   */
  readonly limits?: Readonly<Record<string, number>>;
  /** How long a request waits for a decision. Omitted: until someone decides or the ticket is cancelled. */
  readonly ttlMs?: number;
}

/**
 * The declaration that puts this call in front of a person, or `undefined` when the role declares
 * none that applies to it.
 *
 * Evaluated in declaration order, and the first that applies is the one reported: a manifest that
 * declares two approvals on one tool — `confirm_booking` and `discount_booking` on
 * `book_appointment` — resolves to the one the author wrote first, on every run, rather than to
 * whichever a sort or a map iteration happened to yield. The order is the manifest's own, which is
 * why the list is never sorted here.
 *
 * A declaration with no `when` applies to every call of its tool: that is the existing, unchanged
 * meaning of declaring an approval without a condition. A conditional one applies only when
 * `conditionsHold(declaration.when, args, limits)` — the SDK's one evaluator, the same one the role's
 * own gate uses, so the office and a bare harness cannot disagree about what a condition means.
 */
function applyingDeclaration(
  declarations: readonly ApprovalDeclaration[],
  tool: string,
  args: Readonly<Record<string, unknown>>,
  limits: Readonly<Record<string, number>>,
): ApprovalDeclaration | undefined {
  for (const declaration of declarations) {
    if (declaration.tool !== tool) continue;
    if (declaration.when === undefined) return declaration;
    if (conditionsHold(declaration.when, args, limits)) return declaration;
  }
  return undefined;
}

/** The registration an office installs for the approval gate. One task: only `beforeTool` can refuse. */
export function approvalHooks(options: ApprovalHookOptions): readonly HookRegistration[] {
  const { board } = options;
  const limits = options.limits ?? {};

  return [
    hook(ToolTask, {
      beforeTool(call, api) {
        try {
          const ticket = board.conversationTicket(api.conversationId);
          if (ticket === undefined) return undefined;
          const declaration = applyingDeclaration(
            options.declarations,
            call.name,
            call.arguments,
            limits,
          );
          // Nothing the role declares applies to these arguments: the call is one it allows itself,
          // so it runs and leaves no row. This is the path a small invoice takes.
          if (declaration === undefined) return undefined;
          const hash = argsHash(call.arguments);
          if (board.approvals.approvalCovering(ticket.ticketId, call.name, hash) !== undefined) {
            return undefined;
          }
          // A person already said no to exactly this, or the ticket was cancelled under it. Asking
          // again is not a way forward, and a model that retried every turn would otherwise grow the
          // inbox one row per turn — the flood the waiting dedupe prevents, arriving a step later.
          const settled = board.approvals.latestForCall(ticket.ticketId, call.name, hash);
          if (
            settled !== undefined &&
            (settled.status === "declined" || settled.status === "cancelled")
          ) {
            return { block: approvalSettledText(call.name, settled) };
          }
          // The person is the office's first, the same fallback the relay and the budget block use:
          // the board has no notion of "the owner of this tool", and a request addressed to nobody is
          // a request nobody opens. A later issue's routing can address a better person; this one
          // records the ask, which is what makes the wait visible at all.
          const person = board.people()[0];
          board.approvals.requestApproval(ticket.ticketId, {
            tool: call.name,
            // The declaration, not the tool: `approval_id` says which stated policy the row is
            // about, and the tool is already its own column. Every writer of a row — the gate, the
            // eval runner's scripted decision — names a declared id, so the column has one meaning.
            approvalId: declaration.id,
            args: call.arguments,
            requestedBy: ticket.agent,
            ...(person === undefined ? {} : { assignee: person.id }),
            ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
          });
          return { block: approvalAskedText(call.name, person) };
        } catch {
          // The board is unreadable, the arguments are not JSON, the write failed: none of those is
          // permission. Failing closed is the only answer that cannot approve an unapproved call.
          return { block: approvalUncheckedText(call.name) };
        }
      },
    }),
  ];
}
