/**
 * Ticket confirmations over the gateway (RASF-3574).
 *
 * A ticket whose type asks for a person waits on the board, `awaiting_confirmation`, with a request
 * in the board's Inbox (RASF-3230). This module shows those requests to the gateway's approvers as
 * approvals, beside the ones the roles' gates ask (`./approvals.ts`), and routes an approver's answer
 * to the board. It keeps no record of its own: the board's request is the request, so a restart
 * lists exactly what the board still holds, and an answer given somewhere else — `officehum board`
 * in a terminal — is seen here and announced like any other.
 *
 * Two differences from a gated tool call, both deliberate:
 * - **No deadline.** A gated call times out and is declined, because a run is waiting on it. Nothing
 *   runs while a ticket waits, and timing a confirmation out would wake the agent to redo work nobody
 *   found fault with. So a confirmation carries no `expiresAt` and waits until someone answers.
 * - **No amount, and no limit check.** An approval limit caps what a person may spend. Confirming a
 *   ticket spends nothing: the tools that did the work were gated when they ran.
 */
import type { ApprovalInfo, Principal } from "@officehum/protocol";
import { AGENT_REPLY } from "@officehum/sdk";
import { type Approval, type Board, BoardError, COMPLETION_APPROVAL_ID } from "../board/index.js";
import { RuntimeError } from "./errors.js";

/** The prefix that tells a confirmation's approval id from a gated call's (`<task>:<call>:<id>`). */
const PREFIX = "ticket-confirmation:";

/** How often the board is checked for confirmations asked or answered, in milliseconds. */
const POLL_MS = 250;

export interface TicketConfirmationsOptions {
  readonly board: Board;
  /** Tells the gateway a confirmation was asked for or answered. */
  readonly broadcast: (approval: ApprovalInfo) => void;
  readonly log: (line: string) => void;
}

export interface TicketConfirmations {
  /** Whether an `approve` command's id names a confirmation, so the runtime knows where to send it. */
  owns(approvalId: string): boolean;
  /** Every confirmation still waiting, oldest first. */
  pending(): ApprovalInfo[];
  /**
   * Records a principal's answer on the board: yes completes the ticket, no returns it to the agent
   * with the note. Refuses with `not_found` for no such confirmation and `conflict` once answered.
   */
  decide(
    principal: Principal,
    approvalId: string,
    decision: "approve" | "decline",
    note?: string,
  ): ApprovalInfo;
  /** Announces what is waiting, then watches the board until `stop`. */
  start(): void;
  stop(): void;
}

function infoOf(approval: Approval): ApprovalInfo {
  // The board's own endings without a person (the ticket was cancelled) read as declined here: the
  // protocol has three states, and what the approver needs to know is that there is nothing to answer.
  const status =
    approval.status === "waiting"
      ? "pending"
      : approval.status === "approved"
        ? "approved"
        : "declined";
  return {
    approvalId: `${PREFIX}${approval.id}`,
    agent: approval.requestedBy ?? "office",
    tool: approval.tool,
    summary: approval.facts?.summary ?? `Confirm ticket ${approval.ticketId} is done`,
    status,
    requestedAt: approval.createdAt,
    ...(approval.decidedBy === null ? {} : { by: approval.decidedBy }),
    ...(approval.decidedAt === null ? {} : { decidedAt: approval.decidedAt }),
    ...(approval.decidedNote === null ? {} : { note: approval.decidedNote }),
  };
}

export function openTicketConfirmations(options: TicketConfirmationsOptions): TicketConfirmations {
  const { board, broadcast, log } = options;
  /** The board ids of the confirmations the gateway has been told are waiting. */
  const announced = new Set<string>();
  let cursor = -1;
  let timer: ReturnType<typeof setInterval> | undefined;

  const waiting = (): Approval[] =>
    board.approvals
      .pendingApprovals({ tool: AGENT_REPLY.name, limit: 500 })
      .filter((approval) => approval.approvalId === COMPLETION_APPROVAL_ID);

  /** Tells the gateway of every confirmation asked or answered since the last look. */
  const sync = (): void => {
    const seq = board.lastEventSeq();
    if (seq === cursor) return;
    cursor = seq;
    const now = waiting();
    const open = new Set(now.map((approval) => approval.id));
    for (const id of announced) {
      if (open.has(id)) continue;
      announced.delete(id);
      const settled = board.approvals.approvalOf(id);
      if (settled !== undefined) broadcast(infoOf(settled));
    }
    for (const approval of now) {
      if (announced.has(approval.id)) continue;
      announced.add(approval.id);
      broadcast(infoOf(approval));
    }
  };

  return {
    owns: (approvalId) => approvalId.startsWith(PREFIX),
    pending: () => waiting().map(infoOf),
    decide(principal, approvalId, decision, note) {
      const id = approvalId.slice(PREFIX.length);
      const asked = board.approvals.approvalOf(id);
      if (asked === undefined || asked.approvalId !== COMPLETION_APPROVAL_ID) {
        throw new RuntimeError("not_found", `No approval ${approvalId} is known to this office.`);
      }
      let decided: Approval;
      try {
        decided = board.approvals.decideApproval(id, {
          by: principal.id,
          decision: decision === "approve" ? "approved" : "declined",
          ...(note === undefined ? {} : { note }),
        });
      } catch (error) {
        if (!(error instanceof BoardError)) throw error;
        if (error.kind === "immutable" || error.kind === "invalid_status") {
          throw new RuntimeError("conflict", error.message);
        }
        throw new RuntimeError("invalid_message", error.message);
      }
      // Announced here, in the answer's own turn, so the watcher does not announce it a second time.
      announced.delete(id);
      const info = infoOf(decided);
      broadcast(info);
      log(`Ticket ${decided.ticketId} ${info.status} by ${principal.id}.`);
      return info;
    },
    start() {
      sync();
      timer = setInterval(() => {
        try {
          sync();
        } catch (error) {
          log(`Could not read the board's confirmations: ${String(error)}`);
        }
      }, POLL_MS);
      // The watcher must not keep a stopping process alive on its own.
      (timer as { unref?: () => void }).unref?.();
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
