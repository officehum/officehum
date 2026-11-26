/**
 * The Bookkeeper's approval gate in front of `create_invoice` and `send_invoice`, driven with one call
 * each, and the manifest's `when` held to the same answer.
 *
 * There is one approval path in an office: the role's own gate, the SDK's `approvalGate`,
 * which runs the Bookkeeper's code conditions. The manifest's `large_invoice` `when` still states the
 * policy a person reads on the card, and a bug once shipped because that statement drifted from the
 * tool (it compared an argument called `total`, which `create_invoice` has never had). So the gate's
 * decision on every boundary is compared with what the manifest's `when` says; a declaration that
 * drifted from the tool it describes fails here.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { HookApi, ToolHooks, ToolRegistration } from "@earendil-works/pi-durable";
import {
  type AgentManifest,
  type ApprovalRequest,
  type Approver,
  approvedFacts,
  conditionsHold,
  type DefinedRole,
  isApprovalGate,
} from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import manifest from "../officehum.json" with { type: "json" };
import { DEMO_NOW, type FakeAccountingDesk, fakeAccountingDesk } from "./desk.js";
import bookkeeper from "./index.js";

/** The conversation a gated call belongs to; the gate sees only this number. */
const CONVERSATION = 7;

type BeforeTool = ToolHooks["beforeTool"];
const CONTEXT = {} as Parameters<BeforeTool>[2];

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

/**
 * What the role's gate decided about one call, which approvals it asked, and what the manifest's
 * `large_invoice` `when` says about the same arguments under the role's own limits.
 */
async function decide(tool: string, args: Record<string, unknown>) {
  const asked: string[] = [];
  const role = bookkeeper({
    approve: async (request) => {
      asked.push(request.approvalId);
      return { approved: false, pending: true };
    },
  });
  const byRole = await roleGate(role)(call(tool, args), hookApi(), CONTEXT);
  const declaration = (manifest as unknown as AgentManifest).approvals.find(
    (approval) => approval.id === "large_invoice",
  );
  return {
    blocked: byRole?.block !== undefined,
    text: byRole?.block ?? "",
    asked,
    manifestSays:
      declaration?.when === undefined
        ? true
        : conditionsHold(declaration.when, args, role.current().limits),
  };
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

describe("the Bookkeeper's gate and its declaration", () => {
  it("lets a small invoice through, asking nobody", async () => {
    const decided = await decide("create_invoice", invoice([line(3, 12000)]));
    expect(decided.blocked).toBe(false);
    expect(decided.asked).toEqual([]);
    expect(decided.manifestSays).toBe(false);
  });

  it("lets an invoice exactly at the limit through", async () => {
    const decided = await decide("create_invoice", invoice([line(5, 100000)]));
    expect(decided.blocked).toBe(false);
    expect(decided.manifestSays).toBe(false);
  });

  it("holds an invoice one cent over the limit, asking `large_invoice`", async () => {
    const decided = await decide("create_invoice", invoice([line(5, 100000), line(1, 1)]));
    expect(decided.blocked).toBe(true);
    expect(decided.asked).toEqual(["large_invoice"]);
    expect(decided.manifestSays).toBe(true);
  });

  it("the gate and the manifest's `when` agree on every boundary, in both directions", async () => {
    for (const lines of [
      [line(3, 12000)],
      [line(5, 100000)],
      [line(5, 100000), line(1, 1)],
      [line(10, 90000)],
    ]) {
      const decided = await decide("create_invoice", invoice(lines));
      expect(decided.blocked).toBe(decided.manifestSays);
    }
  });

  it("asks a person when the draft cannot be totalled, and so does the declaration", async () => {
    // A line with no price, a price that is not a number, and no lines at all: the code refuses each,
    // and the SDK's sum refuses them too rather than skipping an element and reporting a smaller total.
    for (const lines of [[{ quantity: 1 }], [{ quantity: 1, unitPriceCents: "500000" }], []]) {
      const decided = await decide("create_invoice", invoice(lines));
      expect(decided.blocked).toBe(true);
      expect(decided.manifestSays).toBe(true);
    }
  });

  it("sends an invoice to the address on file without asking: the over-block is gone", async () => {
    // `new_recipient` is a code condition (it reads the customer's address on file). With the board
    // gate retired nothing in an office asks about every send any more; a send that names
    // no new address runs, in the runtime and in office-mode evals alike.
    const decided = await decide("send_invoice", { invoice: "1042" });
    expect(decided.blocked).toBe(false);
    expect(decided.asked).toEqual([]);
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
