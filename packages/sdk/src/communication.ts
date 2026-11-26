/**
 * The agent communication tools' shared contract: `agent_dispatch`, `agent_inbox` and `agent_reply`
 * as a model sees them — their names, descriptions, parameters and replay policies — and the words
 * they answer with. A host's own board implements them, and so does the local board here
 * (`./local-board.ts`, for a standalone Pi Durable harness). Both build their tools from these
 * definitions, so a role behaves the same on either.
 */

import { arr, bool, map, obj, opt, str, unknown } from "@earendil-works/pi-schema";
import type { AgentManifest } from "./manifest.js";

/** The three tool names. Reserved for the Office: a role may not declare them. */
export const COMMUNICATION_TOOL_NAMES = ["agent_dispatch", "agent_inbox", "agent_reply"] as const;

export const AGENT_DISPATCH = {
  name: "agent_dispatch",
  description:
    "Hand a piece of work to the colleague who accepts its ticket type. Work goes by type, never by role name. Set wait to true to wait for the colleague's result and return it. After a restart interrupted a dispatch, a dispatch of the same type returns that earlier ticket instead of opening another, unless separate_request is true.",
  parameters: obj({
    type: str({
      description:
        "The ticket type to dispatch, e.g. invoice.create. The team section lists the ones this office accepts.",
    }),
    title: str({ description: "One line naming the work." }),
    detail: str({ description: "What the colleague needs to know to do it." }),
    payload: opt(
      unknown({
        description: "Structured data for the ticket, such as ids and amounts.",
      }),
    ),
    wait: opt(
      bool({
        description:
          "Wait for the ticket to finish and return the colleague's result. Default false: dispatch and carry on.",
      }),
    ),
    separate_request: opt(
      bool({
        description:
          "Set to true only when this is a new request and not a retry of the hand-off the previous result named.",
      }),
    ),
    about: opt(
      arr(str(), {
        maxItems: 10,
        description:
          "Who the work is about, as memory subjects like customer:quickbooks:42: only a customer or vendor one of your tools looked up in this conversation. Leave out otherwise.",
      }),
    ),
  }),
  replay: "unsafe",
} as const;

export const AGENT_INBOX = {
  name: "agent_inbox",
  description:
    "Read the tickets waiting for you, and the answers to the tickets you opened. Filter by status when you only care about one kind. This reads; it changes nothing.",
  parameters: obj({
    status: opt(
      str({
        description:
          "Only tickets in this state: open, claimed, waiting, awaiting_confirmation, blocked, done or cancelled.",
      }),
    ),
  }),
  replay: "safe",
} as const;

export const AGENT_REPLY = {
  name: "agent_reply",
  description:
    "Finish a ticket you are working on and report the result. Use the ticket id from the message that delivered it.",
  parameters: obj({
    ticketId: str({ description: "The id of the ticket you are finishing." }),
    result: str({ description: "What you did, or what you found." }),
    files: opt(
      map(str(), {
        description:
          "Files this kind of ticket asks for before it is done, as name → file id. Leave out when it asks for none.",
      }),
    ),
  }),
  replay: "unsafe",
} as const;

/** What a refused communication tool call returns. */
export function communicationError(text: string): {
  readonly isError: true;
  readonly output: { readonly type: "text"; readonly text: string }[];
} {
  return { isError: true, output: [{ type: "text", text }] };
}

/** A board's refusal, in the words both hosts use: `kind` is the board's reason, such as `unauthorized`. */
export function refusalText(action: string, kind: string, message: string): string {
  return `The board refused the ${action} (${kind}): ${message}`;
}

/**
 * `ticket type → role id`, read from the installed manifests, this agent's own manifest excluded: a
 * role accepts a type or hands it off, never both, so the types worth dispatching belong to others.
 * Sorted by role, so the list in an error is the same on every run.
 */
export function dispatchTargets(
  manifests: readonly AgentManifest[],
  role: string,
): Map<string, string> {
  const byType = new Map<string, string>();
  for (const manifest of [...manifests].sort((left, right) => left.id.localeCompare(right.id))) {
    if (manifest.id === role) continue;
    for (const accept of manifest.accepts) {
      if (!byType.has(accept.type)) byType.set(accept.type, manifest.id);
    }
  }
  return byType;
}

/**
 * The `team` section: the colleagues and the ticket types they accept, each with its manifest's
 * description, in a stable order, then any `extra` lines (the office's person routes). Undefined when
 * there is nobody to list.
 */
export function teamText(
  manifests: readonly AgentManifest[],
  role: string,
  extra: readonly string[] = [],
): string | undefined {
  const colleagues = [...manifests]
    .filter((manifest) => manifest.id !== role)
    .sort((left, right) => left.id.localeCompare(right.id));
  if (colleagues.length === 0 && extra.length === 0) return undefined;
  return [
    "Your colleagues. Hand work on with agent_dispatch by ticket type, never by role name:",
    "",
    ...colleagues.map(
      (manifest) => `- ${manifest.name} (${manifest.id}): ${acceptedList(manifest)}`,
    ),
    ...extra,
  ].join("\n");
}

/** `invoice.create — Invoice a completed job; …`, or a note when the role accepts nothing. */
function acceptedList(manifest: AgentManifest): string {
  if (manifest.accepts.length === 0) return "accepts nothing";
  return manifest.accepts.map((accept) => `${accept.type} — ${accept.description}`).join("; ");
}

/** Why a dispatch of a type nobody takes was refused, naming what the office does take. */
export function unknownTypeText(
  type: string,
  accepted: ReadonlyMap<string, string>,
  personTypes: readonly string[] = [],
): string {
  const roles =
    accepted.size === 0
      ? "no other role is installed, so no role takes any ticket type"
      : `roles accept ${[...accepted.keys()].join(", ")}`;
  const people = personTypes.length === 0 ? "" : `; people take ${personTypes.join(", ")}`;
  return `No role accepts ticket type "${type}" and no person route covers it, so nothing was dispatched. Work goes by type; ${roles}${people}.`;
}

/** A dispatch that does not wait. */
export function dispatchedText(ticketId: string, type: string, role: string): string {
  return `Dispatched ${ticketId} (${type}) to ${role}. It runs without you; nothing comes back unless you wait for it.`;
}

/** A waited-for ticket that did not finish. */
export function notCompletedText(ticketId: string, type: string, reason: string): string {
  return `Ticket ${ticketId} (${type}) did not complete: ${reason}.`;
}

/** A waited-for ticket that finished with no answer. */
export function noAnswerText(ticketId: string, type: string): string {
  return `Ticket ${ticketId} (${type}) completed with no answer.`;
}

/** The ticket a recognised re-dispatch returns, and any other the same window holds. */
export interface RecognisedTicket {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly status: string;
  readonly answer?: string | undefined;
  /** The answer is on its way as a message, so it is not repeated here. */
  readonly delivering?: boolean;
  /** Older interrupted, unacknowledged hand-offs of the same type from this conversation. */
  readonly others?: readonly string[];
}

/**
 * A dispatch recognised as a retry of one a restart interrupted: a dispatch of the same
 * ticket type from the same conversation while that hand-off's answer is owed. The ticket it opened
 * then, its state, its answer when it has one, and how to say this really is a different request.
 * Nothing new was dispatched.
 */
export function recognisedText(ticket: RecognisedTicket): string {
  const lines = [
    `You already dispatched ${ticket.type} work as ${ticket.id} ("${ticket.title}") before a restart interrupted the call, so nothing new was dispatched.`,
  ];
  if (ticket.others !== undefined && ticket.others.length > 0) {
    lines.push(
      `Other interrupted ${ticket.type} hand-offs from this conversation: ${ticket.others.join(", ")}.`,
    );
  }
  lines.push(
    `If this is a different request and not a retry of ${ticket.id}, dispatch it again with separate_request set to true.`,
  );
  if (ticket.delivering === true) {
    lines.push(
      `${ticket.id} is ${ticket.status}, and its answer is arriving in this conversation as a message.`,
    );
  } else if (ticket.status === "done") {
    lines.push(
      `${ticket.id} is done. Answer: ${ticket.answer ?? noAnswerText(ticket.id, ticket.type)}`,
    );
  } else {
    lines.push(`${ticket.id} is ${ticket.status}; nothing comes back unless you wait for it.`);
  }
  return lines.join(" ");
}

/** The first line of a returned answer: never `TICKET`, which is work to do, not an answer. */
export function answerHeader(ticketId: string, type: string): string {
  return `ANSWER ${ticketId} — type ${type}`;
}

/** Why a returned answer arrives as a message, and that the work must not be dispatched again. */
export function answerIntro(ticketId: string, title: string): string {
  return `This answers your earlier hand-off ${ticketId} ("${title}"). Your agent_dispatch call for it was interrupted by a restart, so the answer comes to you here. Do not dispatch it again.`;
}

/**
 * The message a ticket's answer arrives as in the dispatcher's conversation when the dispatch that
 * waited for it was interrupted. Content from inside the harness is labelled, not fenced;
 * the office fences an external ticket's answer itself.
 */
export function answerMessage(
  ticket: { readonly id: string; readonly type: string; readonly title: string },
  answer: string | undefined,
): string {
  return [
    answerHeader(ticket.id, ticket.type),
    answerIntro(ticket.id, ticket.title),
    answer ?? noAnswerText(ticket.id, ticket.type),
  ].join("\n");
}

/** The fields of a ticket the inbox shows. */
export interface InboxTicket {
  readonly id: string;
  readonly status: string;
  readonly type: string;
  readonly title: string;
}

/** One line of the inbox: what the ticket is, whether it is yours or one you opened, and any result. */
export function inboxLine(
  ticket: InboxTicket,
  assigned: boolean,
  answer: string | undefined,
): string {
  const marker = assigned ? "assigned to you" : "opened";
  const title = `${ticket.id} [${ticket.status}] ${ticket.type} — ${ticket.title} (${marker})`;
  return answer === undefined ? title : `${title}\n    result: ${answer}`;
}

/** An inbox with nothing to show. */
export function emptyInboxText(status: string | undefined): string {
  return status === undefined
    ? "Nothing is waiting for you and nothing you opened has an answer."
    : `Nothing is ${status}.`;
}

/** A reply naming a ticket that does not exist. */
export function noTicketText(ticketId: string): string {
  return `No ticket ${ticketId} on this board.`;
}

/** A completed reply. */
export function repliedText(ticketId: string, result: string): string {
  return `Completed ${ticketId}: ${result}`;
}

/**
 * The message a delivered ticket arrives as, in the assignee's conversation: the ticket id the
 * assignee replies to, then the work. Content from inside the harness is labelled, not fenced.
 */
export function ticketMessage(ticket: {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly detail: string | null;
  readonly payload: unknown;
}): string {
  let payload: string | undefined;
  if (ticket.payload !== undefined && ticket.payload !== null) {
    try {
      payload = JSON.stringify(ticket.payload);
    } catch {
      payload = undefined;
    }
  }
  return [
    `TICKET ${ticket.id} — type ${ticket.type}`,
    ticket.title,
    ...(ticket.detail === null || ticket.detail === "" ? [] : [ticket.detail]),
    ...(payload === undefined ? [] : [`payload: ${payload}`]),
  ].join("\n");
}
