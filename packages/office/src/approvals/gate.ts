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
 * - the tool is not declared to need a person → allow.
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
 * The tool set is passed in rather than guessed. `officehum.json` already says which tools wait for a
 * person — the manifest's `approvals[].tool` — and `registerOfficeHooks` reads that list. A gate that
 * invented its own list would be a second, unstated policy.
 */
import { type HookRegistration, hook, ToolTask } from "@earendil-works/pi-durable";
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
  /** The tools that wait for a person. Empty registers a gate that allows everything, so pass what is declared. */
  readonly gatedTools: readonly string[];
  /** How long a request waits for a decision. Omitted: until someone decides or the ticket is cancelled. */
  readonly ttlMs?: number;
}

/** The registration an office installs for the approval gate. One task: only `beforeTool` can refuse. */
export function approvalHooks(options: ApprovalHookOptions): readonly HookRegistration[] {
  const { board } = options;
  const gated = new Set(options.gatedTools);

  return [
    hook(ToolTask, {
      beforeTool(call, api) {
        try {
          const ticket = board.conversationTicket(api.conversationId);
          if (ticket === undefined) return undefined;
          if (!gated.has(call.name)) return undefined;
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
