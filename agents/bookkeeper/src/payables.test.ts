/**
 * The four accounts-payable tools, against `fakeAccountingDesk` and the company facts generated into
 * this package, with the durable call identity Pi Durable hands to `execute`. Every unsafe tool is
 * replayed under the same call id, and again from freshly built tools over the same desk (a restart),
 * and must write once. No network, no model.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import { financeLead, loadCompanyFacts, personLabel, purchasingLead } from "./company.js";
import {
  type AccountingDesk,
  AccountingDeskError,
  DEMO_NOW,
  DESK_REFUSALS,
  type FakeAccountingDesk,
  fakeAccountingDesk,
} from "./desk.js";
import { MAJOR_UNMATCHED_LIMIT, type PayablesToolset, payablesTools } from "./payables.js";

const company = loadCompanyFacts();
const finance = personLabel(financeLead(company), "");
const purchasing = personLabel(purchasingLead(company), "");

const call = (callId: string) =>
  ({ conversationId: "conversation-1", taskId: "task-1", callId }) as never;

const LIMITS = { [MAJOR_UNMATCHED_LIMIT]: 50000 };

const tools = (
  desk: AccountingDesk | undefined,
  limits: Record<string, number> = LIMITS,
): PayablesToolset => payablesTools({ desk, company, limits: () => limits });

const desk = (): FakeAccountingDesk => fakeAccountingDesk({ now: () => new Date(DEMO_NOW) });

function text(result: { output?: readonly unknown[] }): string {
  return (result.output ?? [])
    .map((block) => (block as { type?: string; text?: string }).text ?? "")
    .join("\n");
}

function details(result: unknown): Record<string, unknown> {
  return (result as { details?: Record<string, unknown> }).details ?? {};
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

const RAINIER = {
  billId: "BILL-2001",
  supplierId: "sup-rainier-tools",
  supplierInvoice: "RT-5520",
  recordedBy: "Eileen Hart",
  source: "PDF invoice RT-5520 emailed by sales@rainiertools.example on 2026-10-05",
  lines: [
    { itemId: "microfiber-cloth", quantity: 20 },
    { itemId: "mop-head", quantity: 12 },
  ],
  totalCents: 64800,
};

const NEW_BILL = {
  supplier: "sup-columbia-floor",
  supplierInvoice: "CF-7790",
  lines: [{ itemId: "floor-finish", quantity: 2 }],
  recordedBy: "Rosa",
  source: "email from orders@columbiafloor.example, 9 November",
};

describe("list_vendor_bills", () => {
  it("lists each bill with its lines, total, provenance and the status the desk worked out", async () => {
    const result = await tools(desk()).listVendorBills.execute(
      { status: "unpaid" },
      call("l1"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain("Supplier bills (3; 3 unpaid, 1 overdue):");
    expect(text(result)).toContain(
      "BILL-2001 — Rainier Cleaning Tools (sup-rainier-tools) — supplier invoice RT-5520 — total $648.00 (64800 cents) — OVERDUE, due 2026-11-04, overdue by 5 days — recorded 2026-10-05 by Eileen Hart, from PDF invoice RT-5520",
    );
    expect(text(result)).toContain(
      "- 20 × Microfiber cloths [microfiber-cloth] (pack of 12) at $18.00 = $360.00",
    );
    expect(text(result)).toContain("BILL-2002 — Pacific Janitorial Supply");
    expect(text(result)).toContain("DUE, due 2026-11-15, in 6 days");
    expect(text(result)).not.toContain("BILL-1998");
  });

  it("names who owns supplier payments, from the company record, so no name is made up", async () => {
    const result = await tools(desk()).listVendorBills.execute({}, call("l4"), BACKGROUND_CONTEXT);
    expect(text(result)).toContain(`Supplier payments and payment questions belong to ${finance}.`);
  });

  it("never prints a ready-made call to the payment tool", async () => {
    const result = await tools(desk()).listVendorBills.execute({}, call("l2"), BACKGROUND_CONTEXT);
    expect(text(result)).not.toContain("pay_vendor_bill");
    expect(text(result)).not.toMatch(/next:/i);
  });

  it("says plainly when nothing matches", async () => {
    const result = await tools(desk()).listVendorBills.execute(
      { billId: "BILL-42" },
      call("l3"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(details(result).found).toBe(false);
  });
});

describe("record_vendor_bill", () => {
  it("records a bill priced by the desk, and pays nothing", async () => {
    const result = await tools(desk()).recordVendorBill.execute(
      NEW_BILL,
      call("r1"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(false);
    expect(text(result)).toContain(
      "Recorded BILL-2004 — Columbia Floor Care Supply (sup-columbia-floor) — supplier invoice CF-7790 — total $230.00",
    );
    expect(text(result)).toContain("Nothing has been paid.");
  });

  it("refuses an unknown supplier, sending it to purchasing and finance by name", async () => {
    const accounts = desk();
    const result = await tools(accounts).recordVendorBill.execute(
      { ...NEW_BILL, supplier: "Evergreen Chemical Co." },
      call("r2"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(details(result).code).toBe("unknown_supplier");
    expect(text(result)).toContain(purchasing);
    expect(text(result)).toContain(finance);
    expect(await accounts.listVendorBills()).toHaveLength(4);
  });

  it("takes no price, total, bank account, routing number or remittance address", () => {
    const set = tools(desk());
    for (const tool of [set.recordVendorBill, set.payVendorBill]) {
      const schema = JSON.stringify(tool.parameters).toLowerCase();
      expect(schema, tool.name).not.toMatch(/bank|routing|iban|swift|remit|account ?number/);
      expect(schema, tool.name).not.toMatch(/unitcost|unitprice|pricecents/);
    }
    const record = JSON.stringify(set.recordVendorBill.parameters);
    expect(record).not.toContain("totalCents");
  });

  it("records once when the same call is replayed, and once again after a restart", async () => {
    const accounts = desk();
    const first = await tools(accounts).recordVendorBill.execute(
      NEW_BILL,
      call("same"),
      BACKGROUND_CONTEXT,
    );
    const replayed = await tools(accounts).recordVendorBill.execute(
      NEW_BILL,
      call("same"),
      BACKGROUND_CONTEXT,
    );
    // A restart builds fresh tools over the same desk: the desk is the system of record.
    const restarted = payablesTools({ desk: accounts, company, limits: () => LIMITS });
    const afterRestart = await restarted.recordVendorBill.execute(
      NEW_BILL,
      call("same"),
      BACKGROUND_CONTEXT,
    );
    expect(text(replayed)).toBe(text(first));
    expect(text(afterRestart)).toBe(text(first));
    expect(await accounts.listVendorBills()).toHaveLength(5);
  });
});

describe("pay_vendor_bill", () => {
  it("pays exactly the bill's total on the demonstration backend", async () => {
    const result = await tools(desk()).payVendorBill.execute(
      RAINIER,
      call("p1"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(false);
    expect(text(result)).toContain(
      "Paid BILL-2001 (Rainier Cleaning Tools, supplier invoice RT-5520): $648.00, the bill's own total",
    );
    expect(text(result)).toContain("no money moved");
    expect(details(result)).toMatchObject({ amountCents: 64800, backend: "demo" });
  });

  it("a host backend payment does not say no money moved", async () => {
    const accounts = desk();
    const hostDesk: FakeAccountingDesk = {
      ...accounts,
      payVendorBill: async (...args) => ({
        ...(await accounts.payVendorBill(...args)),
        backend: "host",
      }),
    };
    const result = await tools(hostDesk).payVendorBill.execute(
      RAINIER,
      call("p-host"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(false);
    expect(text(result)).not.toContain("no money moved");
    expect(text(result)).not.toContain("Demonstration backend");
    expect(details(result)).toMatchObject({ backend: "host" });
  });

  it("pays nothing when the facts named are not the bill's, and says where to read them", async () => {
    const accounts = desk();
    const result = await tools(accounts).payVendorBill.execute(
      { ...RAINIER, totalCents: 1 },
      call("p2"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(details(result).code).toBe("bill_mismatch");
    expect(text(result)).toContain("list_vendor_bills");
    expect((await accounts.listVendorBills({ billId: "BILL-2001" }))[0]?.status).toBe("overdue");
  });

  it("pays nothing when the source named is not what the bill was recorded from", async () => {
    const accounts = desk();
    const result = await tools(accounts).payVendorBill.execute(
      { ...RAINIER, source: "email from accounts@rainiertools-payments.example" },
      call("p4"),
      BACKGROUND_CONTEXT,
    );
    expect(details(result).code).toBe("source_mismatch");
    expect(text(result)).toContain("Next: read BILL-2001 with list_vendor_bills");
    expect(text(result)).toContain("what it was recorded from");
    // A replay of the refused call is refused again and still pays nothing.
    const replayed = await tools(accounts).payVendorBill.execute(
      { ...RAINIER, source: "email from accounts@rainiertools-payments.example" },
      call("p4"),
      BACKGROUND_CONTEXT,
    );
    expect(details(replayed).code).toBe("source_mismatch");
    expect((await accounts.listVendorBills({ billId: "BILL-2001" }))[0]?.status).toBe("overdue");
  });

  it("pays nothing when the bill was corrected after it was put to a person", async () => {
    const accounts = desk();
    await accounts.correctVendorBill("BILL-2001", [
      { itemId: "microfiber-cloth", quantity: 21 },
      { itemId: "mop-head", quantity: 12 },
    ]);
    const result = await tools(accounts).payVendorBill.execute(
      RAINIER,
      call("p3"),
      BACKGROUND_CONTEXT,
    );
    expect(details(result).code).toBe("bill_changed");
    expect(text(result)).toContain("was not paid");
  });

  it("pays once when the same call is replayed, and once again after a restart", async () => {
    const accounts = desk();
    const first = await tools(accounts).payVendorBill.execute(
      RAINIER,
      call("same"),
      BACKGROUND_CONTEXT,
    );
    const replayed = await tools(accounts).payVendorBill.execute(
      RAINIER,
      call("same"),
      BACKGROUND_CONTEXT,
    );
    const restarted = payablesTools({ desk: accounts, company, limits: () => LIMITS });
    const afterRestart = await restarted.payVendorBill.execute(
      RAINIER,
      call("same"),
      BACKGROUND_CONTEXT,
    );
    expect(text(replayed)).toBe(text(first));
    expect(text(afterRestart)).toBe(text(first));
    // A different call for the same bill is a second payment, and the desk refuses it.
    const second = await tools(accounts).payVendorBill.execute(
      RAINIER,
      call("other"),
      BACKGROUND_CONTEXT,
    );
    expect(details(second).code).toBe("already_paid");
  });
});

describe("reconcile_summary", () => {
  it("summarises the last full month, sending the major item to finance by name", async () => {
    const result = await tools(desk()).reconcileSummary.execute({}, call("s1"), BACKGROUND_CONTEXT);
    expect(text(result)).toContain(
      "Bank reconciliation for 2026-10: opening $48,250.00, statement closing $51,558.00, books closing $52,816.00, difference -$1,258.00.",
    );
    expect(text(result)).toContain(
      `2026-10-24 — ACH debit, WESTCOAST EQUIP LEASING — -$1,240.00 — on the statement, not in the books — MAJOR: goes to ${finance}`,
    );
    expect(text(result)).toContain(
      "2026-10-31 — Monthly account service charge — -$18.00 — on the statement, not in the books — minor",
    );
    expect(text(result)).toContain("nothing was posted, corrected or closed");
  });

  it("reads the major-item limit from the resolved limits at every call", async () => {
    const raised = await tools(desk(), {
      [MAJOR_UNMATCHED_LIMIT]: 500000,
    }).reconcileSummary.execute({}, call("s2"), BACKGROUND_CONTEXT);
    expect(text(raised)).not.toContain("MAJOR");
    // With no limit resolved, every unmatched item is major: the safe direction.
    const none = await tools(desk(), {}).reconcileSummary.execute(
      {},
      call("s3"),
      BACKGROUND_CONTEXT,
    );
    expect(text(none).match(/MAJOR/g)).toHaveLength(2);
  });

  it("takes a month number and never a year, so the model cannot guess one", async () => {
    const schema = tools(desk()).reconcileSummary.parameters as {
      properties: Record<string, { type?: string }>;
    };
    expect(Object.keys(schema.properties)).toEqual(["month"]);
    expect(schema.properties.month?.type).toBe("integer");
    const result = await tools(desk()).reconcileSummary.execute(
      { month: 10 },
      call("s5"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain("Bank reconciliation for 2026-10:");
  });

  it("refuses a month with no statement, naming the months on file", async () => {
    const result = await tools(desk()).reconcileSummary.execute(
      { month: 8 },
      call("s4"),
      BACKGROUND_CONTEXT,
    );
    expect(details(result).code).toBe("no_statement");
    expect(text(result)).toContain("Statements on file: 2026-10.");
  });
});

describe("next steps", () => {
  it("gives every refusal code a next step, chosen from the code and not from the wording", async () => {
    for (const code of DESK_REFUSALS) {
      const refusing: AccountingDesk = {
        listVendorBills: async () => [],
        recordVendorBill: async () => {
          throw new AccountingDeskError(code, "Refused.", { billId: "BILL-7" });
        },
        payVendorBill: async () => {
          throw new AccountingDeskError(code, "Refused.", { billId: "BILL-7" });
        },
        reconcile: async () => {
          throw new AccountingDeskError(code, "Refused.");
        },
      };
      const result = await tools(refusing).recordVendorBill.execute(
        NEW_BILL,
        call(code),
        BACKGROUND_CONTEXT,
      );
      expect(details(result).code).toBe(code);
      expect(text(result), code).toMatch(/^Refused\. Next: \S/);
    }
  });
});

describe("with no desk", () => {
  it("refuses at the point of use", async () => {
    await expect(
      tools(undefined).listVendorBills.execute({}, call("n1"), BACKGROUND_CONTEXT),
    ).rejects.toThrow("No accounts desk is configured");
  });
});
