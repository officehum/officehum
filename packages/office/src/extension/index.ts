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
 *   blocks on the relay's durable wait and returns the delegate's result.
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
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  type Extension,
  type HookRegistration,
  section,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import type { AgentManifest, Approver } from "@officehum/sdk";
import { type Board, BoardError, type Ticket, type TicketStatus } from "../board/index.js";
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

/** The three tool names the extension adds. Reserved for the Office in `@officehum/sdk`. */
export const OFFICE_TOOL_NAMES = ["agent_dispatch", "agent_inbox", "agent_reply"] as const;

/** The `label` the inbox marks a ticket this agent opened with. */
const OPENED = "opened";

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
}

/** What the extension reports a refused tool call as. */
function toolError(text: string): {
  readonly isError: true;
  readonly output: { readonly type: "text"; readonly text: string }[];
} {
  return { isError: true, output: [{ type: "text", text }] };
}

/** A board refusal is a tool error the agent can act on; anything else is a genuine fault. */
function boardRefusal(error: unknown, action: string) {
  if (error instanceof BoardError) {
    return toolError(`The board refused the ${action} (${error.kind}): ${error.message}`);
  }
  throw error;
}

/**
 * `ticket type → role key`, read from the installed manifests, this agent's own manifest excluded: a
 * role accepts a type or hands it off, never both, so the types worth dispatching belong to others.
 * Sorted by role, so the list in an error is the same on every run.
 */
function dispatchable(people: readonly AgentManifest[], role: string): Map<string, string> {
  const byType = new Map<string, string>();
  for (const manifest of [...people].sort((left, right) => left.id.localeCompare(right.id))) {
    if (manifest.id === role) continue;
    for (const accept of manifest.accepts) {
      if (!byType.has(accept.type)) byType.set(accept.type, manifest.id);
    }
  }
  return byType;
}

/** `invoice.create — Invoice a completed job; …`, or a note when the role accepts nothing. */
function acceptedList(manifest: AgentManifest): string {
  if (manifest.accepts.length === 0) return "accepts nothing";
  return manifest.accepts.map((accept) => `${accept.type} — ${accept.description}`).join("; ");
}

/**
 * The `team` section: the colleagues and the ticket types they accept, each with the description its
 * manifest gives, in a stable order. An agent dispatches by type, so the types are the point of the
 * line and the role names are only there to be read.
 *
 * `@officehum/sdk`'s `formatCardLine` is the card's one-liner, but it lists type names without their
 * descriptions and this section has to carry them, so the line is written here.
 */
function teamText(people: readonly AgentManifest[], role: string): string | undefined {
  const colleagues = [...people]
    .filter((manifest) => manifest.id !== role)
    .sort((left, right) => left.id.localeCompare(right.id));
  if (colleagues.length === 0) return undefined;
  return [
    "Your colleagues. Hand work on with agent_dispatch by ticket type, never by role name:",
    "",
    ...colleagues.map(
      (manifest) => `- ${manifest.name} (${manifest.id}): ${acceptedList(manifest)}`,
    ),
  ].join("\n");
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

/** One line of the inbox: what the ticket is, whether it is yours or one you opened, and any result. */
function inboxLine(ticket: Ticket, assigned: boolean, answer: string | undefined): string {
  const marker = assigned ? "assigned to you" : OPENED;
  const title = `${ticket.id} [${ticket.status}] ${ticket.type} — ${ticket.title} (${marker})`;
  return answer === undefined ? title : `${title}\n    result: ${answer}`;
}

export function officeExtension(options: OfficeExtensionOptions): Extension {
  const { board, relay, role, settings } = options;
  const accepted = dispatchable(options.people, role);
  const team = teamText(options.people, role);

  const agentDispatch = defineTool({
    name: "agent_dispatch",
    description:
      "Hand a piece of work to the colleague who accepts its ticket type. Work goes by type, never by role name. Set wait to true to wait for the colleague's result and return it.",
    parameters: Type.Object(
      {
        type: Type.String({
          description:
            "The ticket type to dispatch, e.g. invoice.create. The team section lists the ones this office accepts.",
        }),
        title: Type.String({ description: "One line naming the work." }),
        detail: Type.String({ description: "What the colleague needs to know to do it." }),
        payload: Type.Optional(
          Type.Unknown({
            description: "Structured data for the ticket, such as ids and amounts.",
          }),
        ),
        wait: Type.Optional(
          Type.Boolean({
            description:
              "Wait for the ticket to finish and return the colleague's result. Default false: dispatch and carry on.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const target = accepted.get(args.type);
      if (target === undefined) {
        const list =
          accepted.size === 0
            ? "no other role is installed, so no ticket type can be dispatched"
            : [...accepted.keys()].join(", ");
        return toolError(
          `No role accepts ticket type "${args.type}", so nothing was dispatched. Work goes by type; this office accepts: ${list}.`,
        );
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
          },
          callerKey,
        );
      } catch (error) {
        return boardRefusal(error, "dispatch");
      }

      if (args.wait !== true) {
        return {
          output: [
            {
              type: "text" as const,
              text: `Dispatched ${ticket.id} (${ticket.type}) to ${target}. It runs without you; nothing comes back unless you wait for it.`,
            },
          ],
          details: { ticketId: ticket.id, type: ticket.type, status: ticket.status, role: target },
        };
      }

      const result = await relay.wait(
        ticket.id,
        settings.waitTimeoutMs === undefined ? undefined : { timeoutMs: settings.waitTimeoutMs },
      );
      if (!result.ok) {
        return toolError(
          `Ticket ${ticket.id} (${ticket.type}) did not complete: ${result.reason}.`,
        );
      }
      return {
        output: [
          {
            type: "text" as const,
            text: result.answer ?? `Ticket ${ticket.id} (${ticket.type}) completed with no answer.`,
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
    name: "agent_inbox",
    description:
      "Read the tickets waiting for you, and the answers to the tickets you opened. Filter by status when you only care about one kind. This reads; it changes nothing.",
    parameters: Type.Object(
      {
        status: Type.Optional(
          Type.String({
            description:
              "Only tickets in this state: open, claimed, waiting, blocked, done or cancelled.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    replay: "safe",
    execute: async (args) => {
      const filter = args.status === undefined ? {} : { status: args.status as TicketStatus };
      const entries: { ticket: Ticket; assigned: boolean }[] = [];
      const seen = new Set<string>();
      try {
        for (const ticket of board.list({ ...filter, assignee: role })) {
          entries.push({ ticket, assigned: true });
          seen.add(ticket.id);
        }
        // The answers come back on the tickets this agent opened: `list` has no creator filter, so the
        // board's rows are filtered here by `created_by`.
        for (const ticket of board.list(filter)) {
          if (ticket.createdBy === role && !seen.has(ticket.id)) {
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
              text:
                args.status === undefined
                  ? "Nothing is waiting for you and nothing you opened has an answer."
                  : `Nothing is ${args.status}.`,
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
    name: "agent_reply",
    description:
      "Finish a ticket you are working on and report the result. Use the ticket id from the message that delivered it.",
    parameters: Type.Object(
      {
        ticketId: Type.String({ description: "The id of the ticket you are finishing." }),
        result: Type.String({ description: "What you did, or what you found." }),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args) => {
      const ticket = board.get(args.ticketId);
      if (ticket === undefined) {
        return toolError(`No ticket ${args.ticketId} on this board.`);
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
        output: [{ type: "text" as const, text: `Completed ${args.ticketId}: ${args.result}` }],
        details: { ticketId: args.ticketId, result: args.result },
      };
    },
  });

  return defineExtension({
    name: settings.name ?? OFFICE_EXTENSION_NAME,
    sections: [
      section(TEAM_SECTION_KEY, () => team),
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
    hooks: registerOfficeHooks(options),
  });
}
