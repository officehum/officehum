/**
 * The behaviour every `QuickBooks` owes the Bookkeeper's tools, as one suite each implementation
 * runs: the fake (`fake.test.ts`), the REST client against the recorded upstream (`client.test.ts`),
 * and the connector gateway's client over the same recording. What is about one implementation alone
 * (the REST request shape, the fake's refusal of a reused request id) stays in that implementation's
 * own tests.
 *
 * Test-only: the package's build excludes it, and other packages' tests import it by path.
 */

import { expect, it } from "vitest";
import type { QuickBooks, QuickBooksSeed } from "../types.js";

/** A new client over `seed`, as each implementation stores it. */
export type OpenQuickBooks = (seed: QuickBooksSeed) => QuickBooks;

// Matched by name, not by class: another package's tests run a client built from this package's
// compiled copy, whose error classes are not the source module's.
const QuickBooksNotFoundError = { name: "QuickBooksNotFoundError" };
const QuickBooksValidationError = { name: "QuickBooksValidationError" };

const usd = (cents: number) => ({ cents, currency: "USD" });
const ACME = { id: "1", displayName: "Acme Corp", active: true };

export function quickbooksContract(open: OpenQuickBooks): void {
  it("creates an invoice and lists it back with integer-cent totals", async () => {
    const quickbooks = open({ customers: [ACME] });
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
      { description: "Consulting", quantity: 3, unitPrice: usd(12000), amount: usd(36000) },
    ]);
    const listed = await quickbooks.listInvoices();
    expect(listed).toEqual([created]);
    expect(await quickbooks.getInvoice(created.id)).toEqual(created);
  });

  it("returns the first invoice for a repeated request ID instead of creating a second", async () => {
    const quickbooks = open({ customers: [ACME] });
    const draft = {
      customerId: "1",
      issuedOn: "2026-01-05",
      dueOn: "2026-02-04",
      lines: [{ description: "Consulting", quantity: 1, unitPrice: usd(5000) }],
    };
    const first = await quickbooks.createInvoice(draft, { requestId: "same" });
    const retried = await quickbooks.createInvoice(draft, { requestId: "same" });
    expect(retried).toEqual(first);
    // The record set never grew: the retry replayed the first result.
    expect(await quickbooks.listInvoices()).toHaveLength(1);
    // A new request ID is a new write.
    await quickbooks.createInvoice(draft, { requestId: "other" });
    expect(await quickbooks.listInvoices()).toHaveLength(2);
  });

  it("derives each invoice's status from its balance and due date", async () => {
    const invoice = (id: string, dueOn: string, balance: number) => ({
      id,
      customerId: "1",
      issuedOn: "2000-01-01",
      dueOn,
      total: usd(10000),
      balance: usd(balance),
      lines: [],
    });
    const quickbooks = open({
      customers: [ACME],
      invoices: [
        invoice("10", "2000-01-31", 10000),
        invoice("11", "2999-01-31", 10000),
        invoice("12", "2000-01-31", 0),
      ],
    });
    expect((await quickbooks.listInvoices({ status: "overdue" })).map((i) => i.id)).toEqual(["10"]);
    expect((await quickbooks.listInvoices({ status: "open" })).map((i) => i.id)).toEqual(["11"]);
    expect((await quickbooks.listInvoices({ status: "paid" })).map((i) => i.id)).toEqual(["12"]);
  });

  it("filters invoices and payments by customer and by date", async () => {
    const quickbooks = open({
      customers: [ACME, { id: "2", displayName: "Bravo Ltd", active: true }],
      invoices: [
        {
          id: "20",
          customerId: "1",
          issuedOn: "2026-01-05",
          dueOn: "2026-02-04",
          total: usd(1000),
          balance: usd(1000),
          lines: [],
        },
        {
          id: "21",
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
          invoiceIds: ["20"],
        },
        {
          id: "p2",
          customerId: "2",
          receivedOn: "2026-03-20",
          total: usd(2000),
          invoiceIds: ["21"],
        },
      ],
    });
    expect((await quickbooks.listInvoices({ customerId: "1" })).map((i) => i.id)).toEqual(["20"]);
    expect((await quickbooks.listInvoices({ since: "2026-02-01" })).map((i) => i.id)).toEqual([
      "21",
    ]);
    expect(await quickbooks.listPayments({ customerId: "2" })).toEqual([
      { id: "p2", customerId: "2", receivedOn: "2026-03-20", total: usd(2000), invoiceIds: ["21"] },
    ]);
    expect((await quickbooks.listPayments({ since: "2026-02-01" })).map((p) => p.id)).toEqual([
      "p2",
    ]);
  });

  it("finds customers by name, reads one back, and refuses an unknown id", async () => {
    const quickbooks = open({
      customers: [
        { id: "1", displayName: "Bravo Ltd", active: true },
        { id: "2", displayName: "Acme Corp", active: true, email: "ap@acme.example" },
      ],
    });
    expect((await quickbooks.findCustomers("acme")).map((c) => c.id)).toEqual(["2"]);
    // In stored order, as QuickBooks returns them: neither sorts customers.
    expect((await quickbooks.findCustomers("")).map((c) => c.id)).toEqual(["1", "2"]);
    expect(await quickbooks.getCustomer("2")).toEqual({
      id: "2",
      displayName: "Acme Corp",
      active: true,
      email: "ap@acme.example",
    });
    await expect(quickbooks.getCustomer("404")).rejects.toMatchObject(QuickBooksNotFoundError);
    await expect(quickbooks.getInvoice("404")).rejects.toMatchObject(QuickBooksNotFoundError);
  });

  it("sends an invoice, replaying the first result for a repeated request ID", async () => {
    const quickbooks = open({
      customers: [ACME],
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
    await expect(quickbooks.sendInvoice("404", { requestId: "send-2" })).rejects.toMatchObject(
      QuickBooksNotFoundError,
    );
  });

  it("refuses a draft it cannot price, or for a customer that does not exist", async () => {
    const quickbooks = open({ customers: [ACME] });
    const line = { description: "X", quantity: 1, unitPrice: usd(100) };
    await expect(
      quickbooks.createInvoice({ customerId: "1", lines: [] }, { requestId: "empty" }),
    ).rejects.toThrow(/at least one line/i);
    await expect(
      quickbooks.createInvoice(
        { customerId: "1", lines: [{ ...line, quantity: 0 }] },
        { requestId: "zero-qty" },
      ),
    ).rejects.toThrow(/line 1 quantity/i);
    await expect(
      quickbooks.createInvoice(
        { customerId: "1", lines: [line, { ...line, unitPrice: { cents: 100, currency: "EUR" } }] },
        { requestId: "mixed-currency" },
      ),
    ).rejects.toThrow(/one currency/i);
    await expect(
      quickbooks.createInvoice(
        { customerId: "9", issuedOn: "2026-01-05", dueOn: "2026-02-04", lines: [line] },
        { requestId: "no-customer" },
      ),
    ).rejects.toMatchObject(QuickBooksValidationError);
    expect(await quickbooks.listInvoices()).toEqual([]);
  });
}
