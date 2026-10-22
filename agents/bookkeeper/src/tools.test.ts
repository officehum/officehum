/**
 * One test per tool, against `fakeQuickBooks`, so every path runs with the same derived statuses,
 * input validation and `requestId` dedupe the REST client has — no network, no real model.
 *
 * The tools are exercised where the model calls them: through the registrations the factory builds,
 * with the durable call identity Pi Durable hands to `execute`.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fakeQuickBooks, type QuickBooks } from "@officehum/quickbooks";
import { describe, expect, it } from "vitest";
import {
  bookkeeperTools,
  largeInvoiceCondition,
  newRecipientCondition,
  writeRequestId,
} from "./tools.js";

/** The durable identity one tool call runs under; only the three ids matter to these tools. */
const call = (callId: string) =>
  ({ conversationId: "conversation-1", taskId: "task-1", callId }) as never;

/** Whole days from today in UTC, so a seeded invoice keeps its status however long the suite lives. */
const day = (offset: number): string =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const usd = (cents: number) => ({ cents, currency: "USD" });

const DEMO_GUEST = {
  id: "customer-1",
  displayName: "Demo Guest",
  email: "guest@example.com",
  active: true,
};

const SECOND_GUEST = { id: "customer-2", displayName: "Second Guest", active: true };

const line = (description: string, quantity: number, unitPriceCents: number) => ({
  description,
  quantity,
  unitPrice: usd(unitPriceCents),
  amount: usd(Math.round(quantity * unitPriceCents)),
});

/** Three invoices for Demo Guest: one overdue, one open, one paid. */
const seeded = (): QuickBooks =>
  fakeQuickBooks({
    customers: [DEMO_GUEST, SECOND_GUEST],
    invoices: [
      {
        id: "1042",
        customerId: "customer-1",
        number: "1042",
        issuedOn: day(-30),
        dueOn: day(-1),
        total: usd(12000),
        balance: usd(12000),
        lines: [line("On-site support", 3, 4000)],
      },
      {
        id: "1043",
        customerId: "customer-1",
        number: "1043",
        issuedOn: day(-1),
        dueOn: day(30),
        total: usd(4500),
        balance: usd(4500),
        lines: [line("Call-out", 1, 4500)],
      },
      {
        id: "1044",
        customerId: "customer-1",
        number: "1044",
        issuedOn: day(-60),
        dueOn: day(-40),
        total: usd(900),
        balance: usd(0),
        lines: [line("Parts", 1, 900)],
      },
    ],
  });

/** The one text channel a result carries, as the model reads it. */
function text(result: { output?: readonly unknown[] }): string {
  return (result.output ?? [])
    .map((block) => (block as { type?: string; text?: string }).text ?? "")
    .join("\n");
}

describe("find_customer", () => {
  it("finds a customer by part of its name, with the id and the email on file", async () => {
    const tools = bookkeeperTools(seeded());
    const result = await tools.findCustomer.execute(
      { name: "demo" },
      call("find-1"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toBe("Customers:\nDemo Guest — customer-1 — guest@example.com");
    expect(result.details).toEqual({ found: true, customers: [DEMO_GUEST] });
  });

  it("finds a customer by email, whatever its case", async () => {
    const tools = bookkeeperTools(seeded());
    const result = await tools.findCustomer.execute(
      { email: "GUEST@example.com" },
      call("find-2"),
      BACKGROUND_CONTEXT,
    );
    expect(result.details).toMatchObject({ found: true, customers: [{ id: "customer-1" }] });
  });

  it("refuses a search that matches nothing, and one with nothing to search by", async () => {
    const tools = bookkeeperTools(seeded());
    const missing = await tools.findCustomer.execute(
      { name: "Nobody" },
      call("find-3"),
      BACKGROUND_CONTEXT,
    );
    expect(missing.isError).toBe(true);
    expect(missing.details).toEqual({ found: false, customers: [] });

    const empty = await tools.findCustomer.execute({}, call("find-4"), BACKGROUND_CONTEXT);
    expect(empty.isError).toBe(true);
    expect(text(empty)).toContain("a name or an email");
  });

  it("refuses every tool when the host bound no client", async () => {
    const tools = bookkeeperTools(undefined);
    await expect(
      tools.findCustomer.execute({ name: "Demo Guest" }, call("find-5"), BACKGROUND_CONTEXT),
    ).rejects.toThrow("No QuickBooks client is configured");
  });
});

describe("list_invoices", () => {
  it("lists a customer's invoices with the figures QuickBooks reports", async () => {
    const tools = bookkeeperTools(seeded());
    const result = await tools.listInvoices.execute(
      { customer: "customer-1" },
      call("list-1"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toBe(
      [
        "Invoices for Demo Guest (customer-1):",
        `1044 — paid — total 9.00 USD — balance 0.00 USD — due ${day(-40)}`,
        `1042 — overdue — total 120.00 USD — balance 120.00 USD — due ${day(-1)}`,
        `1043 — open — total 45.00 USD — balance 45.00 USD — due ${day(30)}`,
      ].join("\n"),
    );
    expect(result.details).toMatchObject({ found: true, customer: DEMO_GUEST });
  });

  it("filters by status and accepts a customer by its exact name", async () => {
    const tools = bookkeeperTools(seeded());
    const overdue = await tools.listInvoices.execute(
      { customer: "Demo Guest", status: "overdue" },
      call("list-2"),
      BACKGROUND_CONTEXT,
    );
    expect(text(overdue)).toContain("1042");
    expect(text(overdue)).not.toContain("1043");
    expect(overdue.details).toMatchObject({ invoices: [{ id: "1042", status: "overdue" }] });
  });

  it("reports no invoices for a customer that has none, and refuses an unknown customer", async () => {
    const tools = bookkeeperTools(seeded());
    const none = await tools.listInvoices.execute(
      { customer: "customer-2" },
      call("list-3"),
      BACKGROUND_CONTEXT,
    );
    expect(text(none)).toBe("No invoices for Second Guest (customer-2)");
    expect(none.details).toEqual({
      found: false,
      customer: { ...SECOND_GUEST, email: null },
      invoices: [],
    });

    const unknown = await tools.listInvoices.execute(
      { customer: "nobody" },
      call("list-4"),
      BACKGROUND_CONTEXT,
    );
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toContain("find_customer");
  });
});

describe("get_invoice", () => {
  it("reads one invoice by id, with the lines, total, balance and due date", async () => {
    const tools = bookkeeperTools(seeded());
    const result = await tools.getInvoice.execute(
      { invoice: "1042" },
      call("get-1"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toBe(
      [
        "Invoice 1042 — overdue",
        "Lines:",
        "  On-site support — 3 × 40.00 USD — 120.00 USD",
        "Total: 120.00 USD",
        "Balance: 120.00 USD",
        `Due: ${day(-1)}`,
      ].join("\n"),
    );
    expect(result.details).toMatchObject({
      found: true,
      invoice: { id: "1042", totalCents: 12000, balanceCents: 12000, currency: "USD" },
    });
  });

  it("refuses an invoice that does not exist", async () => {
    const tools = bookkeeperTools(seeded());
    const result = await tools.getInvoice.execute(
      { invoice: "9999" },
      call("get-2"),
      BACKGROUND_CONTEXT,
    );
    expect(result.isError).toBe(true);
    expect(result.details).toEqual({ found: false, invoice: null });
    expect(text(result)).toContain("list_invoices");
  });
});

describe("create_invoice", () => {
  it("creates an invoice from the job's lines, in integer cents, and reports the client's figures", async () => {
    const books = seeded();
    const tools = bookkeeperTools(books);
    const result = await tools.createInvoice.execute(
      {
        customer: "customer-1",
        lines: [
          { description: "On-site support", quantity: 3, unitPriceCents: 12000 },
          { description: "Call-out charge", quantity: 1, unitPriceCents: 4500 },
        ],
        dueInDays: 30,
        jobReference: "JOB-1042",
      },
      call("create-1"),
      BACKGROUND_CONTEXT,
    );
    // 3 × 120.00 + 1 × 45.00 = 405.00, worked out by the client, never by the role.
    expect(result.details).toMatchObject({
      created: true,
      invoice: {
        totalCents: 40500,
        balanceCents: 40500,
        number: "JOB-1042",
        dueOn: day(30),
      },
    });
    expect(text(result)).toContain(
      "Created invoice JOB-1042 (id 1045) for customer customer-1: 2 lines, total 405.00 USD, due",
    );
    const invoices = await books.listInvoices({ customerId: "customer-1" });
    expect(invoices).toHaveLength(4);
  });

  it("keeps a retried call to one invoice, and a different call to its own", async () => {
    const books = seeded();
    const tools = bookkeeperTools(books);
    const args = {
      customer: "customer-1",
      lines: [{ description: "On-site support", quantity: 1, unitPriceCents: 40000 }],
    };
    const first = await tools.createInvoice.execute(args, call("retry"), BACKGROUND_CONTEXT);
    const second = await tools.createInvoice.execute(args, call("retry"), BACKGROUND_CONTEXT);
    expect(second.details).toMatchObject({
      invoice: { id: (first.details as { invoice: { id: string } }).invoice.id },
    });
    expect((second.details as { requestId: string }).requestId).toBe(
      (first.details as { requestId: string }).requestId,
    );
    expect(await books.listInvoices({ customerId: "customer-1" })).toHaveLength(4);

    // A separate call is a separate invoice: the requestId is per call, not per draft.
    const third = await tools.createInvoice.execute(args, call("other"), BACKGROUND_CONTEXT);
    expect((third.details as { invoice: { id: string } }).invoice.id).not.toBe(
      (first.details as { invoice: { id: string } }).invoice.id,
    );
    expect(await books.listInvoices({ customerId: "customer-1" })).toHaveLength(5);
  });
});

describe("send_invoice", () => {
  it("sends to the address on file when no other address is given", async () => {
    const tools = bookkeeperTools(seeded());
    const result = await tools.sendInvoice.execute(
      { invoice: "1042" },
      call("send-1"),
      BACKGROUND_CONTEXT,
    );
    expect(result.details).toMatchObject({ sent: true, to: "guest@example.com" });
    expect(text(result)).toContain("Sent invoice 1042 to guest@example.com");
  });

  it("sends to another address when one is given, and reports it", async () => {
    const tools = bookkeeperTools(seeded());
    const result = await tools.sendInvoice.execute(
      { invoice: "1042", to: "accounts@example.com" },
      call("send-2"),
      BACKGROUND_CONTEXT,
    );
    expect(result.details).toMatchObject({ sent: true, to: "accounts@example.com" });
  });

  it("refuses an unknown invoice, and a customer with no address to send to", async () => {
    const tools = bookkeeperTools(seeded());
    const unknown = await tools.sendInvoice.execute(
      { invoice: "9999" },
      call("send-3"),
      BACKGROUND_CONTEXT,
    );
    expect(unknown.isError).toBe(true);
    expect(unknown.details).toMatchObject({ sent: false, invoice: null });

    const books = fakeQuickBooks({
      customers: [SECOND_GUEST],
      invoices: [
        {
          id: "5001",
          customerId: "customer-2",
          issuedOn: day(-2),
          dueOn: day(28),
          total: usd(1000),
          balance: usd(1000),
          lines: [line("Parts", 1, 1000)],
        },
      ],
    });
    const addressless = await bookkeeperTools(books).sendInvoice.execute(
      { invoice: "5001" },
      call("send-4"),
      BACKGROUND_CONTEXT,
    );
    expect(addressless.isError).toBe(true);
    expect(text(addressless)).toContain("no email on file");
  });
});

describe("send_reminder", () => {
  it("sends one reminder in the tone it was asked for, and names the balance", async () => {
    const tools = bookkeeperTools(seeded());
    const result = await tools.sendReminder.execute(
      { invoice: "1042", tone: "firm" },
      call("remind-1"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain("Sent a firm reminder for invoice 1042 to guest@example.com");
    expect(text(result)).toContain("balance 120.00 USD");
    expect(result.details).toMatchObject({ sent: true, tone: "firm", to: "guest@example.com" });
  });

  it("leaves a paid invoice alone and refuses an unknown one", async () => {
    const tools = bookkeeperTools(seeded());
    const paid = await tools.sendReminder.execute(
      { invoice: "1044", tone: "final" },
      call("remind-2"),
      BACKGROUND_CONTEXT,
    );
    expect(paid.isError).toBe(true);
    expect(paid.details).toMatchObject({ sent: false, tone: "final" });
    expect(text(paid)).toContain("paid");

    const unknown = await tools.sendReminder.execute(
      { invoice: "9999", tone: "friendly" },
      call("remind-3"),
      BACKGROUND_CONTEXT,
    );
    expect(unknown.isError).toBe(true);
  });
});

describe("the write requestId", () => {
  it("is one stable key per call, within QuickBooks' 50-character cap", () => {
    const first = writeRequestId({ conversationId: "c", taskId: "t", callId: "call-1" });
    expect(first).toBe(writeRequestId({ conversationId: "c", taskId: "t", callId: "call-1" }));
    expect(first).not.toBe(writeRequestId({ conversationId: "c", taskId: "t", callId: "call-2" }));
    expect(first).toHaveLength(43);
    expect(first.length).toBeLessThanOrEqual(50);
    // A call identity far longer than the cap still yields one key, not a colliding prefix.
    const long = `${"conversation-".repeat(6)}:${"task-".repeat(8)}:a`;
    expect(writeRequestId({ conversationId: long, taskId: long, callId: long })).toHaveLength(43);
  });
});

describe("the large_invoice condition", () => {
  const environment = (limits: Readonly<Record<string, number>>) => ({ read: {}, limits }) as never;

  const draft = (lines: unknown) => ({ customer: "customer-1", lines });

  it("gates only a draft whose lines total more than the resolved limit", () => {
    const atDefault = environment({ large_invoice: 500000 });
    expect(
      largeInvoiceCondition(
        draft([
          { quantity: 3, unitPriceCents: 12000 },
          { quantity: 1, unitPriceCents: 4500 },
        ]),
        atDefault,
        BACKGROUND_CONTEXT,
      ),
    ).toBe(false);
    expect(
      largeInvoiceCondition(
        draft([{ quantity: 10, unitPriceCents: 90000 }]),
        atDefault,
        BACKGROUND_CONTEXT,
      ),
    ).toBe(true);
    // Exactly the limit is not over it.
    expect(
      largeInvoiceCondition(
        draft([{ quantity: 5, unitPriceCents: 100000 }]),
        atDefault,
        BACKGROUND_CONTEXT,
      ),
    ).toBe(false);
  });

  it("reads the business's own limit, so an overlay changes what waits", () => {
    const raised = environment({ large_invoice: 1000000 });
    expect(
      largeInvoiceCondition(
        draft([{ quantity: 10, unitPriceCents: 90000 }]),
        raised,
        BACKGROUND_CONTEXT,
      ),
    ).toBe(false);
    const lowered = environment({ large_invoice: 10000 });
    expect(
      largeInvoiceCondition(
        draft([{ quantity: 3, unitPriceCents: 12000 }]),
        lowered,
        BACKGROUND_CONTEXT,
      ),
    ).toBe(true);
  });

  it("fails safe on a draft it cannot sum and on a limit it cannot resolve", () => {
    const atDefault = environment({ large_invoice: 500000 });
    expect(largeInvoiceCondition(draft([]), atDefault, BACKGROUND_CONTEXT)).toBe(true);
    expect(largeInvoiceCondition({}, atDefault, BACKGROUND_CONTEXT)).toBe(true);
    expect(
      largeInvoiceCondition(
        draft([{ quantity: 1, unitPriceCents: "4000" }]),
        atDefault,
        BACKGROUND_CONTEXT,
      ),
    ).toBe(true);
    expect(
      largeInvoiceCondition(
        draft([{ quantity: -1, unitPriceCents: 4000 }]),
        atDefault,
        BACKGROUND_CONTEXT,
      ),
    ).toBe(true);
    expect(
      largeInvoiceCondition(
        draft([{ quantity: 3, unitPriceCents: 12000 }]),
        environment({}),
        BACKGROUND_CONTEXT,
      ),
    ).toBe(true);
  });
});

describe("the new_recipient condition", () => {
  it("applies only when the address differs from the customer's own", async () => {
    const condition = newRecipientCondition(seeded());
    const environment = { read: {}, limits: {} } as never;
    expect(
      await condition(
        { invoice: "1042", to: "accounts@example.com" },
        environment,
        BACKGROUND_CONTEXT,
      ),
    ).toBe(true);
    expect(
      await condition(
        { invoice: "1042", to: "GUEST@example.com " },
        environment,
        BACKGROUND_CONTEXT,
      ),
    ).toBe(false);
    // No `to` at all is the customer's own address on file: the send is not gated.
    expect(await condition({ invoice: "1042" }, environment, BACKGROUND_CONTEXT)).toBe(false);
  });

  it("fails safe when the client cannot answer", async () => {
    const environment = { read: {}, limits: {} } as never;
    const other = newRecipientCondition(seeded());
    expect(
      await other({ invoice: "9999", to: "accounts@example.com" }, environment, BACKGROUND_CONTEXT),
    ).toBe(true);
    expect(await other({ invoice: "1042", to: 42 }, environment, BACKGROUND_CONTEXT)).toBe(true);

    // No client bound: there is no address on file to compare against, so the send waits.
    const unbound = newRecipientCondition(undefined);
    expect(
      await unbound(
        { invoice: "1042", to: "accounts@example.com" },
        environment,
        BACKGROUND_CONTEXT,
      ),
    ).toBe(true);
    // A customer with no email on file waits too, even though the draft names an address.
    const books = fakeQuickBooks({
      customers: [SECOND_GUEST],
      invoices: [
        {
          id: "5001",
          customerId: "customer-2",
          issuedOn: day(-2),
          dueOn: day(28),
          total: usd(1000),
          balance: usd(1000),
          lines: [line("Parts", 1, 1000)],
        },
      ],
    });
    expect(
      await newRecipientCondition(books)(
        { invoice: "5001", to: "accounts@example.com" },
        environment,
        BACKGROUND_CONTEXT,
      ),
    ).toBe(true);
  });
});
