import { describe, expect, it } from "vitest";
import { quickbooksContract } from "./fixtures/quickbooks-contract.js";
import { fakeQuickBooks, QuickBooksValidationError } from "./index.js";

const usd = (cents: number) => ({ cents, currency: "USD" });

describe("QuickBooks contract: the fake", () => {
  quickbooksContract((seed) => fakeQuickBooks(seed));
});

describe("QuickBooks fake", () => {
  it("refuses a request ID reused with different invoice arguments", async () => {
    const quickbooks = fakeQuickBooks({
      customers: [{ id: "1", displayName: "Acme Corp", active: true }],
    });
    await quickbooks.createInvoice(
      {
        customerId: "1",
        lines: [{ description: "Consulting", quantity: 1, unitPrice: usd(5000) }],
      },
      { requestId: "same" },
    );
    await expect(
      quickbooks.createInvoice(
        { customerId: "1", lines: [{ description: "Other", quantity: 1, unitPrice: usd(6000) }] },
        { requestId: "same" },
      ),
    ).rejects.toBeInstanceOf(QuickBooksValidationError);
    expect(await quickbooks.listInvoices()).toHaveLength(1);
  });

  it("scopes a send's request ID to the send, and refuses one reused with other arguments", async () => {
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
    // A requestId is scoped to its endpoint, so the same value on a different send is a new write.
    expect(await quickbooks.sendInvoice("130", { requestId: "send-2" })).toEqual(first);
    await expect(
      quickbooks.sendInvoice("130", { requestId: "send-1", to: "someone@else.example" }),
    ).rejects.toBeInstanceOf(QuickBooksValidationError);
  });

  it("names what is missing when it refuses an unknown id", async () => {
    const quickbooks = fakeQuickBooks({
      customers: [{ id: "1", displayName: "Acme Corp", active: true }],
    });
    await expect(quickbooks.getCustomer("missing")).rejects.toThrow(/no customer/i);
    await expect(quickbooks.getInvoice("missing")).rejects.toThrow(/no invoice/i);
    await expect(
      quickbooks.createInvoice(
        { customerId: "9", lines: [{ description: "X", quantity: 1, unitPrice: usd(100) }] },
        { requestId: "no-customer" },
      ),
    ).rejects.toThrow(/no customer/i);
  });
});
