/**
 * The budget, end to end: a real harness, a real board, a scripted model (RASF-3141).
 *
 * Everything here runs offline and deterministically. The point of a separate file is that these are the
 * tests a reviewer will try to break, and each one has to fail for the *right* reason:
 *
 * - **The model asks to keep working and is refused.** A scripted model calls a tool, sees the refusal,
 *   and calls again — twice more, with different arguments and a different tool. Exactly `max_calls`
 *   tools execute; every later call is the harness's own blocked result.
 * - **A spend is charged once.** The ledger is keyed by the call, so a replayed attempt is a no-op. The
 *   board test proves the arithmetic; this file proves the hook uses it with the call's own identity.
 * - **The overshoot is one turn, and it is stated.** A token or dollar ceiling is enforced at the next
 *   boundary, so the test asserts `used_tokens` *exceeds* the ceiling and that the following call is the
 *   one refused. A test that expected an exact token stop would be testing a promise nobody can keep.
 *
 * What the scripted provider reports about usage matters, and it is not obvious: pi-ai's faux provider
 * reports zeros. A budget test about tokens that did not opt in would be asserting against numbers that
 * were never produced, so every token and dollar test here supplies a `usage` on the response and the
 * harness records it exactly as it records a provider's.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Message, Type, type Usage } from "@earendil-works/pi-ai";
import {
  type AgentChange,
  defineExtension,
  defineTool,
  type Extension,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { type Office, openOffice } from "../adapter/index.js";
import type { Board, Ticket } from "../board/index.js";
import { createWorkboard, seedPerson } from "../board/testing.js";
import { boardGuards } from "../relay/guards.js";
import type { RelayProvenance } from "../relay/message.js";
import { createRelay, type Relay, relayRoleRootKey } from "../relay/relay.js";
import { harnessTransport } from "../relay/transport.js";
import {
  type ScriptedModel,
  type ScriptedScript,
  type ScriptedTurn,
  scriptedProvider,
} from "../testing/scripted-model.js";
import { budgetHooks } from "./budget.js";
import { centsFor, type PriceTable } from "./prices.js";

const temps: string[] = [];
afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const DIRECTORY = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "officehum-budget-"));
  temps.push(directory);
  return directory;
};

const ROLE = "bookkeeper";
const TYPE = "invoice.create";
const PROVENANCE: RelayProvenance = {
  origin: "internal",
  sourceChannel: "chat",
  sourceContact: "desk",
};
/**
 * A rate that makes a turn cost real cents: 1_000_000¢ per million input tokens is exactly one cent a
 * token, so a scripted turn's few hundred estimated tokens are hundreds of cents — well past any ceiling
 * that matters here, and exact to the cent, because the arithmetic never rounds anything away.
 */
const CENTS_PER_MILLION: PriceTable = {
  prices: { "scripted/scripted-1": { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } },
  fallback: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** The text of one transcript message, whatever shape its content is. */
function textOf(message: Message): string {
  const content: unknown = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { readonly type: "text"; readonly text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("");
}

/** Every tool result the model was given, in order. */
function toolResults(messages: readonly Message[]): string[] {
  return messages.filter((message) => message.role === "toolResult").map(textOf);
}

/**
 * The script the refusal tests run: do the work, then — once refused — keep asking, changing tool and
 * arguments each time, until `maxRefusals` refusals have been seen. A model that talked its way past a
 * cap would get more executions out of this than the ceiling allows; a model that did not loop at all
 * would make the test say nothing about persistence.
 *
 * `hardStop` is belt and braces: a script that never terminates turns a broken assertion into a hung
 * test, and a hung test reads like an infrastructure problem instead of a bug.
 */
function stubbornScript(maxRefusals: number): ScriptedScript {
  return (messages): ScriptedTurn => {
    const results = messages.filter((message) => message.role === "toolResult");
    const refused = results.map(textOf).filter((line) => line.includes("Tool call blocked")).length;
    if (refused >= maxRefusals) return { text: "Blocked; stopping." };
    if (results.length >= 12) return { text: "Stopping before the script runs away." };
    const name = results.length % 2 === 0 ? "record_note" : "read_note";
    return { toolCalls: [{ name, args: { n: results.length + 1 } }] };
  };
}

interface Fixture {
  readonly file: string;
  readonly board: Board;
  readonly office: Office;
  readonly relay: Relay;
  readonly scripted: ScriptedModel;
  /** How many times a tool actually executed. The count a cap is judged by. */
  readonly executions: () => number;
  /** Create a ticket with a budget and let the relay deliver it. */
  dispatch(budget: {
    maxCalls?: number;
    maxTokens?: number;
    maxUsdCents?: number;
  }): Promise<Ticket>;
  close(): Promise<void>;
}

async function openFixture(options: {
  readonly script: ScriptedScript;
  readonly prices?: PriceTable;
  /** Seed the office's person, so a block has somebody to hand the ticket to. */
  readonly person?: string;
}): Promise<Fixture> {
  const directory = DIRECTORY();
  const file = join(directory, "office.sqlite");
  if (options.person !== undefined) seedPerson(file, "owner", options.person);
  const board = createWorkboard(file);
  const scripted = scriptedProvider(options.script);
  const office = await openOffice({
    storage: { sqlite: join(directory, "harness.sqlite") },
    models: scripted.models,
  });

  let executions = 0;
  const role: Extension = defineExtension({
    name: `fixture.${ROLE}`,
    tools: [
      defineTool({
        name: "record_note",
        description: "Record a note about the work in hand.",
        parameters: Type.Object({ n: Type.Number() }, { additionalProperties: false }),
        replay: "safe",
        execute: async (args) => {
          executions += 1;
          return { output: [{ type: "text" as const, text: `recorded ${args.n}` }] };
        },
      }),
      defineTool({
        name: "read_note",
        description: "Read the notes on the work in hand.",
        parameters: Type.Object({ n: Type.Number() }, { additionalProperties: false }),
        replay: "safe",
        execute: async (args) => {
          executions += 1;
          return { output: [{ type: "text" as const, text: `read ${args.n}` }] };
        },
      }),
    ],
  });

  /** The office's own contribution to a role conversation: the budget hooks, as an extension supplies them. */
  const budget: Extension = defineExtension({
    name: "officehum.budget",
    hooks: budgetHooks({
      board,
      ...(options.prices === undefined ? {} : { prices: options.prices }),
    }),
  });

  const agent: AgentChange = {
    model: scripted.model,
    extensions: [role, budget],
  };
  office.install({ extensions: [role, budget], agent: {} });
  const relay = createRelay({
    office,
    board,
    transport: harnessTransport(office),
    routing: [{ roleKey: ROLE, agent, accepts: [TYPE] }],
    // The door is on. A real office runs both seats, and the door is what has to refuse a ticket that is
    // already spent — the mid-turn hook only ever sees a turn that already started.
    guards: boardGuards({ board }),
    now: () => Date.now(),
  });

  let counter = 0;
  return {
    file,
    board,
    office,
    relay,
    scripted,
    executions: () => executions,
    async dispatch(budget) {
      counter += 1;
      const ticket = board.create(
        {
          type: TYPE,
          title: "Invoice 42",
          detail: "Invoice the completed job.",
          createdBy: "front-desk",
          provenance: PROVENANCE,
          budget,
        },
        `budget-test-${counter}`,
      );
      await relay.pollOnce();
      return ticket;
    },
    async close() {
      await office.close();
      board.close();
    },
  };
}

describe("budget enforcement", () => {
  it("refuses a model that keeps asking: exactly max_calls execute, and the ticket is blocked with a person", async () => {
    const fixture = await openFixture({
      script: stubbornScript(3),
      person: "Pat Owner",
    });
    try {
      const ticket = await fixture.dispatch({ maxCalls: 2 });

      // The cap, not the model's cooperation, is what limited the work.
      expect(fixture.executions()).toBe(2);
      expect(fixture.board.budget(ticket.id)).toMatchObject({
        usedCalls: 2,
        maxCalls: 2,
        remainingCalls: 0,
      });
      expect(fixture.board.get(ticket.id)).toMatchObject({
        status: "blocked",
        assignee: "owner",
      });

      // One `blocked` event, with the reason, by the office itself.
      const blocked = fixture.board.events(ticket.id).filter((event) => event.kind === "blocked");
      expect(blocked).toHaveLength(1);
      expect(blocked[0]?.actor).toBe("budget");
      expect(blocked[0]?.payload).toMatchObject({
        reason: expect.stringContaining("budget reached (2 calls"),
        assignee: { kind: "person", id: "owner" },
      });

      // What the model was actually told, three times, in the harness's own words. The last request's
      // transcript is the whole conversation, so counting there counts each refusal once.
      const transcript = toolResults(
        fixture.scripted.requests[fixture.scripted.requests.length - 1]?.messages ?? [],
      );
      const refused = transcript.filter((line) => line.includes("Tool call blocked"));
      expect(refused).toHaveLength(3);
      expect(refused[0]).toContain("budget reached (2 calls");
      expect(refused[0]).toContain("This ticket is blocked and with Pat Owner");
      expect(refused[0]).toContain("do not retry, do not open children");
      // And no note was recorded after the refusal: the third attempt never ran.
      expect(fixture.board.events(ticket.id).some((event) => event.kind === "completed")).toBe(
        false,
      );
    } finally {
      await fixture.close();
    }
  });

  it("fences tool work by the call ceiling, not by tokens a tool never reports", async () => {
    const fixture = await openFixture({ script: stubbornScript(2), person: "Pat Owner" });
    try {
      // A deterministic worker reports nothing of its own: the only tokens on the ticket are the model
      // turns that asked for it, and those are far under this ceiling. The call cap is what stopped the
      // work — which is the point, because a token ceiling has nothing to count for such a worker.
      const ticket = await fixture.dispatch({ maxCalls: 1, maxTokens: 1_000_000 });
      const budget = fixture.board.budget(ticket.id);
      expect(fixture.executions()).toBe(1);
      expect(budget).toMatchObject({
        usedCalls: 1,
        remainingCalls: 0,
        remainingTokens: expect.any(Number),
      });
      expect(budget?.usedTokens).toBeGreaterThan(0);
      expect(budget?.usedTokens).toBeLessThan(1_000_000);
      expect(fixture.board.get(ticket.id)?.status).toBe("blocked");
      const blocked = fixture.board.events(ticket.id).filter((event) => event.kind === "blocked");
      expect(blocked[0]?.payload).toMatchObject({
        reason: expect.stringContaining("calls ceiling"),
      });

      // The tool's own spend is only charged when the tool reports one, and it reports none: every
      // ledger row here is a model turn, so no cents were invented for work nobody priced.
      const database = new DatabaseSync(fixture.file, { readOnly: true });
      try {
        const rows = database.prepare("SELECT call_id FROM spend_ledger").all() as Array<{
          call_id: string;
        }>;
        expect(rows.length).toBeGreaterThan(0);
        // No `:usage` row: the tool reported nothing, so nothing was charged for its own spend.
        expect(rows.some((row) => row.call_id.endsWith(":usage"))).toBe(false);
      } finally {
        database.close();
      }
    } finally {
      await fixture.close();
    }
  });

  it("refuses the call a turn's tokens already paid for, and shows the overrun", async () => {
    const fixture = await openFixture({ script: stubbornScript(2), person: "Pat Owner" });
    try {
      // A scripted turn's estimated usage is a few hundred tokens, so a 100-token ceiling is crossed by
      // the first turn alone — and the first call that turn asks for is refused. The overrun is the turn,
      // never a mid-turn token count: no provider offers that control.
      const ticket = await fixture.dispatch({ maxTokens: 100 });
      const budget = fixture.board.budget(ticket.id);
      expect(fixture.executions()).toBe(0);
      expect(budget?.usedTokens).toBeGreaterThan(100);
      expect(budget).toMatchObject({ maxTokens: 100, remainingTokens: 0 });
      expect(fixture.board.get(ticket.id)?.status).toBe("blocked");
      const blocked = fixture.board.events(ticket.id).filter((event) => event.kind === "blocked");
      expect(blocked[0]?.payload).toMatchObject({
        reason: expect.stringContaining("tokens ceiling"),
      });
    } finally {
      await fixture.close();
    }
  });

  it("converts the session's usage to cents with the office's table and refuses at the dollar ceiling", async () => {
    const fixture = await openFixture({
      script: stubbornScript(2),
      prices: CENTS_PER_MILLION,
      person: "Pat Owner",
    });
    try {
      const ticket = await fixture.dispatch({ maxUsdCents: 1 });
      expect(fixture.executions()).toBe(0);
      expect(fixture.board.get(ticket.id)?.status).toBe("blocked");

      // What the harness recorded for the model, converted with the office's table, is what the board
      // charged — cents were converted from tokens, not taken from the provider's own (zero) cost.
      const usage = await fixture.office.harness.usage(BACKGROUND_CONTEXT);
      const recorded = usage.models["scripted/scripted-1"];
      expect(recorded).toBeDefined();
      const expected = centsFor(
        CENTS_PER_MILLION,
        { provider: "scripted", modelId: "scripted-1" },
        recorded as Usage,
      );
      expect(expected).toBeGreaterThan(1);
      expect(fixture.board.budget(ticket.id)).toMatchObject({
        usedUsdCents: expected,
        maxUsdCents: 1,
        remainingUsdCents: 0,
      });
      const blocked = fixture.board.events(ticket.id).filter((event) => event.kind === "blocked");
      // The reason records the spend at the moment work stopped — the first refusal — so it names a
      // figure no larger than the final total, and it names the ceiling it ran into.
      expect(blocked[0]?.payload).toMatchObject({
        reason: expect.stringMatching(/against the usd ceiling/),
      });
      expect(blocked[0]?.payload).toMatchObject({
        reason: expect.stringMatching(/\$\d+\.\d{2}/),
      });
    } finally {
      await fixture.close();
    }
  });

  it("refuses the next delivery at the door, so a blocked ticket gets no further turn", async () => {
    const fixture = await openFixture({ script: stubbornScript(2), person: "Pat Owner" });
    try {
      const ticket = await fixture.dispatch({ maxCalls: 1 });
      expect(fixture.board.get(ticket.id)?.status).toBe("blocked");
      const modelCalls = fixture.scripted.calls;

      // A person hands the blocked ticket back to the agent. The door refuses it: no model turn runs,
      // the ticket is blocked again, and the refusal is on the board as a `stalled` event.
      fixture.board.assign(ticket.id, { kind: "agent", id: ROLE }, "owner");
      await fixture.relay.pollOnce();

      expect(fixture.scripted.calls).toBe(modelCalls);
      expect(fixture.board.get(ticket.id)).toMatchObject({
        status: "blocked",
        assignee: "owner",
      });
      const stalled = fixture.board.events(ticket.id).filter((event) => event.kind === "stalled");
      expect(stalled).toHaveLength(1);
      expect(stalled[0]?.payload).toMatchObject({
        reason: expect.stringContaining("budget reached"),
      });
      // The delivery is terminal, so recovery will not retry a refusal that cannot change.
      const delivery = fixture.board.relay
        .deliveriesForTicket(ticket.id)
        .find((row) => row.state === "failed");
      expect(delivery?.outcome).toContain("budget reached");
    } finally {
      await fixture.close();
    }
  });

  it("leaves a conversation with no ticket alone", async () => {
    const fixture = await openFixture({ script: stubbornScript(1) });
    try {
      // The role's own root conversation is not working a ticket, so nothing is charged and nothing is
      // refused: the budget is a policy for ticket work, not a tax on every conversation.
      const root = await fixture.office.conversation(relayRoleRootKey(ROLE), {
        agent: { model: fixture.scripted.model, extensions: [] },
      });
      const submission = await fixture.office.submit(root, {
        input: "Say something.",
        requestId: "no-ticket",
      });
      await submission.wait(BACKGROUND_CONTEXT);
      expect(fixture.board.spendByAgent()).toEqual([]);
      expect(fixture.board.conversationTicket(root.id)).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });

  it("charges a call's usage even after the call was admitted", () => {
    // The regression: admission and usage shared one ledger key, so the row `admitCall` wrote made the
    // later `chargeUsage` look like a replay — calls were counted and tokens silently thrown away. Every
    // tool call goes through admission, so this was every tool's usage.
    const directory = mkdtempSync(join(tmpdir(), "officehum-budget-admit-"));
    temps.push(directory);
    const board = createWorkboard(join(directory, "office.sqlite"));
    const ticket = board.create(
      {
        type: "job.request",
        title: "Admitted then spent",
        createdBy: "agent:desk",
        provenance: PROVENANCE,
        budget: { maxCalls: 4 },
      },
      "admit-then-charge",
    );
    const admission = board.admitCall(ticket.id, "conv:task:call-1", "agent:desk");
    expect(admission.admitted).toBe(true);
    expect(admission.charged).toBe(true);

    const charged = board.chargeUsage(ticket.id, "conv:task:call-1", {
      tokens: 900,
      usdCents: 4,
      agent: "agent:desk",
    });
    expect(charged.charged).toBe(true);

    const budget = board.budget(ticket.id);
    expect(budget?.usedCalls).toBe(1);
    expect(budget?.usedTokens).toBe(900);
    expect(budget?.usedUsdCents).toBe(4);

    // And each observation is still deduped on its own: replaying either adds nothing.
    expect(
      board.chargeUsage(ticket.id, "conv:task:call-1", { tokens: 900, usdCents: 4 }).charged,
    ).toBe(false);
    expect(board.admitCall(ticket.id, "conv:task:call-1", "agent:desk").charged).toBe(false);
    expect(board.budget(ticket.id)?.usedCalls).toBe(1);
    expect(board.budget(ticket.id)?.usedTokens).toBe(900);
  });
});
