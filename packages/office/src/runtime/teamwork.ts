/**
 * How a runtime's agents work together: the office's people on the workboard, the relay that carries
 * tickets between agents, and the office extension each agent's conversations select.
 *
 * The runtime builds this when it is given a board. Each agent gets its own instance of the office
 * extension (`agent_dispatch`, `agent_inbox`, `agent_reply`, the `team` and `office` sections and
 * the budget hooks; approvals stay with the role's own gate and the runtime's approver), installed under its own name, and the relay routes a
 * ticket to the agent whose manifest accepts its type, in a conversation of that agent's for that
 * ticket. The relay is the office's single poller: `start` recovers what a previous run left
 * unfinished and then polls the board until `stop`.
 *
 * Nothing here decides anything. Routing, guards, the fence and the wait are the relay's; the tools
 * and hooks are the extension's; this module constructs them and keeps the loop turning.
 */

import type { AgentChange } from "@earendil-works/pi-durable";
import type { FileStore } from "@officehum/sdk";
import type { Office } from "../adapter/index.js";
import type { Board, Person } from "../board/index.js";
import {
  OFFICE_EXTENSION_NAME,
  officeConversation,
  officeExtension,
  type PersonRoute,
} from "../extension/index.js";
import { boardGuards } from "../relay/guards.js";
import type { RelayProvenance } from "../relay/message.js";
import { createRelay } from "../relay/relay.js";
import { harnessTransport } from "../relay/transport.js";
import type { LoadedRole } from "../roles/load-role.js";
import { budgetHooks } from "../spend/budget.js";

/** How long the relay rests between polls when the board has nothing for it, in milliseconds. */
const RELAY_POLL_MS = 250;

/**
 * Where a ticket comes from when an agent opens it while working for a gateway caller. Commands reach
 * the runtime only from its gateway, for callers the gateway signed in, so the work is the business's
 * own. An extension's provenance is fixed per agent, so the ticket does not name the caller.
 */
const GATEWAY_PROVENANCE: RelayProvenance = {
  origin: "internal",
  sourceChannel: "gateway",
  sourceContact: "gateway",
};

export interface TeamworkAgent {
  /** The agent's name: its role's manifest id, and its assignee id on the board. */
  readonly name: string;
  readonly role: LoadedRole;
  /** The role's own conversation settings, with the model the runtime resolved. */
  readonly settings: AgentChange;
}

export interface TeamworkOptions {
  readonly office: Office;
  readonly board: Board;
  readonly agents: readonly TeamworkAgent[];
  /** The company record's people, added to the board (or renamed on it) before anything runs. */
  readonly people?: readonly Person[];
  /** Ticket types no agent accepts that go to a person on the board. */
  readonly personRoutes?: readonly PersonRoute[];
  /** The office's file store, where a reply's files are looked up for `file` completion evidence. */
  readonly files?: FileStore;
  readonly log: (line: string) => void;
}

export interface Teamwork {
  /** The agent's conversation settings: its role's own, plus its office extension. */
  settings(name: string): AgentChange;
  /** Starts the relay: recovers unfinished deliveries, then polls until `stop`. */
  start(): void;
  /**
   * Stops polling, and resolves once the relay has let go of the board. A poll waiting on a running
   * delivery ends when the office closes; that delivery stays durable and is recovered on the next
   * start.
   */
  stop(): Promise<void>;
}

export function openTeamwork(options: TeamworkOptions): Teamwork {
  const { office, board, log } = options;
  board.upsertPeople(options.people ?? []);

  const settings = new Map<string, AgentChange>();
  const settingsOf = (name: string): AgentChange => {
    const known = settings.get(name);
    // Never `{}`: a conversation with no extension selection gets every installed extension.
    if (known === undefined) throw new Error(`This office has no agent ${name}.`);
    return known;
  };

  const relay = createRelay({
    office,
    board,
    transport: harnessTransport(office),
    // The relay reads a role's settings when it opens that role's conversation, which is after the
    // extensions below exist; they in turn need the relay to wait on.
    routing: options.agents.map(({ name, role }) => ({
      roleKey: name,
      accepts: (role.manifest.accepts ?? []).map((accept) => accept.type),
      get agent(): AgentChange {
        return settingsOf(name);
      },
    })),
    guards: boardGuards({ board }),
    now: () => Date.now(),
  });

  const manifests = options.agents.map((agent) => agent.role.manifest);
  for (const agent of options.agents) {
    const extension = officeExtension({
      board,
      relay,
      role: agent.name,
      people: manifests,
      ...(options.personRoutes === undefined ? {} : { personRoutes: options.personRoutes }),
      hooks: budgetHooks({ board }),
      // What the agent's completion evidence is checked with when it replies to a ticket.
      evidence: {
        ...(agent.role.engine === undefined ? {} : { engine: agent.role.engine }),
        ...(options.files === undefined ? {} : { files: options.files }),
      },
      // The runtime's approvals are decided through its gateway (`./approvals.ts`), for direct
      // requests and ticket work alike, so the board's gate is not installed beside the role's own.
      approvals: "role",
      settings: {
        // One instance per agent, each under its own name: Pi Durable selects extensions by name.
        name: `${OFFICE_EXTENSION_NAME}.${agent.name}`,
        provenance: GATEWAY_PROVENANCE,
        // Work an agent hands on while it is working a ticket is that ticket's child, so budgets and
        // the hop limit follow the chain.
        parentOf: (api) => board.conversationTicket(api.conversationId)?.ticketId,
      },
    });
    office.install({ extensions: [extension], agent: {} });
    settings.set(
      agent.name,
      officeConversation({ ...agent.role.bundle, agent: agent.settings }, { extension }),
    );
  }

  let stopped = false;
  let wake: () => void = () => {};
  const rest = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, RELAY_POLL_MS);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  const run = async () => {
    // The first pass, and the pass after any failure, re-admits what was left non-terminal.
    let recover = true;
    while (!stopped) {
      try {
        if (recover) await relay.recover();
        else await relay.pollOnce();
        recover = false;
      } catch (error) {
        if (stopped) return;
        log(
          `The relay could not finish a poll and will recover: ${error instanceof Error ? error.message : String(error)}`,
        );
        recover = true;
      }
      if (!stopped) await rest();
    }
  };

  let running: Promise<void> = Promise.resolve();
  return {
    settings: settingsOf,
    start() {
      running = run();
    },
    stop() {
      stopped = true;
      wake();
      return running;
    },
  };
}
