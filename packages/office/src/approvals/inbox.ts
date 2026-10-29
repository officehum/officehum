/**
 * The Inbox: the approvals store read the way a screen or a Teams card needs it (RASF-3138).
 *
 * The store answers "what is waiting and what did a person say". The Inbox adds the context a person
 * needs to answer without opening anything else: which ticket, what it is about, where the work came
 * from, which agent is waiting, and for how long. All of that is read from the board — the ticket row
 * and its provenance — rather than denormalised onto the approval, because a title corrected on the
 * board should be corrected in the Inbox too, and a copy would go stale the moment somebody edited the
 * ticket.
 *
 * It is a plain module API, not a server: the Studio screen (RASF-3152), the Teams cards (RASF-3165)
 * and a CLI all call the same functions over the same board, so none of them can grow a different
 * notion of "pending". `decide` is here as well as on the store because the Inbox is where a person
 * decides; the store owns the write and its refusals, and this module adds the context back to the
 * answer it returns.
 */
import type {
  Approval,
  ApprovalDecisionInput,
  ApprovalFilter,
  ApprovalStatus,
  Board,
  Origin,
  Person,
} from "../board/index.js";

/** One waiting request, with the ticket context a person needs to decide it. */
export interface ApprovalInboxItem {
  readonly id: string;
  readonly ticketId: string;
  readonly ticketType: string;
  readonly ticketTitle: string;
  /** Where the ticket's work came from; null for a ticket the board has no provenance row for. */
  readonly origin: Origin | null;
  readonly sourceChannel: string | null;
  readonly tool: string;
  /** The arguments as the tool call carried them — exactly what the decision covers. */
  readonly args: unknown;
  /** The digest the gate matches on. Shown so two cards can be told apart at a glance. */
  readonly argsHash: string;
  /** The agent waiting on this decision, or null on a row written before requesters were recorded. */
  readonly requestedBy: string | null;
  /** The person the request is addressed to, or null when the office named nobody. */
  readonly awaiting: Person | null;
  readonly status: ApprovalStatus;
  readonly waitingSince: string;
  /** How long the request has been waiting, in milliseconds. Never negative. */
  readonly waitingForMs: number;
  readonly expiresAt: string | null;
}

/** One request with the ticket's own words about the work, for the screen that opens it. */
export interface ApprovalInboxDetail extends ApprovalInboxItem {
  /** The ticket's detail, or its title when nobody wrote one. */
  readonly summary: string;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly decidedNote: string | null;
}

export interface ApprovalInbox {
  /** Waiting requests, oldest first — the order a person should work through them. */
  list(filter?: ApprovalFilter): ApprovalInboxItem[];
  /** One request with its ticket's summary, whatever its status; `undefined` for no such id. */
  get(id: string): ApprovalInboxDetail | undefined;
  /** Record a person's decision and return the item as it now stands. */
  decide(id: string, decision: ApprovalDecisionInput): ApprovalInboxDetail;
}

export interface ApprovalInboxOptions {
  /** The clock "how long" is measured against. Tests move it; production leaves it alone. */
  readonly now?: () => number;
}

export function openApprovalInbox(board: Board, options: ApprovalInboxOptions = {}): ApprovalInbox {
  const clock = options.now ?? (() => Date.now());

  /** The ticket an approval is about. A missing one is a corrupted file, not a state the API makes. */
  const ticketOf = (approval: Approval) => {
    const ticket = board.get(approval.ticketId);
    if (ticket === undefined) {
      throw new Error(
        `Approval ${approval.id} points at ticket ${approval.ticketId}, which is gone.`,
      );
    }
    return ticket;
  };

  const itemOf = (approval: Approval): ApprovalInboxItem => {
    const ticket = ticketOf(approval);
    const provenance = board.provenance(approval.ticketId);
    return {
      id: approval.id,
      ticketId: approval.ticketId,
      ticketType: ticket.type,
      ticketTitle: ticket.title,
      origin: provenance?.origin ?? null,
      sourceChannel: provenance?.sourceChannel ?? null,
      tool: approval.tool,
      args: approval.args,
      argsHash: approval.argsHash,
      requestedBy: approval.requestedBy,
      awaiting:
        approval.assignee === null
          ? null
          : (board.people().find((person) => person.id === approval.assignee) ?? null),
      status: approval.status,
      waitingSince: approval.createdAt,
      waitingForMs: Math.max(0, clock() - Date.parse(approval.createdAt)),
      expiresAt: approval.expiresAt,
    };
  };

  const detailOf = (approval: Approval): ApprovalInboxDetail => {
    const ticket = ticketOf(approval);
    return {
      ...itemOf(approval),
      summary:
        ticket.detail === null || ticket.detail.trim().length === 0 ? ticket.title : ticket.detail,
      decidedBy: approval.decidedBy,
      decidedAt: approval.decidedAt,
      decidedNote: approval.decidedNote,
    };
  };

  const detailFor = (id: string): ApprovalInboxDetail | undefined => {
    const approval = board.approvals.approvalOf(id);
    return approval === undefined ? undefined : detailOf(approval);
  };

  return {
    list(filter = {}) {
      return board.approvals.pendingApprovals(filter).map(itemOf);
    },
    get: detailFor,
    decide(id, decision) {
      const approval = board.approvals.decideApproval(id, decision);
      return detailOf(approval);
    },
  };
}
