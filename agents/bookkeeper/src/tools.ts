/**
 * The Bookkeeper's six tools over the host's `@officehum/quickbooks` client, and the two approval
 * conditions that `officehum.json` cannot express as conditions on a tool's arguments.
 *
 * The client is whoever the host binds — Office Hum the REST client, a test or an eval
 * `fakeQuickBooks` — and every figure these tools speak comes back from it as integer cents. No tool
 * works out an amount, a total or a balance; the receipt quotes what QuickBooks returned. Every write
 * carries a `requestId` derived from the durable call identity, so a retried call reuses QuickBooks'
 * own idempotency instead of creating a second invoice.
 *
 * The client is optional, as Front Desk's Messenger is: a host with no QuickBooks connection — the
 * bare eval harness, for one — still gets every tool and condition, and each refuses clearly rather
 * than reaching for a connection it does not have.
 */

import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Customer, Invoice, InvoiceDraft, Money, QuickBooks } from "@officehum/quickbooks";
import type { ApprovalCondition } from "@officehum/sdk";

/** The durable identity of one tool call, as Pi Durable hands it to a tool's `execute`. */
export interface CallIdentity {
  readonly conversationId: unknown;
  readonly taskId: unknown;
  readonly callId: string;
}

/**
 * The `requestId` for one write: the durable call identity, hashed into QuickBooks' 50-character cap.
 * QuickBooks replays the first response for a repeated `requestid` on the same endpoint, so a retried
 * call gets the invoice it already created rather than a duplicate. A call identity is often longer
 * than 50 characters and truncating it could make two calls in one conversation collide, so it is
 * hashed rather than cut.
 */
export function writeRequestId(api: CallIdentity): string {
  const identity = `${String(api.conversationId)}:${String(api.taskId)}:${api.callId}`;
  return `bk-${createHash("sha256").update(identity).digest("hex").slice(0, 40)}`;
}

/** The six tools, named, so the factory places each one where `officehum.json` declares it. */
export interface BookkeeperToolset {
  readonly findCustomer: ToolRegistration;
  readonly listInvoices: ToolRegistration;
  readonly getInvoice: ToolRegistration;
  readonly createInvoice: ToolRegistration;
  readonly sendInvoice: ToolRegistration;
  readonly sendReminder: ToolRegistration;
}

/** The client, or a refusal: a host with no QuickBooks connection gets no read and no write. */
function requireQuickBooks(quickbooks: QuickBooks | undefined): QuickBooks {
  if (quickbooks === undefined) {
    throw new Error("No QuickBooks client is configured for the Bookkeeper.");
  }
  return quickbooks;
}

/** A client figure as text: its exact cents shown as a decimal, never a recomputed amount. */
function moneyText(amount: Money): string {
  return `${(amount.cents / 100).toFixed(2)} ${amount.currency}`;
}

/** How the model names an invoice: its document number when it has one, plus its id when they differ. */
function invoiceLabel(invoice: Invoice): string {
  if (invoice.number === undefined || invoice.number === invoice.id) return invoice.id;
  return `${invoice.number} (id ${invoice.id})`;
}

/** One customer as a UI reads it. */
type CustomerDetails = {
  id: string;
  displayName: string;
  email: string | null;
  active: boolean;
};

/** One line of an invoice as a UI reads it, all three figures in integer cents. */
type InvoiceLineDetails = {
  description: string;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
};

/** One invoice as a UI reads it. */
type InvoiceDetails = {
  id: string;
  customerId: string;
  number: string | null;
  issuedOn: string;
  dueOn: string;
  status: string;
  totalCents: number;
  balanceCents: number;
  currency: string;
  lines: InvoiceLineDetails[];
};

/** The details shapes the tools report. Each is one shape for every outcome of its tool. */
type FoundCustomersDetails = { found: boolean; customers: CustomerDetails[] };
type InvoiceListDetails = {
  found: boolean;
  customer: CustomerDetails | null;
  invoices: InvoiceDetails[];
};
type InvoiceReportDetails = { found: boolean; invoice: InvoiceDetails | null };
type CreatedInvoiceDetails = {
  created: boolean;
  invoice: InvoiceDetails | null;
  requestId: string;
};
type SentInvoiceDetails = { sent: boolean; invoice: InvoiceDetails | null; to: string | null };
type ReminderDetails = {
  sent: boolean;
  invoice: InvoiceDetails | null;
  tone: ReminderTone;
  to: string | null;
};

/** The three tones the collections skill sends a reminder in. */
export type ReminderTone = "friendly" | "firm" | "final";

/** One customer as details: no optional field, so a UI always reads one shape. */
function customerJson(customer: Customer): CustomerDetails {
  return {
    id: customer.id,
    displayName: customer.displayName,
    email: customer.email ?? null,
    active: customer.active,
  };
}

/** One invoice as details: figures in the integer cents the client reported, never recomputed. */
function invoiceJson(invoice: Invoice): InvoiceDetails {
  return {
    id: invoice.id,
    customerId: invoice.customerId,
    number: invoice.number ?? null,
    issuedOn: invoice.issuedOn,
    dueOn: invoice.dueOn,
    status: invoice.status,
    totalCents: invoice.total.cents,
    balanceCents: invoice.balance.cents,
    currency: invoice.total.currency,
    lines: invoice.lines.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unitPriceCents: line.unitPrice.cents,
      amountCents: line.amount.cents,
    })),
  };
}

/** Two addresses that differ only in surrounding whitespace or case are the same address. */
function sameAddress(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/**
 * One line of text for the model. Every tool reports the same way, so the shape a tool returns never
 * varies: `output` (never the 1.2.0 `content`, which the SDK's guard refuses), `details`, and
 * `isError` only when the call failed.
 */
function textResult(value: string) {
  return { output: [{ type: "text" as const, text: value }] };
}

/** `YYYY-MM-DD`, `days` from today in UTC: the only date form QuickBooks accepts. */
function dueDate(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The customer a tool was handed a reference to: its QuickBooks id, or its exact display name. A name
 * is accepted only when it matches exactly one customer, so a tool never guesses between two
 * customers with similar names.
 */
export async function findCustomerByReference(
  quickbooks: QuickBooks,
  reference: string,
): Promise<Customer | undefined> {
  try {
    return await quickbooks.getCustomer(reference);
  } catch {
    // Not an id: fall through to the display name, which is what a person or the model holds.
  }
  const wanted = reference.trim().toLowerCase();
  const matches = (await quickbooks.findCustomers(reference.trim())).filter(
    (candidate) => candidate.displayName.trim().toLowerCase() === wanted,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The invoice a tool was handed a reference to: its QuickBooks id, or the document number printed on
 * the invoice. A number is accepted only when it identifies exactly one invoice.
 */
export async function findInvoiceByReference(
  quickbooks: QuickBooks,
  reference: string,
): Promise<Invoice | undefined> {
  try {
    return await quickbooks.getInvoice(reference);
  } catch {
    // Not an id: fall through to the document number, which is what a customer quotes.
  }
  const wanted = reference.trim();
  const matches = (await quickbooks.listInvoices()).filter(
    (invoice) => invoice.id === wanted || invoice.number === wanted,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/** One line of an invoice being built: what the job did, how much of it, and the unit price in cents. */
const lineParameters = Type.Object(
  {
    description: Type.String({ description: "What the job did, in the invoice's own words" }),
    quantity: Type.Number({ description: "How many units, e.g. 3 hours or 10 days" }),
    unitPriceCents: Type.Integer({
      description: "The unit price in integer cents, taken from the job and never rounded",
    }),
    itemId: Type.Optional(
      Type.String({ description: "A QuickBooks item id, when the job names one" }),
    ),
  },
  { additionalProperties: false },
);

/**
 * Builds the six tools over one client. Every one is plain Pi Durable: it installs into any harness,
 * and a bare harness with no client builds the same tools and refuses at the point of use.
 */
export function bookkeeperTools(quickbooks: QuickBooks | undefined): BookkeeperToolset {
  const findCustomer = defineTool({
    name: "find_customer",
    description:
      "Find a customer by name or email. Returns each match's QuickBooks id, its display name and the email on file.",
    parameters: Type.Object(
      {
        name: Type.Optional(
          Type.String({ description: "All or part of the customer's display name" }),
        ),
        email: Type.Optional(
          Type.String({ description: "The email address on the customer's record" }),
        ),
      },
      { additionalProperties: false },
    ),
    replay: "safe",
    execute: async (args) => {
      const books = requireQuickBooks(quickbooks);
      const searched = args.name !== undefined || args.email !== undefined;
      const byName = args.name === undefined ? undefined : await books.findCustomers(args.name);
      const candidates = !searched ? [] : (byName ?? (await books.findCustomers("")));
      const wanted = args.email?.trim().toLowerCase();
      const customers = candidates.filter(
        (candidate) =>
          wanted === undefined ||
          (candidate.email !== undefined && sameAddress(candidate.email, wanted)),
      );
      // One details shape for a match and a miss, so a UI reads `found` and `customers` either way.
      const details: FoundCustomersDetails = {
        found: customers.length > 0,
        customers: customers.map(customerJson),
      };
      if (!searched) {
        return {
          ...textResult("Give find_customer a name or an email to search by."),
          isError: true,
          details,
        };
      }
      if (customers.length === 0) {
        return {
          ...textResult(
            "No customer matches that search. Try another spelling, or ask for the email on the " +
              "customer's record.",
          ),
          isError: true,
          details,
        };
      }
      return {
        ...textResult(
          [
            "Customers:",
            ...customers.map(
              (customer) =>
                `${customer.displayName} — ${customer.id} — ${customer.email ?? "no email on file"}`,
            ),
          ].join("\n"),
        ),
        details,
      };
    },
  });

  const listInvoices = defineTool({
    name: "list_invoices",
    description:
      "List a customer's invoices, filtered by status: open, overdue or paid. Returns each invoice's number, total, balance and due date.",
    parameters: Type.Object(
      {
        customer: Type.Optional(
          Type.String({
            description: "The customer's QuickBooks id from find_customer, or its exact name",
          }),
        ),
        status: Type.Optional(
          Type.Union([Type.Literal("open"), Type.Literal("overdue"), Type.Literal("paid")], {
            description: "Only invoices in this state",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    replay: "safe",
    execute: async (args) => {
      const books = requireQuickBooks(quickbooks);
      const customer =
        args.customer === undefined
          ? undefined
          : await findCustomerByReference(books, args.customer);
      const invoices =
        args.customer !== undefined && customer === undefined
          ? []
          : await books.listInvoices({
              ...(customer === undefined ? {} : { customerId: customer.id }),
              ...(args.status === undefined ? {} : { status: args.status }),
            });
      const scope =
        customer === undefined ? "every customer" : `${customer.displayName} (${customer.id})`;
      // One details shape whether the customer, the filter or the invoices come back empty.
      const details: InvoiceListDetails = {
        found: invoices.length > 0,
        customer: customer === undefined ? null : customerJson(customer),
        invoices: invoices.map(invoiceJson),
      };
      if (args.customer !== undefined && customer === undefined) {
        return {
          ...textResult(
            `No customer matches "${args.customer}". Call find_customer and use the id it returns.`,
          ),
          isError: true,
          details,
        };
      }
      return {
        ...textResult(
          [
            invoices.length === 0 ? `No invoices for ${scope}` : `Invoices for ${scope}:`,
            ...invoices.map(
              (invoice) =>
                `${invoiceLabel(invoice)} — ${invoice.status} — total ${moneyText(invoice.total)} — balance ${moneyText(invoice.balance)} — due ${invoice.dueOn}`,
            ),
          ].join("\n"),
        ),
        details,
      };
    },
  });

  const getInvoice = defineTool({
    name: "get_invoice",
    description:
      "Read one invoice: its lines, total, balance and due date. Takes the id from list_invoices, or the invoice number a customer quotes.",
    parameters: Type.Object(
      {
        invoice: Type.String({
          description: "The invoice's QuickBooks id, or its document number",
        }),
      },
      { additionalProperties: false },
    ),
    replay: "safe",
    execute: async (args) => {
      const books = requireQuickBooks(quickbooks);
      const invoice = await findInvoiceByReference(books, args.invoice);
      const details: InvoiceReportDetails = {
        found: invoice !== undefined,
        invoice: invoice === undefined ? null : invoiceJson(invoice),
      };
      if (invoice === undefined) {
        return {
          ...textResult(
            `No invoice matches "${args.invoice}". Call list_invoices and use the id or number it returns.`,
          ),
          isError: true,
          details,
        };
      }
      return {
        ...textResult(
          [
            `Invoice ${invoiceLabel(invoice)} — ${invoice.status}`,
            "Lines:",
            ...invoice.lines.map(
              (line) =>
                `  ${line.description} — ${line.quantity} × ${moneyText(line.unitPrice)} — ${moneyText(line.amount)}`,
            ),
            `Total: ${moneyText(invoice.total)}`,
            `Balance: ${moneyText(invoice.balance)}`,
            `Due: ${invoice.dueOn}`,
          ].join("\n"),
        ),
        details,
      };
    },
  });

  const createInvoice = defineTool({
    name: "create_invoice",
    description:
      "Create an invoice for a customer from a job's lines. The billing system works out each amount and the total, and an invoice over the business's large-amount limit waits for a person.",
    parameters: Type.Object(
      {
        customer: Type.String({ description: "The customer's QuickBooks id, from find_customer" }),
        lines: Type.Array(lineParameters, {
          minItems: 1,
          description: "One line per piece of work, each priced in integer cents",
        }),
        dueInDays: Type.Optional(
          Type.Integer({
            minimum: 0,
            description: "How many days from today the invoice is due, e.g. 30",
          }),
        ),
        jobReference: Type.Optional(
          Type.String({
            description:
              "The job this invoices, e.g. JOB-1042; it becomes the invoice's document number, so one job's invoice can be found again",
          }),
        ),
        currency: Type.Optional(
          Type.String({
            description: "The invoice's three-letter ISO 4217 currency code; defaults to USD",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const books = requireQuickBooks(quickbooks);
      const currency = args.currency ?? "USD";
      const draft: InvoiceDraft = {
        customerId: args.customer,
        lines: args.lines.map((line) => ({
          description: line.description,
          quantity: line.quantity,
          unitPrice: { cents: line.unitPriceCents, currency },
          ...(line.itemId === undefined ? {} : { itemId: line.itemId }),
        })),
        ...(args.dueInDays === undefined ? {} : { dueOn: dueDate(args.dueInDays) }),
        ...(args.jobReference === undefined ? {} : { number: args.jobReference }),
      };
      const requestId = writeRequestId(api);
      const invoice = await books.createInvoice(draft, { requestId });
      const count = invoice.lines.length === 1 ? "1 line" : `${invoice.lines.length} lines`;
      const details: CreatedInvoiceDetails = {
        created: true,
        invoice: invoiceJson(invoice),
        requestId,
      };
      return {
        ...textResult(
          `Created invoice ${invoiceLabel(invoice)} for customer ${invoice.customerId}: ${count}, total ${moneyText(invoice.total)}, due ${invoice.dueOn}.`,
        ),
        details,
      };
    },
  });

  const sendInvoice = defineTool({
    name: "send_invoice",
    description:
      "Send an invoice to the customer's email on file, or to another address a person approves. An address other than the one on file waits for a person.",
    parameters: Type.Object(
      {
        invoice: Type.String({
          description: "The invoice's QuickBooks id, or its document number",
        }),
        to: Type.Optional(
          Type.String({ description: "Another address to send to; needs a person's approval" }),
        ),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const books = requireQuickBooks(quickbooks);
      const invoice = await findInvoiceByReference(books, args.invoice);
      const customer =
        invoice === undefined ? undefined : await books.getCustomer(invoice.customerId);
      const address = args.to ?? customer?.email;
      const details: SentInvoiceDetails = {
        sent: false,
        invoice: invoice === undefined ? null : invoiceJson(invoice),
        to: address ?? null,
      };
      if (invoice === undefined) {
        return {
          ...textResult(
            `No invoice matches "${args.invoice}". Call list_invoices and use the id or number it returns.`,
          ),
          isError: true,
          details,
        };
      }
      if (address === undefined || customer === undefined) {
        return {
          ...textResult(
            `${customer?.displayName ?? "That customer"} has no email on file, so invoice ${invoiceLabel(invoice)} has nowhere to go. Give send_invoice an address a person can approve.`,
          ),
          isError: true,
          details,
        };
      }
      const sent = await books.sendInvoice(invoice.id, {
        requestId: writeRequestId(api),
        ...(args.to === undefined ? {} : { to: args.to }),
      });
      return {
        ...textResult(
          `Sent invoice ${invoiceLabel(sent)} to ${address}. The balance is ${moneyText(sent.balance)}, due ${sent.dueOn}.`,
        ),
        details: { sent: true, invoice: invoiceJson(sent), to: address },
      };
    },
  });

  const sendReminder = defineTool({
    name: "send_reminder",
    description:
      "Send a collections reminder for an overdue invoice, in a friendly, firm or final tone. One reminder per invoice, and a final notice waits for a person.",
    parameters: Type.Object(
      {
        invoice: Type.String({
          description: "The invoice's QuickBooks id, or its document number",
        }),
        tone: Type.Union([Type.Literal("friendly"), Type.Literal("firm"), Type.Literal("final")], {
          description:
            "friendly while the invoice is fresh, firm once it is overdue, and final only with a person's approval",
        }),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const books = requireQuickBooks(quickbooks);
      const invoice = await findInvoiceByReference(books, args.invoice);
      const customer =
        invoice === undefined ? undefined : await books.getCustomer(invoice.customerId);
      const details: ReminderDetails = {
        sent: false,
        invoice: invoice === undefined ? null : invoiceJson(invoice),
        tone: args.tone,
        to: customer?.email ?? null,
      };
      if (invoice === undefined) {
        return {
          ...textResult(
            `No invoice matches "${args.invoice}". Call list_invoices and use the id or number it returns.`,
          ),
          isError: true,
          details,
        };
      }
      if (invoice.status === "paid") {
        return {
          ...textResult(
            `Invoice ${invoiceLabel(invoice)} has a zero balance, so it is paid: it gets no reminder. Leave it alone.`,
          ),
          isError: true,
          details,
        };
      }
      if (customer === undefined || customer.email === undefined) {
        return {
          ...textResult(
            `${customer?.displayName ?? "That customer"} has no email on file, so a reminder for invoice ${invoiceLabel(invoice)} has nowhere to go.`,
          ),
          isError: true,
          details,
        };
      }
      // QuickBooks has no reminder endpoint of its own: a dunning reminder is the invoice sent again,
      // which is why the tone is the role's wording and the receipt is the send's. The requestId is
      // this call's, so a retried reminder is not a second one.
      const sent = await books.sendInvoice(invoice.id, { requestId: writeRequestId(api) });
      return {
        ...textResult(
          `Sent a ${args.tone} reminder for invoice ${invoiceLabel(sent)} to ${customer.email}: balance ${moneyText(sent.balance)}, due ${sent.dueOn}.`,
        ),
        details: { sent: true, invoice: invoiceJson(sent), tone: args.tone, to: customer.email },
      };
    },
  });

  return {
    findCustomer,
    listInvoices,
    getInvoice,
    createInvoice,
    sendInvoice,
    sendReminder,
  };
}

/**
 * Whether a draft's own lines come to more than the business's `large_invoice` limit. The lines are
 * summed in integer cents exactly the way QuickBooks sums them — quantity × unit price, rounded to
 * whole cents, then added — and the limit is the *resolved* one: the manifest's default, or the value
 * an overlay set, so the role never hard-codes a threshold.
 *
 * It returns `true` (the invoice waits for a person) for anything it cannot compare: a draft whose
 * lines are missing or malformed, or a limit that did not resolve. `false` — no approval — is only
 * ever returned for a total that is genuinely within the business's own amount.
 */
export const largeInvoiceCondition: ApprovalCondition = (args, environment) => {
  const lines = args.lines;
  if (!Array.isArray(lines) || lines.length === 0) return true;
  let total = 0;
  for (const line of lines) {
    if (line === null || typeof line !== "object") return true;
    const fields = line as Record<string, unknown>;
    const quantity = fields.quantity;
    const unitPrice = fields.unitPriceCents;
    if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity <= 0) return true;
    if (typeof unitPrice !== "number" || !Number.isSafeInteger(unitPrice) || unitPrice < 0) {
      return true;
    }
    total += Math.round(quantity * unitPrice);
  }
  const limit = environment.limits.large_invoice;
  if (typeof limit !== "number" || !Number.isFinite(limit)) return true;
  return total > limit;
};

/**
 * Whether a send names an address other than the customer's email on file. The address on file is
 * read through the host's client — from the invoice's own customer — rather than trusted from the
 * call, and anything the client cannot answer fails safe: the send waits for a person.
 *
 * A send with no `to` goes to the customer's own stored address, so it is not gated at all: that is
 * the case the manifest's `new_recipient` approval exists to distinguish.
 */
export function newRecipientCondition(quickbooks: QuickBooks | undefined): ApprovalCondition {
  return async (args, _environment, context) => {
    const to = args.to;
    if (to === undefined) return false;
    if (typeof to !== "string" || to.trim().length === 0) return true;
    const reference = args.invoice;
    if (typeof reference !== "string" || reference.trim().length === 0) return true;
    if (quickbooks === undefined) return true;
    try {
      const invoice = await findInvoiceByReference(quickbooks, reference);
      if (invoice === undefined) return true;
      const customer = await quickbooks.getCustomer(invoice.customerId);
      if (customer.email === undefined) return true;
      return !sameAddress(to, customer.email);
    } catch {
      context.abortSignal?.throwIfAborted();
      return true;
    }
  };
}
