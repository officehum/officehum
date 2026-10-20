import { describe, expect, it } from "vitest";
import { fakeQuickBooks, QuickBooksValidationError } from "./index.js";

const usd = (cents: number) => ({ cents, currency: "USD" });

describe("QuickBooks fake", () => {
  it("creates an invoice and lists it back with integer-cent totals", async () => {
    const quickbooks = fakeQuickBooks({
      customers: [{ id: "1", displayName: "Acme Corp", active: true }],
    });
    const created = await quickbooks.createInvoice(
      {
        customerId: "1",
        issuedOn: "2026-01-05",
        dueOn: "2999-02-04",
        lines: [{ description: "Consulting", quantity: 3, unitPrice: usd(12000) }],
      },
      { requestId: "req-1" },
    );
    expect(created).toMatchObject({
      customerId: "1",
      issuedOn: "2026-01-05",
      dueOn: "2999-02-04",
      status: "open",
      total: usd(36000),
      balance: usd(36000),
    });
    expect(created.lines).toEqual([
      {
        description: "Consulting",
        quantity: 3,
        unitPrice: usd(12000),
        amount: usd(36000),
      },
    ]);

    const listed = await quickbooks.listInvoices();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(created);
  });

  it("keeps the overdue filter's two sides honest: past-due unpaid in, open and paid out", async () => {
    const quickbooks = fakeQuickBooks({
      customers: [{ id: "1", displayName: "Acme Corp", active: true }],
      invoices: [
        {
          id: "overdue",
          customerId: "1",
          issuedOn: "2000-01-01",
          dueOn: "2000-01-31",
          total: usd(10000),
          balance: usd(10000),
          lines: [],
        },
        {
          id: "future",
          customerId: "1",
          issuedOn: "2000-01-01",
          dueOn: "2999-01-31",
          total: usd(20000),
          balance: usd(20000),
          lines: [],
        },
        {
          id: "settled",
          customerId: "1",
          issuedOn: "2000-01-01",
          dueOn: "2000-01-31",
          total: usd(30000),
          balance: usd(0),
          lines: [],
        },
      ],
    });

    expect((await quickbooks.listInvoices({ status: "overdue" })).map((i) => i.id)).toEqual([
      "overdue",
    ]);
    expect((await quickbooks.listInvoices({ status: "open" })).map((i) => i.id)).toEqual([
      "future",
    ]);
    expect((await quickbooks.listInvoices({ status: "paid" })).map((i) => i.id)).toEqual([
      "settled",
    ]);
    // The same three invoices, each derived from its own balance and due date rather than stored.
    const all = await quickbooks.listInvoices();
    expect(Object.fromEntries(all.map((i) => [i.id, i.status]))).toEqual({
      overdue: "overdue",
      future: "open",
      settled: "paid",
    });
  });

  it("returns the first invoice for a repeated request ID instead of creating a second", async () => {
    const quickbooks = fakeQuickBooks({
      customers: [{ id: "1", displayName: "Acme Corp", active: true }],
    });
    const draft = {
      customerId: "1",
      lines: [{ description: "Consulting", quantity: 1, unitPrice: usd(5000) }],
    };
    const first = await quickbooks.createInvoice(draft, { requestId: "same" });
    expect(await quickbooks.listInvoices()).toHaveLength(1);

    const retried = await quickbooks.createInvoice(draft, { requestId: "same" });
    expect(retried).toEqual(first);
    expect(retried.id).toBe(first.id);
    // The record set never grew: the retry replayed the first result.
    expect(await quickbooks.listInvoices()).toHaveLength(1);

    await expect(
      quickbooks.createInvoice(
        { customerId: "1", lines: [{ description: "Other", quantity: 1, unitPrice: usd(6000) }] },
        { requestId: "same" },
      ),
    ).rejects.toBeInstanceOf(QuickBooksValidationError);
    expect(await quickbooks.listInvoices()).toHaveLength(1);
  });

  it("filters invoices and payments by customer and by issue date", async () => {
    const quickbooks = fakeQuickBooks({
      customers: [
        { id: "1", displayName: "Acme Corp", active: true },
        { id: "2", displayName: "Bravo Ltd", active: true },
      ],
      invoices: [
        {
          id: "a",
          customerId: "1",
          issuedOn: "2026-01-05",
          dueOn: "2026-02-04",
          total: usd(1000),
          balance: usd(1000),
          lines: [],
        },
        {
          id: "b",
          customerId: "2",
          issuedOn: "2026-03-05",
          dueOn: "2026-04-04",
          total: usd(2000),
          balance: usd(2000),
          lines: [],
        },
      ],
      payments: [
        {
          id: "p1",
          customerId: "1",
          receivedOn: "2026-01-20",
          total: usd(1000),
          invoiceIds: ["a"],
        },
        {
          id: "p2",
          customerId: "2",
          receivedOn: "2026-03-20",
          total: usd(2000),
          invoiceIds: ["b"],
        },
      ],
    });

    expect((await quickbooks.listInvoices({ customerId: "1" })).map((i) => i.id)).toEqual(["a"]);
    expect((await quickbooks.listInvoices({ since: "2026-02-01" })).map((i) => i.id)).toEqual([
      "b",
    ]);
    expect((await quickbooks.listPayments({ customerId: "2" })).map((p) => p.id)).toEqual(["p2"]);
    expect((await quickbooks.listPayments({ since: "2026-02-01" })).map((p) => p.id)).toEqual([
      "p2",
    ]);
  });

  it("finds customers by name and reads one back, refusing an unknown id", async () => {
    const quickbooks = fakeQuickBooks({
      customers: [
        { id: "1", displayName: "Acme Corp", active: true, email: "ap@acme.example" },
        { id: "2", displayName: "Bravo Ltd", active: true },
      ],
    });

    expect((await quickbooks.findCustomers("acme")).map((c) => c.id)).toEqual(["1"]);
    expect((await quickbooks.findCustomers("")).map((c) => c.id)).toEqual(["1", "2"]);
    expect(await quickbooks.getCustomer("1")).toEqual({
      id: "1",
      displayName: "Acme Corp",
      active: true,
      email: "ap@acme.example",
    });
    await expect(quickbooks.getCustomer("missing")).rejects.toThrow(/no customer/i);
    await expect(quickbooks.getInvoice("missing")).rejects.toThrow(/no invoice/i);
  });

  it("sends an invoice idempotently, replaying the first result for a repeated request ID", async () => {
    const quickbooks = fakeQuickBooks({
      customers: [{ id: "1", displayName: "Acme Corp", active: true }],
      invoices: [
        {
          id: "130",
          customerId: "1",
          issuedOn: "2026-01-05",
          dueOn: "2026-02-04",
          total: usd(5000),
          balance: usd(5000),
          lines: [],
        },
      ],
    });

    const first = await quickbooks.sendInvoice("130", {
      requestId: "send-1",
      to: "ap@acme.example",
    });
    expect(first.id).toBe("130");
    expect(
      await quickbooks.sendInvoice("130", { requestId: "send-1", to: "ap@acme.example" }),
    ).toEqual(first);
    // A requestId is scoped to its endpoint, so the same value on a different send is a new write.
    expect(await quickbooks.sendInvoice("130", { requestId: "send-2" })).toEqual(first);
    await expect(
      quickbooks.sendInvoice("130", { requestId: "send-1", to: "someone@else.example" }),
    ).rejects.toBeInstanceOf(QuickBooksValidationError);
  });

  it("refuses a draft it cannot price, naming the offending line", async () => {
    const quickbooks = fakeQuickBooks({
      customers: [{ id: "1", displayName: "Acme Corp", active: true }],
    });

    await expect(
      quickbooks.createInvoice({ customerId: "1", lines: [] }, { requestId: "empty" }),
    ).rejects.toThrow(/at least one line/i);
    await expect(
      quickbooks.createInvoice(
        { customerId: "9", lines: [{ description: "X", quantity: 1, unitPrice: usd(100) }] },
        { requestId: "no-customer" },
      ),
    ).rejects.toThrow(/no customer/i);
    await expect(
      quickbooks.createInvoice(
        { customerId: "1", lines: [{ description: "X", quantity: 0, unitPrice: usd(100) }] },
        { requestId: "zero-qty" },
      ),
    ).rejects.toThrow(/line 1 quantity/i);
    await expect(
      quickbooks.createInvoice(
        {
          customerId: "1",
          lines: [
            { description: "A", quantity: 1, unitPrice: usd(100) },
            { description: "B", quantity: 1, unitPrice: { cents: 100, currency: "EUR" } },
          ],
        },
        { requestId: "mixed-currency" },
      ),
    ).rejects.toThrow(/one currency/i);
  });
});
