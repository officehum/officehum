/**
 * The demonstration accounts desk on its own: bill status and due dates from the desk's clock, totals
 * from the supply catalogue, the refusals that stand between a message and a payment, and the
 * reconciliation it works out. No network, no model.
 */

import { describe, expect, it } from "vitest";
import { loadCompanyFacts } from "./company.js";
import {
  AccountingDeskError,
  DEMO_NOW,
  demoBills,
  demoBooks,
  demoStatements,
  type FakeAccountingDesk,
  fakeAccountingDesk,
  type PaymentInput,
} from "./desk.js";

const company = loadCompanyFacts();
const desk = (): FakeAccountingDesk => fakeAccountingDesk({ now: () => new Date(DEMO_NOW) });

/** Rainier's overdue bill, named exactly as the desk holds it. */
const RAINIER: PaymentInput = {
  billId: "BILL-2001",
  supplierId: "sup-rainier-tools",
  supplierInvoice: "RT-5520",
  recordedBy: "Eileen Hart",
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
    const payment = await accounts.payVendorBill(RAINIER, { requestId: "p1" });
    expect(payment).toMatchObject({
      billId: "BILL-2001",
      amountCents: 64800,
      paidOn: "2026-11-09",
      demo: true,
    });
    const [bill] = await accounts.listVendorBills({ billId: "BILL-2001" });
    expect(bill).toMatchObject({ status: "paid", paymentId: payment.id });
  });

  it("refuses a total that is not the bill's, paying nothing", async () => {
    const accounts = desk();
    const error = await refusal(
      accounts.payVendorBill({ ...RAINIER, totalCents: 6480 }, { requestId: "p2" }),
    );
    expect(error.code).toBe("bill_mismatch");
    const [bill] = await accounts.listVendorBills({ billId: "BILL-2001" });
    expect(bill?.status).toBe("overdue");
  });

  it("refuses another supplier, invoice, recorder or line set than the bill's", async () => {
    for (const changed of [
      { supplierId: "sup-columbia-floor" },
      { supplierInvoice: "RT-9999" },
      { recordedBy: "Someone Else" },
      { lines: [{ itemId: "microfiber-cloth", quantity: 20 }] },
    ]) {
      const error = await refusal(
        desk().payVendorBill({ ...RAINIER, ...changed }, { requestId: "p3" }),
      );
      expect(error.code, JSON.stringify(changed)).toBe("bill_mismatch");
    }
  });

  it("refuses a bill corrected after the facts were read, as changed", async () => {
    const accounts = desk();
    await accounts.correctVendorBill("BILL-2001", [
      { itemId: "microfiber-cloth", quantity: 20 },
      { itemId: "mop-head", quantity: 14 },
    ]);
    const error = await refusal(accounts.payVendorBill(RAINIER, { requestId: "p4" }));
    expect(error.code).toBe("bill_changed");
    const [bill] = await accounts.listVendorBills({ billId: "BILL-2001" });
    expect(bill).toMatchObject({ status: "overdue", revision: 2, totalCents: 64800 + 2 * 2400 });
  });

  it("refuses a bill already paid, and pays once for a replayed request id", async () => {
    const accounts = desk();
    const first = await accounts.payVendorBill(RAINIER, { requestId: "p5" });
    expect(await accounts.payVendorBill(RAINIER, { requestId: "p5" })).toEqual(first);
    const error = await refusal(accounts.payVendorBill(RAINIER, { requestId: "p6" }));
    expect(error.code).toBe("already_paid");
  });

  it("refuses an unknown bill", async () => {
    expect(
      (await refusal(desk().payVendorBill({ ...RAINIER, billId: "BILL-9" }, { requestId: "p7" })))
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

  it("refuses a period with no statement, and a period that is not a month", async () => {
    expect((await refusal(desk().reconcile({ period: "2026-09", majorOverCents: 0 }))).code).toBe(
      "no_statement",
    );
    expect((await refusal(desk().reconcile({ period: "October", majorOverCents: 0 }))).code).toBe(
      "invalid",
    );
  });
});
