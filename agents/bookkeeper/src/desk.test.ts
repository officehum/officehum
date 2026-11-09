/**
 * The demonstration accounts desk on its own: bill status and due dates from the desk's clock, totals
 * from the supply catalogue, the refusals that stand between a message and a payment, and the
 * reconciliation it works out. No network, no model.
 */

import { describe, expect, it } from "vitest";
import { loadCompanyFacts } from "./company.js";
import {
  AccountingDeskError,
  billApprovalFacts,
  DEMO_NOW,
  demoBills,
  demoBooks,
  demoStatements,
  type FakeAccountingDesk,
  fakeAccountingDesk,
} from "./desk.js";

const company = loadCompanyFacts();
const desk = (): FakeAccountingDesk => fakeAccountingDesk({ now: () => new Date(DEMO_NOW) });

/** A payment of one bill, carrying the facts a person approved as the desk held them then. */
async function approvedPayment(accounts: FakeAccountingDesk, billId = "BILL-2001") {
  const [bill] = await accounts.listVendorBills({ billId });
  if (bill === undefined) throw new Error(`no ${billId} on the desk`);
  return { billId, approved: billApprovalFacts(bill) };
}

const NEW_BILL = {
  supplier: "sup-columbia-floor",
  supplierInvoice: "CF-7790",
  lines: [{ itemId: "floor-finish", quantity: 2 }],
  recordedBy: "Rosa",
  source: "email from orders@columbiafloor.example, 9 November",
};

async function refusal(promise: Promise<unknown>): Promise<AccountingDeskError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AccountingDeskError) return error;
    throw error;
  }
  throw new Error("expected the desk to refuse");
}

describe("demonstration data", () => {
  it("names only suppliers and catalogue items the company has, each from its own supplier", () => {
    const items = new Map(company.supplyCatalog.map((item) => [item.id, item.supplierId]));
    for (const bill of demoBills()) {
      expect(company.suppliers.some((supplier) => supplier.id === bill.supplierId)).toBe(true);
      for (const line of bill.lines)
        expect(items.get(line.itemId), line.itemId).toBe(bill.supplierId);
    }
  });

  it("agrees with itself: the paid bill's payment is on the statement and in the books", () => {
    const paid = demoBills().find((bill) => bill.paymentId !== undefined);
    expect(paid?.paymentId).toBe("PAY-501");
    const statementLine = demoStatements()[0]?.lines.find((line) => line.reference === "PAY-501");
    const bookLine = demoBooks().find((line) => line.reference === "PAY-501");
    // 16 cases of toilet tissue at the catalogue's unit cost.
    const tissue = company.supplyCatalog.find((item) => item.id === "toilet-tissue");
    expect(statementLine?.amountCents).toBe(-16 * (tissue?.unitCostCents ?? 0));
    expect(bookLine?.amountCents).toBe(statementLine?.amountCents);
  });
});

describe("listVendorBills", () => {
  it("works out each bill's status and days from the desk's clock, never the caller's", async () => {
    const bills = await desk().listVendorBills();
    const byId = new Map(bills.map((bill) => [bill.id, bill]));
    expect(byId.get("BILL-2001")).toMatchObject({
      status: "overdue",
      dueOn: "2026-11-04",
      daysUntilDue: -5,
      totalCents: 64800,
    });
    expect(byId.get("BILL-2002")).toMatchObject({
      status: "due",
      daysUntilDue: 6,
      totalCents: 62800,
    });
    expect(byId.get("BILL-2003")).toMatchObject({ status: "open", totalCents: 45000 });
    expect(byId.get("BILL-1998")).toMatchObject({ status: "paid", paymentId: "PAY-501" });
  });

  it("filters unpaid, due and overdue bills", async () => {
    const ids = async (status: "unpaid" | "due" | "overdue" | "paid") =>
      (await desk().listVendorBills({ status })).map((bill) => bill.id);
    expect(await ids("unpaid")).toEqual(["BILL-2001", "BILL-2002", "BILL-2003"]);
    expect(await ids("due")).toEqual(["BILL-2002"]);
    expect(await ids("overdue")).toEqual(["BILL-2001"]);
    expect(await ids("paid")).toEqual(["BILL-1998"]);
  });
});

describe("recordVendorBill", () => {
  it("prices every line from the catalogue and works out the total and due date", async () => {
    const bill = await desk().recordVendorBill(NEW_BILL, { requestId: "r1" });
    expect(bill).toMatchObject({
      id: "BILL-2004",
      supplierName: "Columbia Floor Care Supply",
      totalCents: 2 * 11500,
      recordedOn: "2026-11-09",
      dueOn: "2026-12-09",
      status: "open",
      recordedBy: "Rosa",
    });
  });

  it("refuses a supplier not on file and records nothing", async () => {
    const accounts = desk();
    const error = await refusal(
      accounts.recordVendorBill(
        { ...NEW_BILL, supplier: "Evergreen Chemical Co." },
        { requestId: "r2" },
      ),
    );
    expect(error.code).toBe("unknown_supplier");
    expect(await accounts.listVendorBills()).toHaveLength(4);
  });

  it("refuses a supplier that is on file but not approved", async () => {
    const error = await refusal(
      desk().recordVendorBill(
        {
          ...NEW_BILL,
          supplier: "sup-quickship-safety",
          lines: [{ itemId: "nitrile-gloves", quantity: 1 }],
        },
        { requestId: "r3" },
      ),
    );
    expect(error.code).toBe("unapproved_supplier");
  });

  it("refuses an item the supplier does not supply, so no price comes from anywhere else", async () => {
    const error = await refusal(
      desk().recordVendorBill(
        { ...NEW_BILL, lines: [{ itemId: "toilet-tissue", quantity: 3 }] },
        { requestId: "r4" },
      ),
    );
    expect(error.code).toBe("not_supplied");
  });

  it("refuses the same supplier invoice twice, naming the bill already on the desk", async () => {
    const error = await refusal(
      desk().recordVendorBill(
        {
          ...NEW_BILL,
          supplier: "Rainier Cleaning Tools",
          supplierInvoice: "rt-5520 ",
          lines: [{ itemId: "mop-head", quantity: 1 }],
        },
        { requestId: "r5" },
      ),
    );
    expect(error.code).toBe("duplicate_bill");
    expect(error.billId).toBe("BILL-2001");
  });

  it("refuses a bill with no named person or source", async () => {
    expect(
      (
        await refusal(
          desk().recordVendorBill({ ...NEW_BILL, recordedBy: " " }, { requestId: "r6" }),
        )
      ).code,
    ).toBe("invalid");
    expect(
      (await refusal(desk().recordVendorBill({ ...NEW_BILL, source: "" }, { requestId: "r7" })))
        .code,
    ).toBe("invalid");
  });

  it("records once for a replayed request id", async () => {
    const accounts = desk();
    const first = await accounts.recordVendorBill(NEW_BILL, { requestId: "same" });
    const again = await accounts.recordVendorBill(NEW_BILL, { requestId: "same" });
    expect(again).toEqual(first);
    expect(await accounts.listVendorBills()).toHaveLength(5);
  });
});

describe("payVendorBill", () => {
  it("pays the bill's own total, marks it paid and puts the payment in the books", async () => {
    const accounts = desk();
    const payment = await accounts.payVendorBill(await approvedPayment(accounts), {
      requestId: "p1",
    });
    expect(payment).toMatchObject({
      billId: "BILL-2001",
      amountCents: 64800,
      paidOn: "2026-11-09",
      backend: "demo",
    });
    const [bill] = await accounts.listVendorBills({ billId: "BILL-2001" });
    expect(bill).toMatchObject({ status: "paid", paymentId: payment.id });
  });

  it("approves the bill's recorded facts, not where it stands on the desk's clock", async () => {
    const [bill] = await desk().listVendorBills({ billId: "BILL-2001" });
    if (bill === undefined) throw new Error("no BILL-2001");
    const facts = billApprovalFacts(bill);
    expect(facts).toMatchObject({
      id: "BILL-2001",
      supplierId: "sup-rainier-tools",
      supplierName: "Rainier Cleaning Tools",
      supplierInvoice: "RT-5520",
      totalCents: 64800,
      recordedBy: "Eileen Hart",
      source: "PDF invoice RT-5520 emailed by sales@rainiertools.example on 2026-10-05",
      revision: 1,
    });
    // A day passing between the ask and the yes changes the status, not the bill.
    for (const moving of ["status", "daysUntilDue", "paidOn", "paymentId"]) {
      expect(facts, moving).not.toHaveProperty(moving);
    }
  });

  it("refuses facts that are not the bill as it stands, as changed, paying nothing", async () => {
    for (const changed of [
      { totalCents: 6480 },
      { supplierId: "sup-columbia-floor" },
      { supplierInvoice: "RT-9999" },
      { recordedBy: "Someone Else" },
      { source: "email from accounts@rainiertools-payments.example" },
      { lines: [] },
    ]) {
      const accounts = desk();
      const payment = await approvedPayment(accounts);
      const error = await refusal(
        accounts.payVendorBill(
          { ...payment, approved: { ...payment.approved, ...changed } },
          { requestId: "p2" },
        ),
      );
      expect(error.code, JSON.stringify(changed)).toBe("bill_changed");
      expect(error.billId).toBe("BILL-2001");
      expect((await accounts.listVendorBills({ billId: "BILL-2001" }))[0]?.status).toBe("overdue");
    }
  });

  it("refuses a bill corrected after the facts were read, as changed", async () => {
    const accounts = desk();
    const payment = await approvedPayment(accounts);
    await accounts.correctVendorBill("BILL-2001", [
      { itemId: "microfiber-cloth", quantity: 20 },
      { itemId: "mop-head", quantity: 14 },
    ]);
    const error = await refusal(accounts.payVendorBill(payment, { requestId: "p4" }));
    expect(error.code).toBe("bill_changed");
    expect(error.message).toContain("Nothing was paid.");
    const [bill] = await accounts.listVendorBills({ billId: "BILL-2001" });
    expect(bill).toMatchObject({ status: "overdue", revision: 2, totalCents: 64800 + 2 * 2400 });
  });

  it("refuses a bill already paid, and pays once for a replayed request id", async () => {
    const accounts = desk();
    const payment = await approvedPayment(accounts);
    const first = await accounts.payVendorBill(payment, { requestId: "p5" });
    expect(await accounts.payVendorBill(payment, { requestId: "p5" })).toEqual(first);
    const error = await refusal(accounts.payVendorBill(payment, { requestId: "p6" }));
    expect(error.code).toBe("already_paid");
  });

  it("refuses an unknown bill", async () => {
    const accounts = desk();
    const payment = await approvedPayment(accounts);
    expect(
      (await refusal(accounts.payVendorBill({ ...payment, billId: "BILL-9" }, { requestId: "p7" })))
        .code,
    ).toBe("not_found");
  });
});

describe("reconcile", () => {
  it("matches the statement against the books and finds the lease debit and the bank fee", async () => {
    const summary = await desk().reconcile({ majorOverCents: 50000 });
    expect(summary).toMatchObject({
      period: "2026-10",
      openingCents: 4_825_000,
      statementClosingCents: 5_155_800,
      booksClosingCents: 5_281_600,
      differenceCents: -125_800,
      matched: 3,
    });
    expect(summary.unmatched.map((item) => [item.amountCents, item.side, item.major])).toEqual([
      [-124_000, "statement_only", true],
      [-1_800, "statement_only", false],
    ]);
  });

  it("marks an item major only above the limit it is given, and every item major with none", async () => {
    const high = await desk().reconcile({ majorOverCents: 200_000 });
    expect(high.unmatched.every((item) => !item.major)).toBe(true);
    const atLimit = await desk().reconcile({ majorOverCents: 124_000 });
    expect(atLimit.unmatched.map((item) => item.major)).toEqual([false, false]);
    const none = await desk().reconcile({ majorOverCents: null });
    expect(none.unmatched.every((item) => item.major)).toBe(true);
  });

  it("works out the year itself from a month number: the last ended month with that number", async () => {
    // Monday 9 November 2026: October is 2026-10; November has not ended, so it is 2025-11.
    expect((await desk().reconcile({ month: 10, majorOverCents: 0 })).period).toBe("2026-10");
    const november = await refusal(desk().reconcile({ month: 11, majorOverCents: 0 }));
    expect(november.code).toBe("no_statement");
    expect(november.message).toContain("2025-11");
  });

  it("refuses a month with no statement, and a number that is not a month", async () => {
    const september = await refusal(desk().reconcile({ month: 9, majorOverCents: 0 }));
    expect(september.code).toBe("no_statement");
    expect(september.message).toContain("2026-09");
    expect((await refusal(desk().reconcile({ month: 13, majorOverCents: 0 }))).code).toBe(
      "invalid",
    );
  });
});
