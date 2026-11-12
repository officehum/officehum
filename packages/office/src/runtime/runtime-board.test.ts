/**
 * The runtime with a workboard: the office's people loaded at start, and work handed between agents
 * through the relay it runs for as long as it is open. Everything goes through `openRuntime`, over
 * SQLite files, with a scripted model.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { EventMessage, ServerMessage } from "@officehum/protocol";
import {
  type AgentManifest,
  APPROVED_FACTS_ARG,
  type ApprovalDeclaration,
  approvalGate,
  approvedFacts,
  approvedFactsParameter,
} from "@officehum/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BOOK,
  BOOK_MANIFEST,
  DELEGATE_RESULT,
  DELEGATOR_FINAL,
  delegatingScript,
  FRONT,
  FRONT_MANIFEST,
  TYPE,
  textOf,
} from "../../../sdk/src/fixtures/communication-cases.js";
import { openApprovalInbox } from "../approvals/inbox.js";
import type { Board } from "../board/index.js";
import { createWorkboard } from "../board/testing.js";
import { relayTicketKey } from "../relay/relay.js";
import type { LoadedRole } from "../roles/load-role.js";
import { type ScriptedScript, scriptedProvider } from "../testing/scripted-model.js";
import { RemoteApprovals } from "./approvals.js";
import { openRuntime, type Runtime, type RuntimeOptions } from "./runtime.js";

const ada = { id: "ada", roles: ["staff"] };

const temps: string[] = [];
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function directory(): string {
  const created = mkdtempSync(join(tmpdir(), "officehum-runtime-board-"));
  temps.push(created);
  return created;
}

/** A role built inline from a manifest: one tool of its own, `check_books`, that waits on `gate`. */
function role(
  manifest: AgentManifest,
  gate?: (signal: AbortSignal | undefined) => Promise<void>,
): LoadedRole {
  const check = defineTool({
    name: "check_books",
    description: "Checks the books.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, _api, context) => {
      await gate?.(context.abortSignal);
      return { output: [{ type: "text", text: "checked" }] };
    },
  });
  const extension = defineExtension({ name: `${manifest.id}-tools`, tools: [check] });
  return {
    dir: "/fixture",
    manifest: { ...manifest, tools: [{ name: "check_books", replay: "safe" }] },
    bundle: { extensions: [extension], agent: { extensions: [extension] } },
    approvalFacts: {},
  } as unknown as LoadedRole;
}

/** One runtime over the files in `home`: the harness store and, beside it, the workboard. */
async function open(
  home: string,
  script: ScriptedScript,
  options: Partial<Pick<RuntimeOptions, "roles" | "people" | "personRoutes" | "approvals">> = {},
) {
  const scripted = scriptedProvider(script);
  const board: Board = createWorkboard(join(home, "office.sqlite"));
  const sent: ServerMessage[] = [];
  const log: string[] = [];
  let runtime: Runtime;
  try {
    runtime = await openRuntime({
      serverId: "office-test",
      roles: options.roles ?? [role(FRONT_MANIFEST), role(BOOK_MANIFEST)],
      storage: { sqlite: join(home, "harness.sqlite") },
      models: scripted.models,
      model: scripted.model,
      send: (message) => sent.push(message),
      log: (line) => log.push(line),
      board,
      ...(options.people === undefined ? {} : { people: options.people }),
      ...(options.personRoutes === undefined ? {} : { personRoutes: options.personRoutes }),
      ...(options.approvals === undefined ? {} : { approvals: options.approvals }),
    });
  } catch (error) {
    board.close();
    throw error;
  }
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await runtime.close();
    board.close();
  };
  closers.push(close);
  const settledFor = (requestId: string) =>
    vi.waitFor(
      () => {
        const found = sent.find(
          (message): message is EventMessage =>
            message.type === "event" &&
            message.requestId === requestId &&
            message.event.kind === "settled",
        );
        if (found === undefined) throw new Error("not settled yet");
        return found;
      },
      { timeout: 15_000, interval: 20 },
    );
  return { runtime, board, scripted, sent, log, close, settledFor };
}

const submit = (id: string, requestId: string, agent = FRONT) => ({
  type: "submit",
  id,
  agent,
  requestId,
  input: { kind: "message", text: "Please invoice job 42." },
  principal: ada,
});

describe("the runtime's workboard", () => {
  it("loads the office's people at start, and loading them again changes nothing", async () => {
    const home = directory();
    const first = await open(home, [], {
      people: [
        { id: "dana-whitfield", name: "Dana Whitfield" },
        { id: "eileen-hart", name: "Eileen Hart" },
      ],
    });
    expect(first.board.people()).toEqual([
      { id: "dana-whitfield", name: "Dana Whitfield" },
      { id: "eileen-hart", name: "Eileen Hart" },
    ]);
    await first.close();

    // The same record again, with one rename and one newcomer: no duplicate, the first person stays
    // first, and nobody is dropped.
    const second = await open(home, [], {
      people: [
        { id: "eileen-hart", name: "Eileen Hart-Lowe" },
        { id: "noah-kim", name: "Noah Kim" },
      ],
    });
    expect(second.board.people()).toEqual([
      { id: "dana-whitfield", name: "Dana Whitfield" },
      { id: "eileen-hart", name: "Eileen Hart-Lowe" },
      { id: "noah-kim", name: "Noah Kim" },
    ]);
  });

  it("hands a ticket from one agent's conversation to the colleague that accepts it, and brings the answer back", async () => {
    const office = await open(directory(), delegatingScript());
    await office.runtime.handle(submit("c1", "r1"));

    const settled = await office.settledFor("ada/r1");
    expect(settled.event).toEqual({ kind: "settled", status: "done", answer: DELEGATOR_FINAL });

    // One ticket, delivered once into the colleague's own conversation for it, and completed there.
    const tickets = office.board.list({ type: TYPE });
    expect(tickets).toHaveLength(1);
    const ticket = tickets[0];
    expect(ticket).toMatchObject({
      status: "done",
      createdBy: FRONT,
      assignee: BOOK,
      result: DELEGATE_RESULT,
    });
    const deliveries = office.board.relay.deliveriesForTicket(ticket?.id ?? "");
    expect(deliveries.filter((delivery) => delivery.targetKey !== "")).toEqual([
      expect.objectContaining({
        targetKey: relayTicketKey(BOOK, ticket?.id ?? ""),
        state: "settled",
      }),
    ]);
    expect(office.board.provenance(ticket?.id ?? "")).toEqual({
      origin: "internal",
      sourceChannel: "gateway",
      sourceContact: "gateway",
    });

    // The delegator's dispatch returned the colleague's answer, and each agent was offered the
    // office's three tools beside its own and nobody else's.
    const delegator = office.scripted.requests.find((request) =>
      request.messages.some(
        (message) =>
          message.role === "toolResult" &&
          message.toolName === "agent_dispatch" &&
          textOf(message).includes(DELEGATE_RESULT),
      ),
    );
    expect(delegator).toBeDefined();
    for (const request of office.scripted.requests) {
      expect(request.tools.map((tool) => tool.name).sort()).toEqual([
        "agent_dispatch",
        "agent_inbox",
        "agent_reply",
        "check_books",
      ]);
    }
  });

  it("gives a ticket no agent accepts to the person the company routes it to", async () => {
    const office = await open(
      directory(),
      delegatingScript({ type: "finance.review", title: "Review a credit", detail: "Job 42." }),
      {
        people: [
          { id: "dana-whitfield", name: "Dana Whitfield" },
          { id: "eileen-hart", name: "Eileen Hart" },
        ],
        personRoutes: [{ type: "finance.review", personId: "eileen-hart" }],
      },
    );
    await office.runtime.handle(submit("c1", "r1"));
    await office.settledFor("ada/r1");

    expect(office.board.list({ type: "finance.review" })).toEqual([
      expect.objectContaining({ assignee: "eileen-hart", createdBy: FRONT }),
    ]);
    // A person works outside the harness: no agent was handed the ticket.
    expect(
      office.scripted.requests.some((request) =>
        request.messages.some(
          (message) => message.role === "user" && textOf(message).includes("TICKET "),
        ),
      ),
    ).toBe(false);
  });

  it("picks a hand-off back up after a restart in the middle of the colleague's turn", async () => {
    const home = directory();
    // The colleague checks the books before it replies; in the first run that check never returns.
    const script: ScriptedScript = (messages) => {
      const delivered = messages.some(
        (message) => message.role === "user" && textOf(message).includes("TICKET "),
      );
      const checked = messages.some(
        (message) => message.role === "toolResult" && message.toolName === "check_books",
      );
      if (delivered && !checked) return { toolCalls: [{ name: "check_books" }] };
      return delegatingScript()(messages);
    };
    let reached: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      reached = resolve;
    });
    // It ends only when the office stops the run, as a tool waiting on a slow system would.
    const stuck = (signal: AbortSignal | undefined) => {
      reached();
      return new Promise<void>((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    const first = await open(home, script, {
      roles: [role(FRONT_MANIFEST), role(BOOK_MANIFEST, stuck)],
    });
    await first.runtime.handle(submit("c1", "r1"));
    await waiting;
    const [ticket] = first.board.list({ type: TYPE });
    expect(ticket?.status).toBe("open");
    await first.close();

    const second = await open(home, script);
    // The restarted runtime is asked about the same request and finds it.
    await second.runtime.handle(submit("c2", "r1"));
    expect(second.sent).toContainEqual({
      type: "accepted",
      id: "c2",
      requestId: "ada/r1",
      disposition: "existing",
    });
    const settled = await second.settledFor("ada/r1");
    expect(settled.event).toEqual({ kind: "settled", status: "done", answer: DELEGATOR_FINAL });

    // Still one ticket and one delivery: the restart resumed the hand-off, it did not repeat it.
    const tickets = second.board.list({ type: TYPE });
    expect(tickets).toEqual([
      expect.objectContaining({ id: ticket?.id, status: "done", result: DELEGATE_RESULT }),
    ]);
    expect(
      second.board.relay
        .deliveriesForTicket(ticket?.id ?? "")
        .filter((delivery) => delivery.targetKey !== ""),
    ).toEqual([expect.objectContaining({ state: "settled" })]);
  });

  it("still hands a remotely approved call its approved facts", async () => {
    const declarations: ApprovalDeclaration[] = [
      { id: "any_payment", tool: "pay", description: "Approve this payment" },
    ];
    const facts = {
      any_payment: async (args: Record<string, unknown>) => ({
        summary: `Pay ${String(args.amount)}`,
        facts: { amount: args.amount as number },
      }),
    };
    const approvals = new RemoteApprovals();
    const paid: unknown[] = [];
    const pay = defineTool({
      name: "pay",
      description: "Pays an amount.",
      parameters: Type.Object({
        amount: Type.Number(),
        [APPROVED_FACTS_ARG]: approvedFactsParameter(),
      }),
      replay: "unsafe",
      execute: async (args) => {
        paid.push(approvedFacts(args));
        return { output: [{ type: "text", text: "paid" }] };
      },
    });
    const extension = defineExtension({
      name: "payer-tools",
      tools: [pay],
      hooks: [approvalGate({ approvals: declarations, approve: approvals.approve, facts })],
    });
    const payer = {
      dir: "/fixture",
      manifest: {
        ...BOOK_MANIFEST,
        id: "payer",
        tools: [{ name: "pay", replay: "unsafe" }],
        approvals: declarations,
      },
      bundle: { extensions: [extension], agent: { extensions: [extension] } },
      approvalFacts: facts,
    } as unknown as LoadedRole;
    const office = await open(
      directory(),
      (messages) =>
        messages.at(-1)?.role === "toolResult"
          ? { text: "Paid." }
          : { toolCalls: [{ name: "pay", args: { amount: 500 } }] },
      { roles: [payer], approvals },
    );
    await office.runtime.handle(submit("c1", "r1", "payer"));
    const asked = await vi.waitFor(
      () => {
        const found = office.sent.find((message) => message.type === "approval");
        if (found?.type !== "approval") throw new Error("not asked yet");
        return found;
      },
      { timeout: 10_000, interval: 20 },
    );
    expect(asked.approval.summary).toBe("Pay 500");
    await office.runtime.handle({
      type: "approve",
      id: "a1",
      approvalId: asked.approval.approvalId,
      decision: "approve",
      principal: ada,
    });
    await office.settledFor("ada/r1");
    expect(paid).toEqual([{ amount: 500 }]);
  });

  describe("a gated call in handed-on work", () => {
    const declarations: ApprovalDeclaration[] = [
      { id: "any_payment", tool: "pay", description: "Approve this payment" },
    ];
    const people = [
      { id: "dana-whitfield", name: "Dana Whitfield" },
      { id: "eileen-hart", name: "Eileen Hart" },
    ];
    // The front desk hands the payment on; the colleague's first move on the ticket is to pay.
    const script: ScriptedScript = (messages) => {
      const delivered = messages.some(
        (message) => message.role === "user" && textOf(message).includes("TICKET "),
      );
      if (!delivered)
        return delegatingScript({ type: TYPE, title: "Pay job 42", detail: "Job 42 is done." })(
          messages,
        );
      return messages.at(-1)?.role === "toolResult"
        ? { text: "Done with the payment." }
        : { toolCalls: [{ name: "pay", args: { amount: 500 } }] };
    };

    /** A runtime whose bookkeeper has one gated tool, `pay`, which records what it paid in `paid`. */
    async function payingOffice(home: string, paid: unknown[]) {
      const approvals = new RemoteApprovals();
      const pay = defineTool({
        name: "pay",
        description: "Pays an amount.",
        parameters: Type.Object({ amount: Type.Number() }),
        replay: "unsafe",
        execute: async (args) => {
          paid.push(args);
          return { output: [{ type: "text", text: "paid" }] };
        },
      });
      const extension = defineExtension({
        name: "payer-tools",
        tools: [pay],
        hooks: [approvalGate({ approvals: declarations, approve: approvals.approve })],
      });
      const payer = {
        dir: "/fixture",
        manifest: {
          ...BOOK_MANIFEST,
          tools: [{ name: "pay", replay: "unsafe" }],
          approvals: declarations,
        },
        bundle: { extensions: [extension], agent: { extensions: [extension] } },
        approvalFacts: {},
      } as unknown as LoadedRole;
      const office = await open(home, script, {
        roles: [role(FRONT_MANIFEST), payer],
        people,
        approvals,
      });
      const approval = (status: "pending" | "approved" | "declined") =>
        vi.waitFor(
          () => {
            const found = office.sent.find(
              (message) => message.type === "approval" && message.approval.status === status,
            );
            if (found?.type !== "approval") throw new Error(`no ${status} approval yet`);
            return found.approval;
          },
          { timeout: 10_000, interval: 20 },
        );
      const decide = (approvalId: string, decision: "approve" | "decline") =>
        office.runtime.handle({ type: "approve", id: "a1", approvalId, decision, principal: ada });
      /** Resolves once the colleague's model has read the result of its `pay` call. */
      const payAnswered = () =>
        vi.waitFor(
          () => {
            const answer = office.scripted.requests
              .flatMap((request) => request.messages)
              .find((message) => message.role === "toolResult" && message.toolName === "pay");
            if (answer === undefined) throw new Error("the pay call has no result yet");
            return textOf(answer);
          },
          { timeout: 10_000, interval: 20 },
        );
      return { ...office, approval, decide, payAnswered };
    }

    it("is asked through the gateway, and runs once when a person approves", async () => {
      const paid: unknown[] = [];
      const office = await payingOffice(directory(), paid);
      await office.runtime.handle(submit("c1", "r1"));

      const asked = await office.approval("pending");
      expect(asked).toMatchObject({ agent: BOOK, tool: "pay" });
      expect(paid).toEqual([]);
      // One authority: the board holds no second request for the same call.
      expect(openApprovalInbox(office.board).list()).toEqual([]);

      await office.decide(asked.approvalId, "approve");
      expect(await office.payAnswered()).toBe("paid");
      expect(paid).toEqual([{ amount: 500 }]);
    });

    it("does not run when a person declines", async () => {
      const paid: unknown[] = [];
      const office = await payingOffice(directory(), paid);
      await office.runtime.handle(submit("c1", "r1"));

      const asked = await office.approval("pending");
      await office.decide(asked.approvalId, "decline");
      expect(await office.payAnswered()).not.toBe("paid");
      expect(paid).toEqual([]);
    });

    it("is still waiting after a restart, and then runs once when approved", async () => {
      const home = directory();
      const paid: unknown[] = [];
      const first = await payingOffice(home, paid);
      await first.runtime.handle(submit("c1", "r1"));
      const asked = await first.approval("pending");
      await first.close();

      const second = await payingOffice(home, paid);
      // The resumed turn asks again for the same call and finds the same request.
      const again = await second.approval("pending");
      expect(again.approvalId).toBe(asked.approvalId);
      expect(paid).toEqual([]);

      await second.decide(again.approvalId, "approve");
      expect(await second.payAnswered()).toBe("paid");
      expect(paid).toEqual([{ amount: 500 }]);
    });
  });

  it("stops its relay when it closes", async () => {
    const office = await open(directory(), delegatingScript());
    await office.runtime.handle(submit("c1", "r1"));
    await office.settledFor("ada/r1");
    await office.runtime.close();

    // The board is still open here: a relay left running would deliver this, or log a failed poll.
    const cursor = office.board.relay.cursor();
    office.board.create(
      {
        type: TYPE,
        title: "After closing",
        createdBy: FRONT,
        provenance: { origin: "internal", sourceChannel: "gateway", sourceContact: "gateway" },
      },
      "after-close",
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(office.board.relay.cursor()).toBe(cursor);
    expect(office.log.filter((line) => line.includes("relay"))).toEqual([]);
  });
});
