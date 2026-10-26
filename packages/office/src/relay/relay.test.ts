/**
 * The relay's tests (RASF-3067).
 *
 * Everything runs offline and deterministically: a scripted provider stands in for the model, the
 * board and the office are real SQLite files so a restart is a real restart, and no test touches the
 * network. The crash tests are the ones that matter — they pause the relay at a kill point, close
 * both files, reopen them, and assert that each event was delivered once, the work completed once,
 * and the cursor never passed an undelivered event.
 *
 * A crash is simulated by letting an error from the transport propagate out of `pollOnce`, which is
 * what a real crash does to the ledger: nothing is caught and settled, so the row stays `pending` or
 * `admitted` and `recover` finds it. Nothing here kills a process.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRef } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { type Office, openOffice } from "../adapter/index.js";
import type { Board } from "../board/index.js";
import { createWorkboard, seedPerson } from "../board/testing.js";
import {
  type ScriptedModel,
  type ScriptedRequest,
  type ScriptedScript,
  scriptedProvider,
} from "../testing/scripted-model.js";
import { type DeliveryGuards, openGuards } from "./guards.js";
import { EXTERNAL_FENCE } from "./message.js";
import { buildRouting, createRelay, type Relay, relayTicketKey } from "./relay.js";
import { type DeliveryTarget, harnessTransport, type RelayTransport } from "./transport.js";

const temps: string[] = [];
afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const DIRECTORY = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "officehum-relay-"));
  temps.push(directory);
  return directory;
};

const ANSWER = "Invoice 42 is paid.";
const ROLE = "bookkeeper";
const TRIAGE_ROLE = "office-manager";
const TYPE = "invoice.create";
const UNKNOWN_TYPE = "mystery.thing";

type RoleSpec = {
  readonly roleKey: string;
  readonly accepts: readonly string[];
  readonly model: ModelRef;
};

/** Where a test asks the fixture to crash: after admission, or after the delegate's work settled. */
type KillPoints = {
  /** Throw before the wrapped message is ever submitted. */
  beforeDelivery: boolean;
  /** Throw after admission, before the relay sees the settlement. */
  beforeSettlement: boolean;
  /** Throw after the settlement was observed. */
  afterSettlement: boolean;
  /** Runs once the delegate's work settled, before a post-settlement crash. */
  onSettled?: () => void;
};

interface Fixture {
  readonly directory: string;
  readonly board: Board;
  readonly office: Office;
  readonly relay: Relay;
  readonly scripted: ScriptedModel;
  readonly roles: readonly RoleSpec[];
  readonly kill: KillPoints;
  /** Open a second board, office and relay over the same two files. */
  reopen(): Promise<Fixture>;
  close(): Promise<void>;
}

/**
 * One office as a test needs it: a board file, a harness file, a relay over a scripted model, and a
 * transport whose kill points the test flips between runs.
 */
async function openFixture(options: {
  readonly directory: string;
  readonly script: ScriptedScript;
  readonly roles: (model: ModelRef) => readonly RoleSpec[];
  readonly guards?: DeliveryGuards;
  /** Reuse a provider across a reopen, so the script position (and the call count) carries over. */
  readonly scripted?: ScriptedModel;
}): Promise<Fixture> {
  const scripted = options.scripted ?? scriptedProvider(options.script);
  const board = createWorkboard(join(options.directory, "office.sqlite"));
  const office = await openOffice({
    storage: { sqlite: join(options.directory, "harness.sqlite") },
    models: scripted.models,
  });
  const roles = options.roles(scripted.model);
  const inner = harnessTransport(office);
  const kill: KillPoints = {
    beforeDelivery: false,
    beforeSettlement: false,
    afterSettlement: false,
  };
  const transport: RelayTransport = {
    kind: "harness",
    async deliver(target: DeliveryTarget, message) {
      if (kill.beforeDelivery) throw new Error("simulated crash before delivery");
      const handle = await inner.deliver(target, message);
      return {
        id: handle.id,
        async wait() {
          if (kill.beforeSettlement) throw new Error("simulated crash during the delegate's run");
          const outcome = await handle.wait();
          kill.onSettled?.();
          if (kill.afterSettlement) throw new Error("simulated crash after the settlement");
          return outcome;
        },
      };
    },
    reacquire: (target) => inner.reacquire(target),
  };
  const relay = createRelay({
    office,
    board,
    transport,
    routing: roles.map((role) => ({
      roleKey: role.roleKey,
      agent: { model: role.model },
      accepts: role.accepts,
    })),
    guards: options.guards ?? openGuards(),
    now: () => Date.now(),
  });
  const fixture: Fixture = {
    directory: options.directory,
    board,
    office,
    relay,
    scripted,
    roles,
    kill,
    async reopen() {
      return await openFixture({ ...options, scripted });
    },
    async close() {
      await office.close();
      board.close();
    },
  };
  return fixture;
}

/** The user-role text one recorded request carried, in order. */
function userTexts(request: ScriptedRequest | undefined): string[] {
  return (request?.messages ?? []).flatMap((message) =>
    message.role === "user"
      ? typeof message.content === "string"
        ? [message.content]
        : message.content.filter((block) => block.type === "text").map((block) => block.text)
      : [],
  );
}

/** The relayed message text of the last request the scripted model saw. */
function relayedText(scripted: ScriptedModel): string {
  const last = scripted.requests[scripted.requests.length - 1];
  const texts = userTexts(last).filter((text) => text.includes("TICKET "));
  return texts[texts.length - 1] ?? "";
}

describe("relay routing table", () => {
  it("refuses two roles that accept one ticket type", () => {
    expect(() =>
      buildRouting([
        { roleKey: ROLE, agent: {}, accepts: [TYPE] },
        { roleKey: TRIAGE_ROLE, agent: {}, accepts: [TYPE] },
      ]),
    ).toThrow(/both accept ticket type/);
  });

  it("routes an unknown ticket type to the office-manager triage role", async () => {
    const fixture = await openFixture({
      directory: DIRECTORY(),
      script: [{ text: "taken as triage" }],
      roles: (model) => [
        { roleKey: ROLE, accepts: [TYPE], model },
        { roleKey: TRIAGE_ROLE, accepts: ["triage.unknown"], model },
      ],
    });
    try {
      const ticket = await fixture.relay.dispatch(UNKNOWN_TYPE, dispatch("Unknown thing"));
      await fixture.relay.pollOnce();

      const [row] = fixture.board.relay.deliveriesForTicket(ticket.id);
      expect(row?.state).toBe("settled");
      expect(row?.targetKey).toBe(relayTicketKey(TRIAGE_ROLE, ticket.id));
      expect(relayedText(fixture.scripted)).toContain("No role accepts ticket type");
      // Nothing was delivered to the one role that does not accept it.
      expect(fixture.scripted.requests).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("no triage role routes to a person and the event is skipped", async () => {
    const directory = DIRECTORY();
    seedPerson(join(directory, "office.sqlite"), "pat", "Pat");
    const fixture = await openFixture({
      directory,
      script: [{ text: "unused" }],
      roles: (model) => [{ roleKey: ROLE, accepts: [TYPE], model }],
    });
    try {
      const ticket = await fixture.relay.dispatch(UNKNOWN_TYPE, dispatch("Unknown thing"));
      await fixture.relay.pollOnce();

      const moved = fixture.board.get(ticket.id);
      expect(moved?.assignee).toBe("pat");
      expect(moved?.status).toBe("waiting");
      const [row] = fixture.board.relay.deliveriesForTicket(ticket.id);
      expect(row?.state).toBe("skipped");
      expect(row?.targetKey).toBe("");
      // A person is outside the harness: nothing was ever submitted.
      expect(fixture.scripted.calls).toBe(0);
    } finally {
      await fixture.close();
    }
  });
});

describe("relay delivery", () => {
  it("delegation by type completes and the waiting call returns the delegate's result", async () => {
    const fixture = await openFixture({
      directory: DIRECTORY(),
      script: [{ text: ANSWER }],
      roles: (model) => [{ roleKey: ROLE, accepts: [TYPE], model }],
    });
    try {
      const ticket = await fixture.relay.dispatch(TYPE, dispatch("Invoice 42"));
      await fixture.relay.pollOnce();

      const rows = fixture.board.relay.deliveriesForTicket(ticket.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.state).toBe("settled");
      expect(rows[0]?.outcome).toBe(ANSWER);
      expect(fixture.scripted.calls).toBe(1);

      complete(fixture, ticket.id);
      const result = await fixture.relay.wait(ticket.id, { timeoutMs: 5_000 });
      expect(result).toEqual({
        ok: true,
        ticketId: ticket.id,
        status: "completed",
        answer: ANSWER,
      });
    } finally {
      await fixture.close();
    }
  });

  it("external-origin ticket is wrapped untrusted and internal is not", async () => {
    const fixture = await openFixture({
      directory: DIRECTORY(),
      script: [{ text: "seen" }, { text: "seen again" }],
      roles: (model) => [{ roleKey: ROLE, accepts: [TYPE], model }],
    });
    try {
      const external = await fixture.relay.dispatch(TYPE, {
        ...dispatch("From a customer"),
        provenance: { origin: "external", sourceChannel: "email", sourceContact: "c@example.com" },
      });
      await fixture.relay.pollOnce();
      const externalText = relayedText(fixture.scripted);
      expect(externalText).toContain(EXTERNAL_FENCE);
      expect(externalText).toContain("untrusted content begins");
      expect(fixture.board.relay.deliveriesForTicket(external.id)[0]?.state).toBe("settled");

      const internal = await fixture.relay.dispatch(TYPE, dispatch("From the office"));
      await fixture.relay.pollOnce();
      const internalText = relayedText(fixture.scripted);
      expect(internalText).toContain("From the office");
      expect(internalText).not.toContain(EXTERNAL_FENCE);
      expect(fixture.board.relay.deliveriesForTicket(internal.id)[0]?.state).toBe("settled");
    } finally {
      await fixture.close();
    }
  });

  it("a completed event settles the wait without being submitted as input", async () => {
    const fixture = await openFixture({
      directory: DIRECTORY(),
      script: [{ text: ANSWER }],
      roles: (model) => [{ roleKey: ROLE, accepts: [TYPE], model }],
    });
    try {
      const ticket = await fixture.relay.dispatch(TYPE, dispatch("Invoice 42"));
      await fixture.relay.pollOnce();
      complete(fixture, ticket.id);

      const before = fixture.scripted.calls;
      await fixture.relay.pollOnce();
      expect(fixture.scripted.calls).toBe(before);

      const completed = fixture.board.relay
        .deliveriesForTicket(ticket.id)
        .find((row) => row.kind === "completed");
      expect(completed?.state).toBe("settled");
      expect(completed?.targetKey).toBe("");
      expect(fixture.board.relay.cursor()).toBe(fixture.board.events(ticket.id).at(-1)?.seq ?? 0);
    } finally {
      await fixture.close();
    }
  });

  it("a refusing guard aborts the delivery and leaves nothing submitted", async () => {
    const refusing: DeliveryGuards = {
      ...openGuards(),
      async checkHops() {
        return { allowed: false, reason: "hop budget exhausted" };
      },
    };
    const fixture = await openFixture({
      directory: DIRECTORY(),
      script: [{ text: "should never run" }],
      roles: (model) => [{ roleKey: ROLE, accepts: [TYPE], model }],
      guards: refusing,
    });
    try {
      const ticket = await fixture.relay.dispatch(TYPE, dispatch("Invoice 42"));
      await fixture.relay.pollOnce();

      const [row] = fixture.board.relay.deliveriesForTicket(ticket.id);
      expect(row?.state).toBe("failed");
      expect(row?.outcome).toBe("hop budget exhausted");
      expect(row?.submissionId).toBeNull();
      expect(fixture.scripted.calls).toBe(0);
      // The cursor still moved: the event was accounted for, just not delivered.
      expect(fixture.board.relay.cursor()).toBe(fixture.board.events(ticket.id)[0]?.seq);
    } finally {
      await fixture.close();
    }
  });

  it("an agent-assigned ticket delivers the assignment and a comment, and not the claim", async () => {
    const fixture = await openFixture({
      directory: DIRECTORY(),
      script: [{ text: "first" }, { text: "second" }, { text: "third" }],
      roles: (model) => [{ roleKey: ROLE, accepts: [TYPE], model }],
    });
    try {
      const ticket = await fixture.relay.dispatch(TYPE, dispatch("Invoice 42"));
      await fixture.relay.pollOnce();
      fixture.board.claim(ticket.id, ROLE);
      fixture.board.assign(ticket.id, { kind: "agent", id: ROLE }, TRIAGE_ROLE);
      fixture.board.comment(ticket.id, TRIAGE_ROLE, "Please hurry.");
      await fixture.relay.pollOnce();

      const rows = fixture.board.relay.deliveriesForTicket(ticket.id);
      expect(rows.map((row) => [row.kind, row.state])).toEqual([
        ["created", "settled"],
        ["claimed", "skipped"],
        ["assigned", "settled"],
        ["commented", "settled"],
      ]);
      // The assignment and the comment reached the same agent conversation: one context per ticket.
      const key = relayTicketKey(ROLE, ticket.id);
      expect(rows[2]?.targetKey).toBe(key);
      expect(rows[3]?.targetKey).toBe(key);
      expect(fixture.scripted.calls).toBe(3);
    } finally {
      await fixture.close();
    }
  });

  it("the wait settles once and a second wait returns the same result", async () => {
    const fixture = await openFixture({
      directory: DIRECTORY(),
      script: [{ text: ANSWER }],
      roles: (model) => [{ roleKey: ROLE, accepts: [TYPE], model }],
    });
    try {
      const ticket = await fixture.relay.dispatch(TYPE, dispatch("Invoice 42"));
      await fixture.relay.pollOnce();
      complete(fixture, ticket.id);

      const first = await fixture.relay.wait(ticket.id, { timeoutMs: 5_000 });
      const calls = fixture.scripted.calls;
      const second = await fixture.relay.wait(ticket.id, { timeoutMs: 5_000 });
      expect(second).toEqual(first);
      expect(fixture.scripted.calls).toBe(calls);
      expect(fixture.board.relay.wait(ticket.id)).toBeDefined();
    } finally {
      await fixture.close();
    }
  });
});

describe("relay crash and restart", () => {
  it("restart after create delivers the created event once", async () => {
    const directory = DIRECTORY();
    const fixture = await openFixture({
      directory,
      script: [{ text: ANSWER }],
      roles: (model) => [{ roleKey: ROLE, accepts: [TYPE], model }],
    });
    const ticket = await fixture.relay.dispatch(TYPE, dispatch("Invoice 42"));
    fixture.kill.beforeDelivery = true;
    await expect(fixture.relay.pollOnce()).rejects.toThrow(/simulated crash/);

    // The row was written and the cursor moved before the delivery was attempted: the cursor is not
    // past an undelivered event, and the event is still visible as a non-terminal row.
    const [crashed] = fixture.board.relay.deliveriesForTicket(ticket.id);
    expect(crashed?.state).toBe("pending");
    expect(fixture.board.relay.cursor()).toBe(crashed?.seq ?? -1);
    expect(fixture.scripted.calls).toBe(0);
    await fixture.close();

    const reopened = await fixture.reopen();
    try {
      await reopened.relay.recover();
      const rows = reopened.board.relay.deliveriesForTicket(ticket.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.state).toBe("settled");
      expect(rows[0]?.outcome).toBe(ANSWER);
      expect(reopened.scripted.calls).toBe(1);
    } finally {
      await reopened.close();
    }
  });

  it("restart during the delegate's run settles it once and resolves the wait", async () => {
    const directory = DIRECTORY();
    const fixture = await openFixture({
      directory,
      script: [{ text: ANSWER }],
      roles: (model) => [{ roleKey: ROLE, accepts: [TYPE], model }],
    });
    const ticket = await fixture.relay.dispatch(TYPE, dispatch("Invoice 42"));
    fixture.kill.beforeSettlement = true;
    await expect(fixture.relay.pollOnce()).rejects.toThrow(/simulated crash/);

    const [crashed] = fixture.board.relay.deliveriesForTicket(ticket.id);
    expect(crashed?.state).toBe("admitted");
    expect(crashed?.submissionId).not.toBeNull();
    await fixture.close();

    const reopened = await fixture.reopen();
    try {
      await reopened.relay.recover();
      const rows = reopened.board.relay.deliveriesForTicket(ticket.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.state).toBe("settled");
      // The same submission, resumed, ran the delegate exactly once.
      expect(reopened.scripted.calls).toBe(1);

      complete(reopened, ticket.id);
      const result = await reopened.relay.wait(ticket.id, { timeoutMs: 5_000 });
      expect(result).toEqual({
        ok: true,
        ticketId: ticket.id,
        status: "completed",
        answer: ANSWER,
      });
    } finally {
      await reopened.close();
    }
  });

  it("restart after completion before the delegator resumes returns the same result without re-running", async () => {
    const directory = DIRECTORY();
    const fixture = await openFixture({
      directory,
      script: [{ text: ANSWER }],
      roles: (model) => [{ roleKey: ROLE, accepts: [TYPE], model }],
    });
    const ticket = await fixture.relay.dispatch(TYPE, dispatch("Invoice 42"));

    // The delegator asks before the delegate has done anything: the wait's task is durable, so it is
    // the same task after the restart.
    const waiting = fixture.relay.wait(ticket.id, { timeoutMs: 10_000 });
    void waiting.catch(() => undefined);
    fixture.kill.afterSettlement = true;
    fixture.kill.onSettled = () => complete(fixture, ticket.id);
    await expect(fixture.relay.pollOnce()).rejects.toThrow(/simulated crash/);
    expect(fixture.scripted.calls).toBe(1);

    const [crashed] = fixture.board.relay.deliveriesForTicket(ticket.id);
    expect(crashed?.state).toBe("admitted");
    await fixture.close();

    const reopened = await fixture.reopen();
    try {
      await reopened.relay.recover();
      expect(reopened.scripted.calls).toBe(1);

      const result = await reopened.relay.wait(ticket.id, { timeoutMs: 10_000 });
      expect(result).toEqual({
        ok: true,
        ticketId: ticket.id,
        status: "completed",
        answer: ANSWER,
      });
      // The work did not run again: the answer came from the first, resumed run.
      expect(reopened.scripted.calls).toBe(1);
      expect(reopened.board.relay.deliveriesForTicket(ticket.id)).toHaveLength(1);
    } finally {
      await reopened.close();
    }
  });
});

/** A dispatch request with the office's usual internal provenance. */
function dispatch(title: string) {
  return {
    title,
    detail: "Please pay it.",
    createdBy: "front-desk",
    provenance: { origin: "internal" as const, sourceChannel: "chat", sourceContact: "desk" },
  };
}

/**
 * The board's own moves, standing in for the agent-facing tools RASF-3109 adds: a delegate claims
 * the ticket and then completes it. Called from the test, as the delegate's role.
 */
function complete(fixture: Fixture, ticketId: string): void {
  const ticket = fixture.board.get(ticketId);
  if (ticket === undefined) throw new Error(`No ticket ${ticketId}.`);
  if (ticket.status === "open") fixture.board.claim(ticketId, ROLE);
  const current = fixture.board.get(ticketId);
  if (current === undefined) throw new Error(`No ticket ${ticketId}.`);
  if (current.status !== "done" && current.status !== "cancelled") {
    fixture.board.complete(ticketId, ROLE);
  }
}
