/**
 * The portable QuickBooks Online contract: the shapes a Bookkeeper tool reads and writes, and the
 * client the host supplies. Amounts are integer cents plus a currency throughout — never a float —
 * so a total can be compared, summed and stored without rounding drift.
 *
 * This package is standalone: it depends on no Office Hum platform package. The same interface is
 * bound by a host (a role factory's `quickbooks` client), so a caller can swap the REST client for
 * the fake, or later for the connector gateway (RASF-3082), without changing the tools.
 */

/** An ISO 4217 currency code: three uppercase letters, e.g. `"USD"`. */
export type CurrencyCode = string;

/** An exact amount: integer minor units (cents) in one currency. Never a float. */
export interface Money {
  readonly cents: number;
  readonly currency: CurrencyCode;
}

/** A customer a business invoices. `id` is QuickBooks' own id. */
export interface Customer {
  readonly id: string;
  readonly displayName: string;
  /** The primary email address, when QuickBooks holds one. */
  readonly email?: string;
  readonly active: boolean;
}

/** Derived at read time from the balance and the due date; QuickBooks stores no status field. */
export type InvoiceStatus = "open" | "overdue" | "paid";

/** One billable line, as QuickBooks returns it. */
export interface InvoiceLine {
  readonly description: string;
  /** A count of units, which QuickBooks allows to be fractional (e.g. 2.5 hours). */
  readonly quantity: number;
  readonly unitPrice: Money;
  /** `quantity * unitPrice`, rounded to whole cents, as QuickBooks computed it. */
  readonly amount: Money;
  readonly itemId?: string;
}

/** An invoice, with totals in integer cents. */
export interface Invoice {
  readonly id: string;
  readonly customerId: string;
  /** QuickBooks' document number (`DocNumber`), when the company assigns one. */
  readonly number?: string;
  /** The transaction date, `YYYY-MM-DD`. */
  readonly issuedOn: string;
  /** The date payment is due, `YYYY-MM-DD`. */
  readonly dueOn: string;
  readonly status: InvoiceStatus;
  readonly total: Money;
  /** What is still owed. Zero means paid in full. */
  readonly balance: Money;
  readonly lines: readonly InvoiceLine[];
}

/** One line of an invoice being created; QuickBooks computes the amount from quantity and unit price. */
export interface InvoiceLineDraft {
  readonly description: string;
  readonly quantity: number;
  readonly unitPrice: Money;
  readonly itemId?: string;
}

/** The input to `createInvoice`. Omitted dates default the way QuickBooks defaults them. */
export interface InvoiceDraft {
  readonly customerId: string;
  readonly number?: string;
  readonly issuedOn?: string;
  readonly dueOn?: string;
  readonly lines: readonly InvoiceLineDraft[];
}

/** A payment received, applied to zero or more invoices. */
export interface Payment {
  readonly id: string;
  readonly customerId: string;
  /** The payment date, `YYYY-MM-DD`. */
  readonly receivedOn: string;
  readonly total: Money;
  /** The invoices this payment is linked to. */
  readonly invoiceIds: readonly string[];
}

/** Narrows `listInvoices`. Every field is optional and they combine with AND. */
export interface InvoiceFilter {
  readonly customerId?: string;
  readonly status?: InvoiceStatus;
  /** Only invoices issued on or after this `YYYY-MM-DD` date. */
  readonly since?: string;
}

/** Narrows `listPayments`. Every field is optional and they combine with AND. */
export interface PaymentFilter {
  readonly customerId?: string;
  /** Only payments received on or after this `YYYY-MM-DD` date. */
  readonly since?: string;
}

/**
 * The idempotency key for a write. QuickBooks replays the first response for a repeated `requestId`
 * on the same endpoint, so a retried create returns the original record instead of a duplicate.
 * It must be unique per company and at most 50 characters.
 */
export interface WriteOptions {
  readonly requestId: string;
}

export interface SendOptions {
  readonly requestId: string;
  /** The address to send to. Omitted, QuickBooks uses the invoice's stored billing email. */
  readonly to?: string;
}

/** The client every Bookkeeper tool calls. Both the REST client and the fake implement it. */
export interface QuickBooks {
  /** Customers whose display name contains `query`; an empty query lists every customer. */
  findCustomers(query: string): Promise<Customer[]>;
  getCustomer(id: string): Promise<Customer>;
  listInvoices(filter?: InvoiceFilter): Promise<Invoice[]>;
  getInvoice(id: string): Promise<Invoice>;
  createInvoice(draft: InvoiceDraft, options: WriteOptions): Promise<Invoice>;
  sendInvoice(id: string, options: SendOptions): Promise<Invoice>;
  listPayments(filter?: PaymentFilter): Promise<Payment[]>;
}

export interface QuickBooksOptions {
  /** The QuickBooks company id the connection is scoped to. */
  readonly realmId: string;
  /** Supplies a fresh bearer token on every call; the host owns OAuth, so no credential is stored here. */
  readonly getAccessToken: () => Promise<string>;
  readonly environment: "sandbox" | "production";
  /** Overrides `globalThis.fetch`, for a host that injects its own transport. */
  readonly fetch?: typeof fetch;
}

/**
 * A seeded invoice for the fake. The fake derives `status` from the balance and due date, exactly as
 * the REST client does, so a seed never carries a status that contradicts its own figures.
 */
export type InvoiceSeed = Omit<Invoice, "status">;

export interface QuickBooksSeed {
  readonly customers?: readonly Customer[];
  readonly invoices?: readonly InvoiceSeed[];
  readonly payments?: readonly Payment[];
}
