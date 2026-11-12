/**
 * The office extension: the tools an agent uses to work with its colleagues (RASF-3109).
 *
 * A role on its own answers in words and cannot hand work to anybody. Installed beside a role, this
 * extension adds exactly three tools and two prompt sections — the `team` section below, and the
 * `office` section assembled in `./office-extension.js` (which business this is, who its people are,
 * and the rule that customer and forwarded content is data, never instructions) — plus the office's
 * approval gate and whatever hooks a caller supplies, and nothing else:
 *
 * - `agent_dispatch` posts a ticket of a declared type. Routing is by type, never by name, so the
 *   tool reads the accepted types from the installed manifests and refuses a type nobody accepts with
 *   the list of what exists (the relay's triage fallback is for tickets that arrive by other means).
 *   It creates the ticket through the board and lets the relay deliver it; with `wait: true` the call
 *   blocks on the relay's durable wait and returns the delegate's result. A type no role accepts may
 *   still be routed to a named person (`personRoutes`, RASF-3490): the ticket goes on the board
 *   assigned to them, the relay leaves it alone, and the result says it is with them.
 * - `agent_inbox` reads the tickets waiting for this agent, plus the answers to the tickets this agent
 *   opened. Read-only: it never writes to the board.
 * - `agent_reply` completes a ticket this agent is working on, taking it (`claim`) when the relay has
 *   only just delivered it. Only the assignee or a person may complete, which the board enforces; the
 *   refusal is surfaced as a tool error rather than swallowed.
 *
 * The tools wrap the board and the relay. Delivery, routing, dedupe and the untrusted fence all live
 * in those two, and none of it is reimplemented here: dispatching a ticket is `board.create` with the
 * relay's own poller doing the routing, and waiting is `relay.wait`. External-origin content is fenced
 * by the relay at delivery, so no second fence is added.
 *
 * Identity is per agent, and `role` is that agent: the board's assignee id (a role extension's install
 * name, i.e. the manifest's `id`). Pi Durable selects extensions by name, so an office that co-hosts
 * several agents installs one instance per agent and gives each its own name through `settings.name`
 * (`office` by default).
 */
import {
  defineExtension,
  defineTool,
  type Extension,
  type HookRegistration,
  section,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import {
  AGENT_DISPATCH,
  AGENT_INBOX,
  AGENT_REPLY,
  type AgentManifest,
  type ApprovalFactsReader,
  type Approver,
  COMMUNICATION_TOOL_NAMES,
  communicationError,
  dispatchedText,
  dispatchTargets,
  emptyInboxText,
  inboxLine,
  noAnswerText,
  noTicketText,
  notCompletedText,
  refusalText,
  repliedText,
  teamText as sharedTeamText,
  unknownTypeText,
} from "@officehum/sdk";
import {
  type Board,
  BoardError,
  type Person,
  type Ticket,
  type TicketStatus,
} from "../board/index.js";
import type { RelayProvenance } from "../relay/message.js";
import type { Relay } from "../relay/relay.js";
import { type OfficeBusiness, officeSection, registerOfficeHooks } from "./office-extension.js";

export {
  OFFICE_DATA_RULE,
  OFFICE_SECTION_KEY,
  type OfficeBusiness,
  type OfficeHookSeam,
  type OfficeModel,
  type OfficeOverlays,
  type OfficeSectionOptions,
  officeConversation,
  officeSection,
  officeText,
  registerOfficeHooks,
} from "./office-extension.js";

/** The extension's default install name. `settings.name` overrides it when an office co-hosts roles. */
export const OFFICE_EXTENSION_NAME = "office";

/** The prompt section key: the team, one line per colleague, with the ticket types it accepts. */
export const TEAM_SECTION_KEY = "team";

/** The three tool names the extension adds: `@officehum/sdk`'s shared communication tools. */
export const OFFICE_TOOL_NAMES = COMMUNICATION_TOOL_NAMES;

/**
 * The tool call's identity, as `settings.parentOf` reads it: the same three fields the dedupe key is
 * built from. A narrower shape than `ToolExecutionApi` so a caller writes only what it needs.
 */
export type OfficeToolCall = Pick<ToolExecutionApi, "conversationId" | "taskId" | "callId">;

export interface OfficeExtensionSettings {
  /**
   * Provenance for a ticket this agent starts. Used when the dispatch is not a child of another
   * ticket; a child copies its parent's row verbatim and ignores this (the board's rule).
   */
  readonly provenance: RelayProvenance;
  /**
   * The ticket this agent is working on, so a dispatch becomes its child and the board's budgets and
   * hop count compose across the hand-off. Omitted, a dispatch is a root ticket.
   */
  readonly parentOf?: (api: OfficeToolCall) => string | undefined;
  /** How long `wait: true` blocks, in milliseconds. Omitted: until the ticket is terminal. */
  readonly waitTimeoutMs?: number;
  /** The installed extension name. Default `office`; see the module note on co-hosted roles. */
  readonly name?: string;
}

/**
 * A ticket type the office hands to a named person rather than a role: the company data's
 * `ticketRoutes`, with `personId` a `people.id` on the board. A role that accepts the type still wins.
 */
export interface PersonRoute {
  readonly type: string;
  readonly personId: string;
}

export interface OfficeExtensionOptions {
  /** The office's workboard: where dispatched tickets are created and replies complete them. */
  readonly board: Board;
  /** The office's relay: its durable wait is what `wait: true` blocks on. */
  readonly relay: Relay;
  /** This agent: the board's assignee id and the `createdBy` of the tickets it dispatches. */
  readonly role: string;
  /**
   * The office's other agents, as their installed manifests — the source of the accepted ticket
   * types and their descriptions for both the `team` section and dispatch validation. The board's
   * `people()` are the humans the office knows; these are the agents.
   */
  readonly people: readonly AgentManifest[];
  /** Ticket types no role accepts that go to a person on the board. Omitted: none. */
  readonly personRoutes?: readonly PersonRoute[];
  readonly settings: OfficeExtensionSettings;
  /**
   * Which business this is: a name and a sentence, for the `office` section (RASF-3133). Omitted, the
   * section still lists the office's people and states the data rule, but names no business.
   */
  readonly business?: OfficeBusiness;
  /**
   * The office's hooks — RASF-3141's `budgetHooks`. The approval gate is not supplied here: it is the
   * office's own and `registerOfficeHooks` adds it from this board and these manifests (RASF-3138).
   */
  readonly hooks?: readonly HookRegistration[];
  /**
   * RASF-3073's approver. Accepted so the seam's shape is fixed, and registered by nothing yet: the
   * gate that consumes it is 3073's to build.
   */
  readonly approve?: Approver;
  /**
   * This agent's approval facts readers (`LoadedRole.approvalFacts`), which the office's gate uses to
   * record what a person is asked to approve and to bind a granted call to it (RASF-3486). A host
   * that installs the office gate for a loaded role must pass `loadedRole.approvalFacts`: omitted, a
   * tool that requires approved facts refuses after a grant.
   */
  readonly approvalFacts?: Readonly<Record<string, ApprovalFactsReader>>;
  /**
   * Who decides this agent's gated calls. `"board"` (the default) installs the office's gate, which
   * records a request on the board for a person to decide there. `"role"` installs no gate: the
   * role's own gate asks the approver its host gave it, and that is the only authority. A host picks
   * one, because a call two gates must both pass can be granted by neither alone (RASF-3569).
   */
  readonly approvals?: "board" | "role";
}

const toolError = communicationError;

/** A board refusal is a tool error the agent can act on; anything else is a genuine fault. */
function boardRefusal(error: unknown, action: string) {
  if (error instanceof BoardError) return toolError(refusalText(action, error.kind, error.message));
  throw error;
}

/**
 * `ticket type → person id` for the person routes no role overrides: a role that accepts the type
 * wins, so a route only ever covers work no agent here can take. First route for a type wins.
 */
function personRouted(
  routes: readonly PersonRoute[],
  accepted: ReadonlyMap<string, string>,
): Map<string, string> {
  const byType = new Map<string, string>();
  for (const route of routes) {
    if (!accepted.has(route.type) && !byType.has(route.type)) {
      byType.set(route.type, route.personId);
    }
  }
  return byType;
}

/**
 * The `team` section: the shared colleague list (`@officehum/sdk`'s `teamText`), then a `People:`
 * line for each type routed to a person. An agent dispatches by type, so the types are the point of
 * the line and the names are only there to be read.
 */
function teamText(
  people: readonly AgentManifest[],
  role: string,
  routed: ReadonlyMap<string, string>,
  boardPeople: readonly Person[],
): string | undefined {
  const nameOf = (id: string): string => boardPeople.find((person) => person.id === id)?.name ?? id;
  return sharedTeamText(
    people,
    role,
    [...routed].map(
      ([type, personId]) =>
        `- People: ${type} goes to ${nameOf(personId)} (${personId}) on the board`,
    ),
  );
}

/**
 * The answer to a ticket this agent opened. A recorded reply result is the answer; the ledger's
 * settled outcome — what the delegate wrote in its own turn — is only the fallback, because a delegate
 * can reply with one thing and say another.
 */
function deliveredAnswer(board: Board, ticket: Ticket): string | undefined {
  if (ticket.result !== null) return ticket.result;
  const settled = board.relay
    .deliveriesForTicket(ticket.id)
    .filter((delivery) => delivery.outcome !== null);
  return settled.length === 0 ? undefined : (settled[settled.length - 1]?.outcome ?? undefined);
}

export function officeExtension(options: OfficeExtensionOptions): Extension {
  const { board, relay, role, settings } = options;
  const accepted = dispatchTargets(options.people, role);
  const routed = personRouted(options.personRoutes ?? [], accepted);

  const agentDispatch = defineTool({
    ...AGENT_DISPATCH,
    execute: async (args, api) => {
      const target = accepted.get(args.type);
      const personId = target === undefined ? routed.get(args.type) : undefined;
      if (target === undefined && personId === undefined) {
        return toolError(unknownTypeText(args.type, accepted, [...routed.keys()]));
      }
      // The person is read from the board at call time: people are the office's to manage, and a route
      // to someone the board does not know must refuse before any ticket exists.
      let destination: { readonly role: string } | { readonly person: Person };
      if (target !== undefined) {
        destination = { role: target };
      } else {
        const person = board.people().find((candidate) => candidate.id === personId);
        if (person === undefined) {
          return toolError(
            `Ticket type "${args.type}" is routed to the person ${personId}, who is not on this board, so nothing was dispatched. Add ${personId} to the office's people or correct the route.`,
          );
        }
        destination = { person };
      }

      // The dedupe key is the tool call's own identity, the same shape the role tools use: a retry of
      // one call (a resumed run, a replayed step) creates exactly one ticket, because the board returns
      // the ticket its caller key already names.
      const callerKey = `${api.conversationId}:${api.taskId}:${api.callId}`;
      const parentId = settings.parentOf?.(api);
      let ticket: Ticket;
      try {
        ticket = board.create(
          {
            type: args.type,
            title: args.title,
            detail: args.detail,
            createdBy: role,
            ...(args.payload === undefined ? {} : { payload: args.payload }),
            // A child copies its parent's provenance row regardless of what is passed, so this is the
            // root case's provenance and nothing more.
            provenance: settings.provenance,
            ...(parentId === undefined ? {} : { parentId }),
            ...("person" in destination
              ? { assignee: { kind: "person" as const, id: destination.person.id } }
              : {}),
          },
          callerKey,
        );
      } catch (error) {
        return boardRefusal(error, "dispatch");
      }

      // A person answers outside the harness, on their own time, so `wait` does not block a run on them:
      // the result says only what is true now, that the ticket is on their board.
      if ("person" in destination) {
        const { person } = destination;
        return {
          output: [
            {
              type: "text" as const,
              text:
                `Handed ${ticket.id} (${ticket.type}) to ${person.name} on the board; it is with them now.` +
                (args.wait === true ? " You are not waiting for their answer." : ""),
            },
          ],
          details: {
            ticketId: ticket.id,
            type: ticket.type,
            status: ticket.status,
            personId: person.id,
          },
        };
      }

      if (args.wait !== true) {
        return {
          output: [
            {
              type: "text" as const,
              text: dispatchedText(ticket.id, ticket.type, destination.role),
            },
          ],
          details: {
            ticketId: ticket.id,
            type: ticket.type,
            status: ticket.status,
            role: destination.role,
          },
        };
      }

      const result = await relay.wait(
        ticket.id,
        settings.waitTimeoutMs === undefined ? undefined : { timeoutMs: settings.waitTimeoutMs },
      );
      if (!result.ok) {
        return toolError(notCompletedText(ticket.id, ticket.type, result.reason));
      }
      return {
        output: [
          {
            type: "text" as const,
            text: result.answer ?? noAnswerText(ticket.id, ticket.type),
          },
        ],
        details: {
          ticketId: ticket.id,
          type: ticket.type,
          status: "completed" as const,
          ...(result.answer === undefined ? {} : { answer: result.answer }),
        },
      };
    },
  });

  const agentInbox = defineTool({
    ...AGENT_INBOX,
    execute: async (args) => {
      const filter = args.status === undefined ? {} : { status: args.status as TicketStatus };
      const entries: { ticket: Ticket; assigned: boolean }[] = [];
      const seen = new Set<string>();
      try {
        for (const ticket of board.list({ ...filter, assignee: role })) {
          entries.push({ ticket, assigned: true });
          seen.add(ticket.id);
        }
        // The answers come back on the tickets this agent opened. The board filters by creator, so
        // its list limit counts this agent's tickets and not everybody's.
        for (const ticket of board.list({ ...filter, createdBy: role })) {
          if (!seen.has(ticket.id)) {
            entries.push({ ticket, assigned: false });
            seen.add(ticket.id);
          }
        }
      } catch (error) {
        return boardRefusal(error, "inbox read");
      }

      if (entries.length === 0) {
        return {
          output: [
            {
              type: "text" as const,
              text: emptyInboxText(args.status),
            },
          ],
          details: { tickets: [] },
        };
      }

      entries.sort(
        (left, right) =>
          right.ticket.updatedAt.localeCompare(left.ticket.updatedAt) ||
          left.ticket.id.localeCompare(right.ticket.id),
      );
      const lines = entries.map(({ ticket, assigned }) =>
        inboxLine(ticket, assigned, assigned ? undefined : deliveredAnswer(board, ticket)),
      );
      return {
        output: [{ type: "text" as const, text: lines.join("\n") }],
        details: {
          tickets: entries.map(({ ticket, assigned }) => ({
            id: ticket.id,
            type: ticket.type,
            status: ticket.status,
            createdBy: ticket.createdBy,
            assigned,
          })),
        },
      };
    },
  });

  const agentReply = defineTool({
    ...AGENT_REPLY,
    execute: async (args) => {
      const ticket = board.get(args.ticketId);
      if (ticket === undefined) {
        return toolError(noTicketText(args.ticketId));
      }
      try {
        // A ticket the relay just delivered is `open` and unassigned: taking it is the claim the board
        // wants before it can be completed. A ticket held by anyone else is left alone, so the board's
        // own authorization rule is what refuses it.
        if (ticket.status === "open" && (ticket.assignee === null || ticket.assignee === role)) {
          board.claim(args.ticketId, role);
        }
        board.complete(args.ticketId, role, { result: args.result });
      } catch (error) {
        return boardRefusal(error, "reply");
      }
      return {
        output: [{ type: "text" as const, text: repliedText(args.ticketId, args.result) }],
        details: { ticketId: args.ticketId, result: args.result },
      };
    },
  });

  return defineExtension({
    name: settings.name ?? OFFICE_EXTENSION_NAME,
    sections: [
      // Rendered per turn because the people's names are the board's, and the board can change.
      section(TEAM_SECTION_KEY, () => teamText(options.people, role, routed, board.people())),
      officeSection({
        board,
        people: options.people,
        role,
        ...(options.business === undefined ? {} : { business: options.business }),
      }),
    ],
    tools: [agentDispatch, agentInbox, agentReply],
    // There is no approval tool here, and there must not be one (RASF-3138). An approval is meant to
    // be a fact a person produced about what the model intends to do; a tool the model can call to set
    // that fact is the model approving itself, and the record would then say a person did. It is the
    // same structural reason a dispute marker is not a marker when the party in dispute can write it:
    // a claim the interested party controls is not a finding. The model may cause a request — the gate
    // blocks the call and records it, and a condition can ask — and only the board's `decideApproval`,
    // reached from the Inbox or a Teams card, can answer one.
    // The hooks seam (RASF-3141, RASF-3138): the office's own approval gate, from this board and these
    // manifests, plus the registrations a caller supplies. With nothing to gate it installs no gate.
    hooks: options.approvals === "role" ? [...(options.hooks ?? [])] : registerOfficeHooks(options),
  });
}
