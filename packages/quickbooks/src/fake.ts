/**
 * An in-memory `QuickBooks` with the same behaviour as the REST client: the same input validation,
 * the same derived statuses, and the same `requestId` dedupe, so a unit test or an eval exercises
 * the real code paths it cares about without a network or a credential.
 *
 * As in QuickBooks, a requestId is scoped to the endpoint that used it: a createInvoice requestId
 * and a sendInvoice requestId may be equal without one deduping the other.
 */

import { QuickBooksNotFoundError, QuickBooksValidationError } from "./errors.js";
import {
  bounded,
  invoiceLines,
  money,
  statusOf,
  today,
  validDate,
  validId,
  validRequestId,
} from "./money.js";
import type { Customer, Invoice, Payment, QuickBooks, QuickBooksSeed } from "./types.js";

/** An invoice as the fake stores it: without `status`, which is derived on every read. */
type StoredInvoice = Omit<Invoice, "status">;

type Receipt = { readonly fingerprint: string; readonly invoiceId: string };

export function fakeQuickBooks(seed: QuickBooksSeed = {}): QuickBooks {
  const customers = new Map<string, Customer>();
  for (const customer of seed.customers ?? []) customers.set(customer.id, { ...customer });

  const invoices = new Map<string, StoredInvoice>();
  for (const invoice of seed.invoices ?? []) {
    invoices.set(invoice.id, {
      id: invoice.id,
      customerId: invoice.customerId,
      issuedOn: invoice.issuedOn,
      dueOn: invoice.dueOn,
      total: invoice.total,
      balance: invoice.balance,
      lines: invoice.lines.map((line) => ({ ...line })),
      ...(invoice.number === undefined ? {} : { number: invoice.number }),
    });
  }

  const payments = new Map<string, Payment>();
  for (const payment of seed.payments ?? []) {
    payments.set(payment.id, { ...payment, invoiceIds: [...payment.invoiceIds] });
  }

  // One receipt per endpoint+requestId, mirroring QuickBooks' own scope.
  const receipts = new Map<string, Receipt>();
  const seen = (kind: string, requestId: string) => `${kind}\u0000${requestId}`;

  let counter = Math.max(
    1000,
    ...[...invoices.keys()].map((id) => Number(id)).filter((value) => Number.isSafeInteger(value)),
  );
  const nextId = (): string => {
    counter += 1;
    return String(counter);
  };

  const derived = (invoice: StoredInvoice): Invoice => ({
    ...invoice,
    status: statusOf(invoice.balance.cents, invoice.dueOn),
    lines: invoice.lines.map((line) => ({ ...line })),
  });

  const invalid = (message: string): QuickBooksValidationError =>
    new QuickBooksValidationError(message);
  const missing = (message: string): QuickBooksNotFoundError =>
    new QuickBooksNotFoundError(message);

  const comparePayments = (left: Payment, right: Payment): number =>
    left.receivedOn.localeCompare(right.receivedOn) || left.id.localeCompare(right.id);

  return {
    async findCustomers(query) {
      if (typeof query !== "string") {
        throw invalid('A customer search query is required; pass "" to list every customer.');
      }
      const needle = query.trim().toLowerCase();
      return [...customers.values()]
        .filter(
          (customer) => needle.length === 0 || customer.displayName.toLowerCase().includes(needle),
        )
        .sort(
          (left, right) =>
            left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id),
        )
        .map((customer) => ({ ...customer }));
    },

    async getCustomer(id) {
      const customerId = validId(id, "Customer ID");
      const customer = customers.get(customerId);
      if (customer === undefined) {
        throw missing(`No customer ${JSON.stringify(customerId)} exists; check the id.`);
      }
      return { ...customer };
    },

    async listInvoices(filter = {}) {
      const customerId =
        filter.customerId === undefined ? undefined : validId(filter.customerId, "Customer ID");
      const since = filter.since === undefined ? undefined : validDate(filter.since, "since");
      return [...invoices.values()]
        .map(derived)
        .filter((invoice) => customerId === undefined || invoice.customerId === customerId)
        .filter((invoice) => since === undefined || invoice.issuedOn >= since)
        .filter((invoice) => filter.status === undefined || invoice.status === filter.status)
        .sort(
          (left, right) =>
            left.issuedOn.localeCompare(right.issuedOn) || left.id.localeCompare(right.id),
        );
    },

    async getInvoice(id) {
      const invoiceId = validId(id, "Invoice ID");
      const invoice = invoices.get(invoiceId);
      if (invoice === undefined) {
        throw missing(`No invoice ${JSON.stringify(invoiceId)} exists; check the id.`);
      }
      return derived(invoice);
    },

    async createInvoice(draft, options) {
      const requestId = validRequestId(options.requestId, "Request ID");
      const customerId = validId(draft.customerId, "Customer ID");
      const lines = invoiceLines(draft.lines);
      const issuedOn =
        draft.issuedOn === undefined ? today() : validDate(draft.issuedOn, "Invoice date");
      const dueOn =
        draft.dueOn === undefined ? issuedOn : validDate(draft.dueOn, "Invoice due date");
      const number =
        draft.number === undefined ? undefined : bounded(draft.number, "Invoice number", 100);
      const fingerprint = JSON.stringify({
        kind: "invoice",
        customerId,
        number,
        issuedOn,
        dueOn,
        lines: draft.lines,
      });
      const key = seen("invoice", requestId);
      const receipt = receipts.get(key);
      if (receipt !== undefined) {
        if (receipt.fingerprint !== fingerprint) {
          throw invalid(
            `Request ID ${JSON.stringify(requestId)} already created invoice ${receipt.invoiceId} with different arguments; use a new request ID for a different invoice.`,
          );
        }
        const existing = invoices.get(receipt.invoiceId);
        if (existing === undefined) {
          throw invalid(
            `The invoice created for request ID ${JSON.stringify(requestId)} is no longer present.`,
          );
        }
        return derived(existing);
      }
      if (!customers.has(customerId)) {
        throw invalid(
          `No customer ${JSON.stringify(customerId)} exists; create it in QuickBooks first, or pass a known customer id.`,
        );
      }
      const totalCents = lines.reduce((sum, line) => sum + line.amount.cents, 0);
      const currency = lines[0]?.unitPrice.currency ?? "";
      const id = nextId();
      const invoice: StoredInvoice = {
        id,
        customerId,
        issuedOn,
        dueOn,
        total: money(totalCents, currency),
        // A new invoice is unpaid: the whole total is outstanding until a payment is applied.
        balance: money(totalCents, currency),
        lines,
        ...(number === undefined ? {} : { number }),
      };
      invoices.set(id, invoice);
      receipts.set(key, { fingerprint, invoiceId: id });
      return derived(invoice);
    },

    async sendInvoice(id, options) {
      const invoiceId = validId(id, "Invoice ID");
      const requestId = validRequestId(options.requestId, "Request ID");
      const to =
        options.to === undefined ? undefined : bounded(options.to, "Recipient address", 320);
      const fingerprint = JSON.stringify({ kind: "send", invoiceId, to });
      const key = seen("send", requestId);
      const receipt = receipts.get(key);
      if (receipt !== undefined) {
        if (receipt.fingerprint !== fingerprint) {
          throw invalid(
            `Request ID ${JSON.stringify(requestId)} already sent invoice ${receipt.invoiceId} with different arguments; use a new request ID to send it again.`,
          );
        }
        const existing = invoices.get(receipt.invoiceId);
        if (existing === undefined) {
          throw invalid(
            `The invoice sent for request ID ${JSON.stringify(requestId)} is no longer present.`,
          );
        }
        return derived(existing);
      }
      const invoice = invoices.get(invoiceId);
      if (invoice === undefined) {
        throw missing(`No invoice ${JSON.stringify(invoiceId)} exists; check the id.`);
      }
      receipts.set(key, { fingerprint, invoiceId });
      return derived(invoice);
    },

    async listPayments(filter = {}) {
      const customerId =
        filter.customerId === undefined ? undefined : validId(filter.customerId, "Customer ID");
      const since = filter.since === undefined ? undefined : validDate(filter.since, "since");
      return [...payments.values()]
        .filter((payment) => customerId === undefined || payment.customerId === customerId)
        .filter((payment) => since === undefined || payment.receivedOn >= since)
        .map((payment) => ({ ...payment, invoiceIds: [...payment.invoiceIds] }))
        .sort(comparePayments);
    },
  };
}
