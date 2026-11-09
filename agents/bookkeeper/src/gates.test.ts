/**
 * The two gates in front of `create_invoice`, driven with one call each: the role's own gate and the
 * office's must reach the same decision.
 *
 * The role's gate is the SDK's `approvalGate`, which runs the Bookkeeper's code condition and sums the
 * draft's lines itself. The office's gate is `approvalHooks`, which reads `officehum.json` and never
 * runs the role's code, so the only thing it can decide by is the manifest's `when`. RASF-3440 shipped
 * because those two disagreed: the declaration compared an argument called `total`, which
 * `create_invoice` has never had, and `conditionsHold`'s fail-safe turned "a large invoice needs a
 * person" into "every invoice does" — while the code condition, which does know the lines, let small
 * invoices through. A test that asserted the two agree would have failed the moment the declaration
 * drifted from the tool it describes, which is the whole point of this file.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { HookApi, ToolHooks, ToolRegistration } from "@earendil-works/pi-durable";
import {
  type AgentManifest,
  type ApprovalDeclaration,
  type ApprovalRequest,
  type Approver,
  approvedFacts,
  type DefinedRole,
  isApprovalGate,
} from "@officehum/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { approvalHooks } from "../../../packages/office/src/approvals/gate.js";
import type { Board } from "../../../packages/office/src/board/index.js";
import { createWorkboard, seedPerson } from "../../../packages/office/src/board/testing.js";
import manifest from "../officehum.json" with { type: "json" };
import { DEMO_NOW, type FakeAccountingDesk, fakeAccountingDesk } from "./desk.js";
import bookkeeper from "./index.js";

const temps: string[] = [];
afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const PERSON = { id: "maria", name: "Maria Okonkwo" };
const PROVENANCE = { origin: "internal", sourceChannel: "chat", sourceContact: "desk" } as const;
/** The conversation the relay bound to the ticket; the office's hook sees only this number. */
const CONVERSATION = 7;

type BeforeTool = ToolHooks["beforeTool"];
const CONTEXT = {} as Parameters<BeforeTool>[2];

interface Fixture {
  readonly file: string;
  readonly board: Board;
  readonly ticketId: string;
  close(): void;
}

function openFixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "officehum-bookkeeper-gates-"));
  temps.push(directory);
  const file = join(directory, "office.sqlite");
  seedPerson(file, PERSON.id, PERSON.name);
  const board = createWorkboard(file);
  const ticket = board.create(
    {
      type: "invoice.create",
      title: "Invoice the consulting month",
      detail: "A completed job.",
      createdBy: "bookkeeper",
      provenance: PROVENANCE,
    },
    "invoice-key",
  );
  board.bindConversation(CONVERSATION, { ticketId: ticket.id, agent: "bookkeeper" });
  return { file, board, ticketId: ticket.id, close: () => board.close() };
}

/** Approval rows in the board's own table: the office's record of what it put in front of a person. */
function rows(file: string): number {
  const database = new DatabaseSync(file);
  try {
    const row = database.prepare("SELECT COUNT(*) AS n FROM approvals").get() as { n: number };
    return row.n;
  } finally {
    database.close();
  }
}

/**
 * Both gates over one board, sharing the limits the role resolves — the manifest's `large_invoice` and
 * any overlay on top of it. The gates are built from the same role so neither can be handed a
 * threshold the other was not.
 */
function gates(board: Board): { readonly role: BeforeTool; readonly office: BeforeTool } {
  const role = bookkeeper({});
  const registration = role.extensions
    .flatMap((extension) => extension.hooks ?? [])
    .find(isApprovalGate);
  if (registration === undefined) throw new Error("the Bookkeeper installs no approval gate");
  const { handlers } = registration as unknown as { handlers: Pick<ToolHooks, "beforeTool"> };
  const office = approvalHooks({
    board,
    declarations: (manifest as unknown as AgentManifest).approvals as ApprovalDeclaration[],
    limits: role.current().limits,
  })[0];
  if (office === undefined) throw new Error("the office registered no approval gate");
  const officeHooks = office as unknown as { handlers: Pick<ToolHooks, "beforeTool"> };
  return { role: handlers.beforeTool, office: officeHooks.handlers.beforeTool };
}

/** A stand-in for the tool task's hook api: the role's gate keeps its memos in a map. */
function hookApi(memos = new Map<string, unknown>()): HookApi {
  return {
    taskId: "task-1",
    conversationId: CONVERSATION,
    memo: async (name: string, ...rest: unknown[]) => {
      if (rest.length === 2 && !memos.has(name)) memos.set(name, rest[0]);
      return memos.get(name);
    },
    snapshot: async () => undefined,
    snapshotAsOf: async () => undefined,
  } as unknown as HookApi;
}

/** A model-issued tool call, in the shape the hook receives it. */
function call(name: string, args: Record<string, unknown>): Parameters<BeforeTool>[0] {
  return { type: "toolCall", id: "call-1", name, arguments: args } as Parameters<BeforeTool>[0];
}

interface Line {
  readonly description: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
}

/** What both gates decided about one call, and what the office gate wrote down. */
async function decide(tool: string, args: Record<string, unknown>) {
  const fixture = openFixture();
  try {
    const { role, office } = gates(fixture.board);
    const byRole = await role(call(tool, args), hookApi(), CONTEXT);
    const byOffice = await office(call(tool, args), hookApi(), CONTEXT);
    return {
      roleBlocked: byRole?.block !== undefined,
      officeBlocked: byOffice?.block !== undefined,
      roleText: byRole?.block ?? "",
      pending: fixture.board.approvals.pendingApprovals(),
      rows: rows(fixture.file),
    };
  } finally {
    fixture.close();
  }
}

const line = (quantity: number, unitPriceCents: number): Line => ({
  description: "Consulting",
  quantity,
  unitPriceCents,
});

/** A `create_invoice` call's arguments; the lines are the only part any test varies. */
const invoice = (lines: readonly unknown[]) => ({
  customer: "customer-1",
  lines,
  dueInDays: 30,
  jobReference: "JOB-1042",
});

describe("the Bookkeeper's two gates", () => {
  it("both let a small invoice through, and the office writes no row", async () => {
    const decided = await decide("create_invoice", invoice([line(3, 12000)]));
    expect(decided.roleBlocked).toBe(false);
    // The bug RASF-3440 fixes: this used to be `true` — the office asked a person about 360.00.
    expect(decided.officeBlocked).toBe(false);
    expect(decided.rows).toBe(0);
    expect(decided.pending).toEqual([]);
  });

  it("both let an invoice exactly at the limit through", async () => {
    const decided = await decide("create_invoice", invoice([line(5, 100000)]));
    expect(decided.roleBlocked).toBe(false);
    expect(decided.officeBlocked).toBe(false);
    expect(decided.rows).toBe(0);
  });

  it("both hold an invoice one cent over the limit, as one `large_invoice` row", async () => {
    const decided = await decide("create_invoice", invoice([line(5, 100000), line(1, 1)]));
    expect(decided.roleBlocked).toBe(true);
    expect(decided.officeBlocked).toBe(true);
    // The role's gate names the approval by its description; the office's records the declaration's id.
    expect(decided.roleText).toContain("more than the business's set amount");
    expect(decided.pending).toMatchObject([
      { approvalId: "large_invoice", tool: "create_invoice" },
    ]);
    expect(decided.rows).toBe(1);
  });

  it("agree on every boundary, in both directions", async () => {
    for (const lines of [
      [line(3, 12000)],
      [line(5, 100000)],
      [line(5, 100000), line(1, 1)],
      [line(10, 90000)],
    ]) {
      const decided = await decide("create_invoice", invoice(lines));
      expect(decided.officeBlocked).toBe(decided.roleBlocked);
    }
  });

  it("agree when neither can total the draft: both ask for a person", async () => {
    // A line with no price, a price that is not a number, and no lines at all. The role's code refuses
    // each of them, and the SDK's sum refuses them too rather than skipping an element and reporting a
    // smaller total — the one disagreement that would let a large invoice through the office gate.
    for (const lines of [[{ quantity: 1 }], [{ quantity: 1, unitPriceCents: "500000" }], []]) {
      const decided = await decide("create_invoice", invoice(lines));
      expect(decided.roleBlocked).toBe(true);
      expect(decided.officeBlocked).toBe(true);
      expect(decided.rows).toBe(1);
    }
  });

  it("differ on purpose about a send: the office cannot see the address on file", async () => {
    // The one place the two gates are meant to disagree (RASF-3440, README: "new_recipient
    // over-blocks in Office Hum, on purpose"). `new_recipient` is a code condition — it reads the
    // customer's address through the client — so the declaration has no `when`, and the office gate
    // asks a person about every send, including this one that names no address at all. This test is
    // the record: when the gateway supplies address history and the declaration gains a `when`, it
    // should fail, and the README paragraph should go with it.
    const decided = await decide("send_invoice", { invoice: "1042" });
    expect(decided.roleBlocked).toBe(false);
    expect(decided.officeBlocked).toBe(true);
    expect(decided.pending).toMatchObject([{ approvalId: "new_recipient", tool: "send_invoice" }]);
  });
});

/** The role's own gate, as `defineRole` installed it. */
function roleGate(role: DefinedRole): BeforeTool {
  const registration = role.extensions
    .flatMap((extension) => extension.hooks ?? [])
    .find(isApprovalGate);
  if (registration === undefined) throw new Error("the Bookkeeper installs no approval gate");
  return (registration as unknown as { handlers: Pick<ToolHooks, "beforeTool"> }).handlers
    .beforeTool;
}

/** One of the role's tools, by name. */
function roleTool(role: DefinedRole, name: string): ToolRegistration {
  const tool = role.extensions
    .flatMap((extension) => extension.tools ?? [])
    .find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`the Bookkeeper has no ${name}`);
  return tool;
}

const identity = { conversationId: CONVERSATION, taskId: "task-1", callId: "call-1" } as never;

function toolText(result: { output?: readonly unknown[] }): string {
  return (result.output ?? []).map((block) => (block as { text?: string }).text ?? "").join("\n");
}

describe("the payment approval", () => {
  const accounts = (): FakeAccountingDesk => fakeAccountingDesk({ now: () => new Date(DEMO_NOW) });

  it("the payment approval shows desk-read facts", async () => {
    const asked: ApprovalRequest[] = [];
    const approve: Approver = async (request) => {
      asked.push(request);
      return { approved: true };
    };
    const role = bookkeeper({ desk: accounts(), approve, now: () => new Date(DEMO_NOW) });
    const result = await roleGate(role)(
      call("pay_vendor_bill", { billId: "BILL-2001" }),
      hookApi(),
      CONTEXT,
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]?.approvalId).toBe("any_payment");
    expect(asked[0]?.arguments).toEqual({ billId: "BILL-2001" });
    expect(asked[0]?.facts?.summary).toBe(
      "Pay BILL-2001 to Rainier Cleaning Tools, supplier invoice RT-5520: $648.00, recorded by Eileen Hart from PDF invoice RT-5520 emailed by sales@rainiertools.example on 2026-10-05",
    );
    // The tool is handed exactly what the person was shown.
    expect(approvedFacts(result?.arguments ?? {})).toEqual(asked[0]?.facts?.facts);
  });

  it("a restart between approval and pay pays once", async () => {
    const desk = accounts();
    const memos = new Map<string, unknown>();
    let asks = 0;
    const approve: Approver = async () => {
      asks += 1;
      return { approved: true };
    };
    const payCall = call("pay_vendor_bill", { billId: "BILL-2001" });

    // The person approves, then the process dies before the tool runs.
    const before = bookkeeper({ desk, approve, now: () => new Date(DEMO_NOW) });
    const granted = await roleGate(before)(payCall, hookApi(memos), CONTEXT);
    expect((await desk.listVendorBills({ billId: "BILL-2001" }))[0]?.status).toBe("overdue");

    // A fresh role over the same desk; the tool task is recovered with its memos and runs once.
    const after = bookkeeper({ desk, approve, now: () => new Date(DEMO_NOW) });
    const regranted = await roleGate(after)(payCall, hookApi(memos), CONTEXT);
    expect(regranted).toEqual(granted);
    const paid = await roleTool(after, "pay_vendor_bill").execute(
      regranted?.arguments ?? {},
      identity,
      BACKGROUND_CONTEXT,
    );

    expect(asks).toBe(1);
    expect(toolText(paid)).toContain("Paid BILL-2001");
    const paymentId = (paid as { details?: { id?: string } }).details?.id;
    expect((await desk.listVendorBills({ billId: "BILL-2001" }))[0]?.paymentId).toBe(paymentId);
    // Only one payment exists: another call for the bill is refused as already paid.
    const other = await roleTool(after, "pay_vendor_bill").execute(
      regranted?.arguments ?? {},
      { conversationId: CONVERSATION, taskId: "task-2", callId: "call-2" } as never,
      BACKGROUND_CONTEXT,
    );
    expect((other as { details?: { code?: string } }).details?.code).toBe("already_paid");
  });

  it("a pay call replayed after a restart answers with the first payment", async () => {
    const desk = accounts();
    const memos = new Map<string, unknown>();
    let asks = 0;
    const approve: Approver = async () => {
      asks += 1;
      return { approved: true };
    };
    const payCall = call("pay_vendor_bill", { billId: "BILL-2001" });

    const before = bookkeeper({ desk, approve, now: () => new Date(DEMO_NOW) });
    const granted = await roleGate(before)(payCall, hookApi(memos), CONTEXT);
    const first = await roleTool(before, "pay_vendor_bill").execute(
      granted?.arguments ?? {},
      identity,
      BACKGROUND_CONTEXT,
    );

    // The process restarts after the payment: the same call runs again against a fresh role.
    const after = bookkeeper({ desk, approve, now: () => new Date(DEMO_NOW) });
    const regranted = await roleGate(after)(payCall, hookApi(memos), CONTEXT);
    expect(regranted).toEqual(granted);
    const again = await roleTool(after, "pay_vendor_bill").execute(
      regranted?.arguments ?? {},
      identity,
      BACKGROUND_CONTEXT,
    );

    expect(asks).toBe(1);
    expect(toolText(again)).toBe(toolText(first));
    expect(toolText(first)).toContain("Paid BILL-2001");
    const paymentId = (first as { details?: { id?: string } }).details?.id;
    expect((await desk.listVendorBills({ billId: "BILL-2001" }))[0]?.paymentId).toBe(paymentId);
  });
});
