/**
 * Completion evidence (RASF-3230): fixture roles with fixture evidence, a real board file, a stub
 * engine, a fake tool runner and a real local file store. No harness and no model: the checker is the
 * host's code, and what it does to the board is the whole claim.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AcceptDeclaration,
  type AgentManifest,
  type EngineResult,
  localFileStore,
  stubEngine,
} from "@officehum/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { openApprovalInbox } from "../approvals/inbox.js";
import {
  awaitingConfirmationText,
  type CompletionOutcome,
  type CompletionRequest,
  completeWithEvidence,
  failedCompletionText,
} from "./evidence.js";
import {
  type Board,
  BoardError,
  COMPLETION_APPROVAL_ID,
  MAX_EVIDENCE_ATTEMPTS,
  openBoard,
  type Ticket,
} from "./index.js";
import { seedPerson } from "./testing.js";

const temps: string[] = [];
const boards: Board[] = [];
afterEach(() => {
  for (const board of boards.splice(0)) board.close();
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function directory(): string {
  const made = mkdtempSync(join(tmpdir(), "officehum-evidence-"));
  temps.push(made);
  return made;
}

const ROLE = "bookkeeper";
/** A well-formed file id that no store holds. */
const MISSING_FILE = `file_${"0".repeat(26)}`;
const EILEEN = { id: "eileen-hart", name: "Eileen Hart" };

/** A board with one person on it (unless told otherwise), since blocked work goes to a person. */
function office(options: { readonly people?: boolean } = {}): Board {
  const file = join(directory(), "office.sqlite");
  if (options.people !== false) seedPerson(file, EILEEN.id, EILEEN.name);
  const board = openBoard(file);
  boards.push(board);
  return board;
}

/** The fixture role: only what the checker reads of a manifest. */
function role(accepts: readonly AcceptDeclaration[]): AgentManifest {
  return { id: ROLE, accepts } as unknown as AgentManifest;
}

let key = 0;
/** A ticket of `type` that the role has taken, as `agent_reply` leaves it before it checks. */
function claimed(board: Board, type: string, payload: unknown = {}): Ticket {
  key += 1;
  const ticket = board.create(
    {
      type,
      title: "Close October",
      createdBy: "frontdesk",
      payload,
      provenance: { origin: "internal", sourceChannel: "test", sourceContact: "desk" },
    },
    `evidence-${key}`,
  );
  return board.claim(ticket.id, ROLE);
}

function reply(
  board: Board,
  ticket: Ticket,
  manifest: AgentManifest,
  rest: Partial<CompletionRequest> = {},
): Promise<CompletionOutcome> {
  return completeWithEvidence({
    board,
    ticketId: ticket.id,
    actor: ROLE,
    result: "Closed.",
    manifest,
    runners: {},
    ...rest,
  });
}

function kinds(board: Board, ticket: Ticket): string[] {
  return board.events(ticket.id).map((event) => event.kind);
}

function lastPayload(board: Board, ticket: Ticket): Record<string, unknown> {
  const events = board.events(ticket.id);
  return events[events.length - 1]?.payload as Record<string, unknown>;
}

describe("engine evidence", () => {
  const manifest = role([
    {
      type: "books.close",
      description: "Close a month",
      done: [{ engine: ["close", "check"], args: { period: "{ticket.data.period}" } }],
    },
  ]);

  it("fails, then passes once the work is fixed: the ticket is done only on the second reply", async () => {
    const board = office();
    const ticket = claimed(board, "books.close", { period: "2026-10" });
    let answer: Partial<EngineResult> = {
      ok: false,
      error: "2 entries are unreconciled",
      data: { unreconciled: 2, amount: 1250.5 },
      findings: [{ id: "variance:2026-10:bank" }],
    };
    const engine = stubEngine({ "close check": () => answer });

    const first = await reply(board, ticket, manifest, { runners: { engine } });
    expect(first.status).toBe("failed");
    expect(board.get(ticket.id)).toMatchObject({ status: "claimed", assignee: ROLE, result: null });
    expect(engine.calls[0]?.args).toEqual(["close", "check", "--period", "2026-10"]);
    expect(kinds(board, ticket)).toEqual(["created", "claimed", "evidence_failed"]);
    expect(lastPayload(board, ticket)).toEqual({
      attempt: 1,
      failures: [
        {
          kind: "engine",
          check: "close check",
          passed: false,
          reason: "2 entries are unreconciled",
          found: {
            findings: ["variance:2026-10:bank"],
            data: { unreconciled: 2, amount: 1250.5 },
            caveats: [],
          },
        },
      ],
    });
    if (first.status !== "failed") throw new Error("unreachable");
    const told = failedCompletionText(first);
    expect(told).toContain(`Ticket ${ticket.id} is not done`);
    expect(told).toContain("attempt 1 of 3");
    expect(told).toContain("- engine close check: 2 entries are unreconciled.");
    expect(told).toContain('"amount":1250.5');

    answer = { ok: true, findings: [{ id: "close:2026-10" }] };
    const second = await reply(board, ticket, manifest, { runners: { engine } });
    expect(second.status).toBe("done");
    expect(board.get(ticket.id)).toMatchObject({ status: "done", result: "Closed." });
    expect(lastPayload(board, ticket)).toEqual({
      result: "Closed.",
      evidence: [
        {
          kind: "engine",
          check: "close check",
          passed: true,
          found: { findings: ["close:2026-10"] },
        },
      ],
    });
  });

  it("does not pass on an ok answer with no finding, a missing engine, or a ticket with no period", async () => {
    const board = office();
    const empty = await reply(
      board,
      claimed(board, "books.close", { period: "2026-10" }),
      manifest,
      {
        runners: { engine: stubEngine({ "close check": { ok: true, findings: [] } }) },
      },
    );
    expect(empty).toMatchObject({
      status: "failed",
      failures: [{ reason: "the engine found nothing that shows the work was done" }],
    });

    const noEngine = await reply(
      board,
      claimed(board, "books.close", { period: "2026-10" }),
      manifest,
    );
    expect(noEngine).toMatchObject({
      status: "failed",
      failures: [{ reason: "this office has no engine for the role to run the check with" }],
    });

    const engine = stubEngine({ "close check": { ok: true, findings: [{ id: "x" }] } });
    const unaddressed = await reply(board, claimed(board, "books.close", {}), manifest, {
      runners: { engine },
    });
    expect(unaddressed).toMatchObject({
      status: "failed",
      failures: [
        {
          reason:
            "the ticket's data has no value for {ticket.data.period}, so the check cannot be addressed",
        },
      ],
    });
    // A check that cannot be addressed is not run against everything instead.
    expect(engine.calls).toEqual([]);
  });
});

describe("tool evidence", () => {
  const manifest = role([
    {
      type: "invoice.create",
      description: "Invoice a job",
      done: [
        { tool: "list_invoices", args: { customer: "{ticket.data.customer}" }, expect: "found" },
      ],
    },
  ]);

  it("fails with the reason while the record is missing, and completes once it is there", async () => {
    const board = office();
    const ticket = claimed(board, "invoice.create", { customer: "Acme" });
    const calls: unknown[] = [];
    let invoices: string[] = [];
    const runTool = async (name: string, args: unknown) => {
      calls.push([name, args]);
      return { details: { found: invoices.length > 0, invoices } };
    };

    const missing = await reply(board, ticket, manifest, { runners: { runTool } });
    expect(missing).toMatchObject({
      status: "failed",
      attempt: 1,
      failures: [
        {
          kind: "tool",
          check: "list_invoices",
          reason: 'found no record for {"customer":"Acme"}',
          found: { found: false, invoices: [] },
        },
      ],
    });
    expect(calls).toEqual([["list_invoices", { customer: "Acme" }]]);
    expect(board.get(ticket.id)?.status).toBe("claimed");

    invoices = ["INV-1042"];
    const present = await reply(board, ticket, manifest, { runners: { runTool } });
    expect(present.status).toBe("done");
    expect(lastPayload(board, ticket)).toEqual({
      result: "Closed.",
      evidence: [
        {
          kind: "tool",
          check: "list_invoices",
          passed: true,
          found: { found: true, invoices: ["INV-1042"] },
        },
      ],
    });
  });

  it("fails closed when the tool errors, throws, or the office cannot run it", async () => {
    const board = office();
    const outcomes = [
      await reply(board, claimed(board, "invoice.create", { customer: "Acme" }), manifest, {
        runners: {
          runTool: async () => ({ details: { found: true }, error: "QuickBooks is down" }),
        },
      }),
      await reply(board, claimed(board, "invoice.create", { customer: "Acme" }), manifest, {
        runners: {
          runTool: async () => {
            throw new Error("no such tool");
          },
        },
      }),
      await reply(board, claimed(board, "invoice.create", { customer: "Acme" }), manifest),
    ];
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["failed", "failed", "failed"]);
    expect(
      outcomes.map((outcome) => (outcome.status === "failed" ? outcome.failures[0]?.reason : "")),
    ).toEqual([
      "the tool failed: QuickBooks is down",
      "the tool could not be run: no such tool",
      "this office has no way to run the role's tool for the check",
    ]);
  });
});

describe("file evidence", () => {
  const manifest = role([
    { type: "report.write", description: "Write a report", done: [{ file: "report" }] },
  ]);

  it("passes only when the reply attaches the named file and the store holds it", async () => {
    const board = office();
    const files = localFileStore(join(directory(), "files"));
    const ref = await files.put({
      bytes: new TextEncoder().encode("October report"),
      name: "report.txt",
      mimeType: "text/plain",
      metadata: { createdBy: ROLE, source: "generated" },
    });

    const none = await reply(board, claimed(board, "report.write"), manifest, {
      runners: { files },
    });
    const unknown = await reply(board, claimed(board, "report.write"), manifest, {
      runners: { files },
      files: { report: MISSING_FILE },
    });
    const noStore = await reply(board, claimed(board, "report.write"), manifest, {
      files: { report: ref.id },
    });
    expect(
      [none, unknown, noStore].map((outcome) =>
        outcome.status === "failed" ? outcome.failures[0]?.reason : outcome.status,
      ),
    ).toEqual([
      'the reply attached no file under "report"; pass it as files: { "report": "<file id>" }',
      `no file ${MISSING_FILE} is in the office's file store`,
      "this office has no file store to look the file up in",
    ]);

    const ticket = claimed(board, "report.write");
    const attached = await reply(board, ticket, manifest, {
      runners: { files },
      files: { report: ref.id },
    });
    expect(attached.status).toBe("done");
    expect(lastPayload(board, ticket)).toEqual({
      result: "Closed.",
      evidence: [
        {
          kind: "file",
          check: "report",
          passed: true,
          found: { fileId: ref.id, name: "report.txt", sha256: ref.sha256 },
        },
      ],
    });
  });
});

describe("person evidence", () => {
  const manifest = role([
    {
      type: "invoice.create",
      description: "Invoice a job",
      done: [
        { tool: "list_invoices", args: { customer: "{ticket.data.customer}" }, expect: "found" },
        { person: true },
      ],
    },
  ]);
  const runTool = async () => ({ details: { found: true, invoices: ["INV-1042"] } });

  it("waits for the person in the Inbox, and their confirmation completes the ticket", async () => {
    const board = office();
    const ticket = claimed(board, "invoice.create", { customer: "Acme" });

    const outcome = await reply(board, ticket, manifest, { runners: { runTool } });
    expect(outcome).toMatchObject({ status: "awaiting_confirmation", person: EILEEN });
    expect(board.get(ticket.id)).toMatchObject({
      status: "awaiting_confirmation",
      assignee: ROLE,
      result: null,
    });
    expect(awaitingConfirmationText(ticket.id, EILEEN)).toContain("waiting for Eileen Hart");

    const inbox = openApprovalInbox(board);
    const [item] = inbox.list();
    expect(item).toMatchObject({
      ticketId: ticket.id,
      tool: "agent_reply",
      args: { ticketId: ticket.id, result: "Closed." },
      requestedBy: ROLE,
      awaiting: EILEEN,
      facts: { summary: 'Confirm "Close October" (invoice.create) is done: Closed.' },
    });
    expect(board.approvals.approvalOf(item?.id ?? "")?.approvalId).toBe(COMPLETION_APPROVAL_ID);

    // The agent cannot finish it by saying so again while the person has not answered.
    await expect(reply(board, ticket, manifest, { runners: { runTool } })).rejects.toMatchObject({
      kind: "invalid_status",
    });

    inbox.decide(item?.id ?? "", { by: EILEEN.id, decision: "approved" });
    expect(board.get(ticket.id)).toMatchObject({ status: "done", result: "Closed." });
    const completed = board.events(ticket.id).at(-1);
    expect(completed).toMatchObject({ kind: "completed", actor: EILEEN.id });
    expect(completed?.payload).toEqual({
      result: "Closed.",
      evidence: [
        {
          kind: "tool",
          check: "list_invoices",
          passed: true,
          found: { found: true, invoices: ["INV-1042"] },
        },
        { kind: "person", check: "person", passed: true, found: { confirmedBy: EILEEN.id } },
      ],
    });
    expect(inbox.list()).toEqual([]);
  });

  it("returns the ticket to the agent when the person says it is not done", async () => {
    const board = office();
    const ticket = claimed(board, "invoice.create", { customer: "Acme" });
    await reply(board, ticket, manifest, { runners: { runTool } });

    board.confirm(ticket.id, EILEEN.id, { confirmed: false, note: "The total is wrong." });
    expect(board.get(ticket.id)).toMatchObject({ status: "claimed", assignee: ROLE, result: null });
    const refused = board.events(ticket.id).at(-1);
    expect(refused).toMatchObject({ kind: "evidence_failed", actor: EILEEN.id });
    expect(refused?.payload).toEqual({
      attempt: 1,
      failures: [{ kind: "person", check: "person", passed: false, reason: "The total is wrong." }],
    });

    // The agent fixes it and replies again: a fresh question, and this time a yes.
    await reply(board, ticket, manifest, { runners: { runTool } });
    expect(board.confirm(ticket.id, EILEEN.id, { confirmed: true }).status).toBe("done");
  });

  it("does not ask when the checks fail, and takes a person's own completion as the confirmation", async () => {
    const board = office();
    const failing = claimed(board, "invoice.create", { customer: "Acme" });
    const outcome = await reply(board, failing, manifest, {
      runners: { runTool: async () => ({ details: { found: false } }) },
    });
    expect(outcome.status).toBe("failed");
    expect(openApprovalInbox(board).list()).toEqual([]);

    const ticket = claimed(board, "invoice.create", { customer: "Acme" });
    const byPerson = await reply(board, ticket, manifest, {
      actor: EILEEN.id,
      runners: { runTool },
    });
    expect(byPerson.status).toBe("done");
    expect((lastPayload(board, ticket).evidence as unknown[]).at(-1)).toEqual({
      kind: "person",
      check: "person",
      passed: true,
      found: { confirmedBy: EILEEN.id },
    });
  });

  it("fails when a person must confirm and the board knows nobody", async () => {
    const board = office({ people: false });
    const ticket = claimed(board, "invoice.create", { customer: "Acme" });
    const outcome = await reply(board, ticket, manifest, { runners: { runTool } });
    expect(outcome).toMatchObject({
      status: "failed",
      failures: [{ kind: "person", passed: false }],
    });
    expect(board.get(ticket.id)?.status).toBe("claimed");
  });

  it("only a person confirms, only a ticket that is waiting, and a moved ticket is left alone", async () => {
    const board = office();
    const ticket = claimed(board, "invoice.create", { customer: "Acme" });
    expect(() => board.confirm(ticket.id, EILEEN.id, { confirmed: true })).toThrow(BoardError);
    await reply(board, ticket, manifest, { runners: { runTool } });
    expect(() => board.confirm(ticket.id, ROLE, { confirmed: true })).toThrowError(
      /Only a person can confirm/,
    );
    expect(() =>
      board.assign(ticket.id, { kind: "agent", id: "frontdesk" }, EILEEN.id),
    ).toThrowError(/awaiting a person's confirmation/);

    // Cancelling the ticket ends the question with it.
    board.cancel(ticket.id, EILEEN.id);
    expect(openApprovalInbox(board).list()).toEqual([]);
    expect(board.get(ticket.id)?.status).toBe("cancelled");
  });
});

describe("three failures", () => {
  const manifest = role([
    {
      type: "books.close",
      description: "Close a month",
      done: [{ engine: ["close", "check"], args: { period: "{ticket.data.period}" } }],
    },
  ]);

  it("blocks the ticket and hands it to a person, with the figures and the owner in the reason", async () => {
    const board = office();
    const ticket = claimed(board, "books.close", { period: "2026-10" });
    const engine = stubEngine({
      "close check": {
        ok: false,
        error: "2 entries are unreconciled",
        data: { unreconciled: 2, amount: 1250.5 },
        findings: [{ id: "variance:2026-10:bank" }],
      },
    });

    const outcomes: CompletionOutcome[] = [];
    for (let attempt = 1; attempt <= MAX_EVIDENCE_ATTEMPTS; attempt += 1) {
      outcomes.push(await reply(board, ticket, manifest, { runners: { engine } }));
    }
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["failed", "failed", "blocked"]);
    expect(board.get(ticket.id)).toMatchObject({ status: "blocked", assignee: EILEEN.id });
    expect(kinds(board, ticket)).toEqual([
      "created",
      "claimed",
      "evidence_failed",
      "evidence_failed",
      "evidence_failed",
      "blocked",
    ]);
    const blocked = lastPayload(board, ticket);
    expect(blocked.assignee).toEqual({ kind: "person", id: EILEEN.id });
    expect(blocked.reason).toBe(
      [
        "Completion evidence failed 3 times. Owner: bookkeeper.",
        "The last attempt failed these checks:",
        '- engine close check: 2 entries are unreconciled. Found: {"findings":["variance:2026-10:bank"],"data":{"unreconciled":2,"amount":1250.5},"caveats":[]}',
      ].join("\n"),
    );
    const last = outcomes[2];
    if (last?.status !== "blocked") throw new Error("unreachable");
    expect(failedCompletionText(last)).toContain("It is with Eileen Hart now.");

    // The ticket is the person's now: the agent's next reply is refused before any check runs.
    const before = engine.calls.length;
    await expect(reply(board, ticket, manifest, { runners: { engine } })).rejects.toMatchObject({
      kind: "unauthorized",
    });
    expect(engine.calls.length).toBe(before);
  });

  it("counts a person's refusals too, and the count survives the board being reopened", async () => {
    const dir = directory();
    const file = join(dir, "office.sqlite");
    seedPerson(file, EILEEN.id, EILEEN.name);
    const personOnly = role([
      { type: "customer.reply", description: "Reply", done: [{ person: true }] },
    ]);
    let board = openBoard(file);
    const ticket = claimed(board, "customer.reply");
    for (let attempt = 1; attempt <= MAX_EVIDENCE_ATTEMPTS; attempt += 1) {
      await reply(board, ticket, personOnly);
      board.close();
      board = openBoard(file);
      board.confirm(ticket.id, EILEEN.id, { confirmed: false, note: `No (${attempt}).` });
    }
    boards.push(board);
    expect(board.get(ticket.id)).toMatchObject({ status: "blocked", assignee: EILEEN.id });
    expect(String(lastPayload(board, ticket).reason)).toContain("- person person: No (3).");
  });
});

describe("a ticket type with no evidence", () => {
  it("completes as before, with a warning on the event", async () => {
    const board = office();
    const ticket = claimed(board, "books.close");
    const outcome = await reply(
      board,
      ticket,
      role([{ type: "books.close", description: "Close" }]),
    );
    expect(outcome).toMatchObject({ status: "done", evidence: [] });
    expect(lastPayload(board, ticket)).toEqual({
      result: "Closed.",
      warning:
        "bookkeeper declares no completion evidence for books.close, so nothing was checked.",
    });

    const unknown = claimed(board, "books.close");
    expect((await reply(board, unknown, undefined as never, { manifest: undefined })).status).toBe(
      "done",
    );
  });

  it("refuses a reply from anyone but the holder before running a check", async () => {
    const board = office();
    const ticket = claimed(board, "books.close", { period: "2026-10" });
    const engine = stubEngine({ "close check": { ok: true, findings: [{ id: "x" }] } });
    const manifest = role([
      { type: "books.close", description: "Close", done: [{ engine: ["close", "check"] }] },
    ]);
    await expect(
      reply(board, ticket, manifest, { actor: "frontdesk", runners: { engine } }),
    ).rejects.toMatchObject({ kind: "unauthorized" });
    expect(engine.calls).toEqual([]);
    expect(kinds(board, ticket)).toEqual(["created", "claimed"]);
  });
});
