/**
 * `@officehum/quickbooks`: a portable, typed QuickBooks Online client. A host binds either the REST
 * client (`quickbooksClient`) or the in-memory fake (`fakeQuickBooks`) into a Bookkeeper role's
 * `quickbooks` client, so the tools never know which one they hold. See docs/design/agent-package.md.
 */

export { quickbooksClient } from "./client.js";
export {
  QuickBooksAuthError,
  QuickBooksError,
  type QuickBooksFault,
  QuickBooksNetworkError,
  QuickBooksNotFoundError,
  QuickBooksServerError,
  QuickBooksThrottleError,
  QuickBooksValidationError,
} from "./errors.js";
export { fakeQuickBooks } from "./fake.js";
export type {
  CurrencyCode,
  Customer,
  Invoice,
  InvoiceDraft,
  InvoiceFilter,
  InvoiceLine,
  InvoiceLineDraft,
  InvoiceSeed,
  InvoiceStatus,
  Money,
  Payment,
  PaymentFilter,
  QuickBooks,
  QuickBooksOptions,
  QuickBooksSeed,
  SendOptions,
  WriteOptions,
} from "./types.js";
