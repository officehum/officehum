/**
 * The REST implementation of `QuickBooks`, against the QuickBooks Online Accounting API.
 *
 * Every write carries the `requestid` query parameter: QuickBooks replays the first response for a
 * repeated `requestid` on the same endpoint, which is what makes a retried create idempotent rather
 * than a duplicate. The client owns no credential — the host supplies a fresh bearer token through
 * `getAccessToken` on every call.
 */

import {
  QuickBooksAuthError,
  QuickBooksError,
  type QuickBooksFault,
  QuickBooksNetworkError,
  QuickBooksNotFoundError,
  QuickBooksServerError,
  QuickBooksThrottleError,
  QuickBooksValidationError,
} from "./errors.js";
import {
  amountFromCents,
  bounded,
  centsFromAmount,
  invoiceLines,
  money,
  statusOf,
  validDate,
  validId,
  validRequestId,
} from "./money.js";
import type {
  CurrencyCode,
  Customer,
  Invoice,
  InvoiceLine,
  Payment,
  QuickBooks,
  QuickBooksOptions,
} from "./types.js";

const BASES = {
  sandbox: "https://sandbox-quickbooks.api.intuit.com",
  production: "https://quickbooks.api.intuit.com",
} as const;

/**
 * QuickBooks pins behaviour to a minor version. 75 is the version this client was written against;
 * sending it keeps a company's responses stable as the API adds fields.
 */
const MINOR_VERSION = "75";
const REQUEST_TIMEOUT_MS = 30_000;
/** QuickBooks omits `CurrencyRef` unless the company turns multicurrency on; USD is then assumed. */
const DEFAULT_CURRENCY = "USD";

type Json = Record<string, unknown>;

function malformed(label: string): QuickBooksError {
  return new QuickBooksError(
    `QuickBooks returned malformed ${label} data; the response did not match the QuickBooks schema.`,
  );
}

function asJson(value: unknown, label: string): Json {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw malformed(label);
  return value as Json;
}

function textOf(value: unknown, label: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  throw malformed(label);
}

function optionalText(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return undefined;
}

function numberOf(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw malformed(label);
  return value;
}

function dateOf(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw malformed(label);
  return value;
}

function currencyOf(value: Json): CurrencyCode {
  const ref = value.CurrencyRef;
  if (ref !== null && typeof ref === "object" && !Array.isArray(ref)) {
    const code = (ref as Json).value;
    if (typeof code === "string" && /^[A-Z]{3}$/.test(code)) return code;
  }
  return DEFAULT_CURRENCY;
}

function emailOf(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return optionalText((value as Json).Address);
}

/** A single-quoted QuickBooks query literal, with backslashes and quotes escaped. */
function queryLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function customerOf(record: unknown): Customer {
  const value = asJson(record, "customer");
  const id = textOf(value.Id, "customer id");
  const displayName = textOf(value.DisplayName ?? value.CompanyName, "customer display name");
  const email = emailOf(value.PrimaryEmailAddr);
  return {
    id,
    displayName,
    active: value.Active === undefined ? true : value.Active === true,
    ...(email === undefined ? {} : { email }),
  };
}

function lineOf(record: unknown, currency: CurrencyCode): InvoiceLine {
  const value = asJson(record, "invoice line");
  const detail = asJson(value.SalesItemLineDetail, "invoice line detail");
  const amount = money(centsFromAmount(value.Amount, "invoice line amount"), currency);
  const unitPrice = money(
    centsFromAmount(detail.UnitPrice ?? value.Amount, "invoice line unit price"),
    currency,
  );
  const itemNode = detail.ItemRef;
  const itemId =
    itemNode === null || typeof itemNode !== "object" || Array.isArray(itemNode)
      ? undefined
      : optionalText((itemNode as Json).value);
  return {
    description: optionalText(value.Description) ?? "",
    quantity: numberOf(detail.Qty ?? 1, "invoice line quantity"),
    unitPrice,
    amount,
    ...(itemId === undefined ? {} : { itemId }),
  };
}

function invoiceOf(record: unknown): Invoice {
  const value = asJson(record, "invoice");
  const id = textOf(value.Id, "invoice id");
  const customerId = textOf(
    asJson(value.CustomerRef, "invoice customer").value,
    "invoice customer id",
  );
  const currency = currencyOf(value);
  const total = money(centsFromAmount(value.TotalAmt, "invoice total"), currency);
  const balance = money(
    centsFromAmount(value.Balance ?? value.TotalAmt, "invoice balance"),
    currency,
  );
  const issuedOn = dateOf(value.TxnDate, "invoice date");
  const dueOn = dateOf(value.DueDate ?? value.TxnDate, "invoice due date");
  const number = optionalText(value.DocNumber);
  const lines = value.Line;
  if (!Array.isArray(lines)) throw malformed("invoice lines");
  return {
    id,
    customerId,
    issuedOn,
    dueOn,
    status: statusOf(balance.cents, dueOn),
    total,
    balance,
    // QuickBooks mixes subtotal, discount and tax detail lines in with the billable ones; only the
    // sales-item lines are the invoice's actual lines.
    lines: lines
      .filter(
        (line) =>
          line !== null &&
          typeof line === "object" &&
          !Array.isArray(line) &&
          (line as Json).DetailType === "SalesItemLineDetail",
      )
      .map((line) => lineOf(line, currency)),
    ...(number === undefined ? {} : { number }),
  };
}

function invoiceIdsOf(value: Json): string[] {
  const lines = value.Line;
  if (lines === undefined) return [];
  if (!Array.isArray(lines)) throw malformed("payment lines");
  const ids: string[] = [];
  for (const line of lines) {
    const linked = asJson(line, "payment line").LinkedTxn;
    if (linked === undefined) continue;
    if (!Array.isArray(linked)) throw malformed("payment line links");
    for (const txn of linked) {
      const valueTxn = asJson(txn, "payment link");
      if (valueTxn.TxnType !== "Invoice") continue;
      const id = optionalText(valueTxn.TxnId);
      if (id !== undefined && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

function paymentOf(record: unknown): Payment {
  const value = asJson(record, "payment");
  return {
    id: textOf(value.Id, "payment id"),
    customerId: textOf(asJson(value.CustomerRef, "payment customer").value, "payment customer id"),
    receivedOn: dateOf(value.TxnDate, "payment date"),
    total: money(centsFromAmount(value.TotalAmt, "payment total"), currencyOf(value)),
    invoiceIds: invoiceIdsOf(value),
  };
}

/** The first fault QuickBooks reported, so a mapped error can carry the API's own message and code. */
function providerFault(body: unknown): {
  message: string | undefined;
  code: string | undefined;
  type: string | undefined;
} {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { message: undefined, code: undefined, type: undefined };
  }
  const fault = (body as Json).Fault;
  if (fault === null || typeof fault !== "object" || Array.isArray(fault)) {
    return { message: undefined, code: undefined, type: undefined };
  }
  const record = fault as Json;
  const type = typeof record.type === "string" ? record.type : undefined;
  const entries = record.Error;
  const first = Array.isArray(entries) ? entries[0] : entries;
  if (first === null || typeof first !== "object" || Array.isArray(first)) {
    return { message: undefined, code: undefined, type };
  }
  const error = first as Json;
  return { message: optionalText(error.Message), code: optionalText(error.code), type };
}

function errorFor(operation: string, status: number, body: unknown): QuickBooksError {
  const fault = providerFault(body);
  const api = fault.message === undefined ? "" : ` ${fault.message}.`;
  const code = fault.code === undefined ? "" : ` (QuickBooks code ${fault.code})`;
  const info: QuickBooksFault = { status, code: fault.code, type: fault.type };
  if (status === 401 || status === 403) {
    return new QuickBooksAuthError(
      `QuickBooks rejected the ${operation} (${status}):${api}${code} The access token is missing, expired, or lacks scope; reconnect the QuickBooks app and retry.`,
      info,
    );
  }
  if (status === 404) {
    return new QuickBooksNotFoundError(
      `QuickBooks has no record for the ${operation} (404).${api}${code} Check the id; the record may have been deleted.`,
      info,
    );
  }
  if (status === 400 || status === 422) {
    return new QuickBooksValidationError(
      `QuickBooks rejected the ${operation} (${status}):${api}${code} Fix the request and retry with a new requestId.`,
      info,
    );
  }
  if (status === 429) {
    return new QuickBooksThrottleError(
      `QuickBooks throttled the ${operation} (429).${api}${code} Retry after a short wait.`,
      info,
    );
  }
  if (status >= 500) {
    return new QuickBooksServerError(
      `QuickBooks failed the ${operation} (${status}):${api}${code} Retry later.`,
      info,
    );
  }
  return new QuickBooksError(`QuickBooks failed the ${operation} (${status}):${api}${code}`, info);
}

export function quickbooksClient(options: QuickBooksOptions): QuickBooks {
  const realmId = bounded(options.realmId, "Realm ID", 200);
  const environment: string = options.environment;
  if (environment !== "sandbox" && environment !== "production") {
    throw new Error(
      `QuickBooks environment must be "sandbox" or "production" (got ${JSON.stringify(environment)}).`,
    );
  }
  const transport = options.fetch ?? globalThis.fetch;
  if (typeof transport !== "function") {
    throw new Error("A fetch implementation is required; pass one, or run on Node 18 or newer.");
  }
  if (typeof options.getAccessToken !== "function") {
    throw new Error("A getAccessToken callback is required; the host owns the OAuth token.");
  }

  const base = `${BASES[environment]}/v3/company/${encodeURIComponent(realmId)}`;
  const endpoint = (path: string, params: Record<string, string> = {}): URL => {
    const url = new URL(`${base}${path}`);
    url.searchParams.set("minorversion", MINOR_VERSION);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    return url;
  };

  async function readBody(response: Response, operation: string): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw malformed(`${operation} response`);
    }
  }

  async function readBodySafely(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return undefined;
    }
  }

  async function request(operation: string, url: URL, init: RequestInit = {}): Promise<unknown> {
    let token: string;
    try {
      token = await options.getAccessToken();
    } catch {
      throw new QuickBooksNetworkError(
        `The ${operation} could not obtain an access token from the host; check getAccessToken and retry.`,
      );
    }
    if (typeof token !== "string" || token.trim().length === 0) {
      throw new QuickBooksNetworkError(
        `The ${operation} needs a nonempty access token; the host's getAccessToken returned none.`,
      );
    }
    let response: Response;
    try {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${token}`);
      headers.set("accept", "application/json");
      if (init.body !== undefined) headers.set("content-type", "application/json");
      response = await transport(url, {
        ...init,
        headers,
        signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new QuickBooksNetworkError(
        `The ${operation} could not reach the QuickBooks API; check the network and retry.`,
      );
    }
    if (response.status !== 200 && response.status !== 201) {
      throw errorFor(operation, response.status, await readBodySafely(response));
    }
    return readBody(response, operation);
  }

  function queryResponse(body: unknown): Json {
    return asJson(asJson(body, "query result").QueryResponse, "query response");
  }

  function entityList(body: unknown, key: string): unknown[] {
    const list = queryResponse(body)[key];
    if (list === undefined) return [];
    if (!Array.isArray(list)) throw malformed(`${key} list`);
    return list;
  }

  function statementFor(entity: string, conditions: readonly string[]): string {
    return `select * from ${entity}${conditions.length === 0 ? "" : ` where ${conditions.join(" and ")}`}`;
  }

  const compareInvoices = (left: Invoice, right: Invoice): number =>
    left.issuedOn.localeCompare(right.issuedOn) || left.id.localeCompare(right.id);

  const comparePayments = (left: Payment, right: Payment): number =>
    left.receivedOn.localeCompare(right.receivedOn) || left.id.localeCompare(right.id);

  return {
    async findCustomers(query) {
      if (typeof query !== "string") {
        throw new Error('A customer search query is required; pass "" to list every customer.');
      }
      const trimmed = query.trim();
      const statement =
        trimmed.length === 0
          ? statementFor("Customer", [])
          : statementFor("Customer", [`DisplayName like '%${queryLiteral(trimmed)}%'`]);
      const body = await request("customer search", endpoint("/query", { query: statement }));
      return entityList(body, "Customer").map(customerOf);
    },

    async getCustomer(id) {
      const customerId = validId(id, "Customer ID");
      const body = await request(
        "customer lookup",
        endpoint(`/customer/${encodeURIComponent(customerId)}`),
      );
      return customerOf(asJson(body, "customer result").Customer);
    },

    async listInvoices(filter = {}) {
      const customerId =
        filter.customerId === undefined ? undefined : validId(filter.customerId, "Customer ID");
      const since = filter.since === undefined ? undefined : validDate(filter.since, "since");
      const conditions: string[] = [];
      if (customerId !== undefined) conditions.push(`CustomerRef = '${queryLiteral(customerId)}'`);
      if (since !== undefined) conditions.push(`TxnDate >= '${since}'`);
      const body = await request(
        "invoice listing",
        endpoint("/query", { query: statementFor("Invoice", conditions) }),
      );
      const invoices = entityList(body, "Invoice").map(invoiceOf).sort(compareInvoices);
      return filter.status === undefined
        ? invoices
        : invoices.filter((invoice) => invoice.status === filter.status);
    },

    async getInvoice(id) {
      const invoiceId = validId(id, "Invoice ID");
      const body = await request(
        "invoice lookup",
        endpoint(`/invoice/${encodeURIComponent(invoiceId)}`),
      );
      return invoiceOf(asJson(body, "invoice result").Invoice);
    },

    async createInvoice(draft, options) {
      const requestId = validRequestId(options.requestId, "Request ID");
      const customerId = validId(draft.customerId, "Customer ID");
      const lines = invoiceLines(draft.lines);
      const body: Json = {
        CustomerRef: { value: customerId },
        Line: lines.map((line, index) => ({
          LineNum: index + 1,
          Description: line.description,
          Amount: amountFromCents(line.amount.cents),
          DetailType: "SalesItemLineDetail",
          SalesItemLineDetail: {
            Qty: line.quantity,
            UnitPrice: amountFromCents(line.unitPrice.cents),
            ...(line.itemId === undefined ? {} : { ItemRef: { value: line.itemId } }),
          },
        })),
      };
      if (draft.number !== undefined) body.DocNumber = bounded(draft.number, "Invoice number", 100);
      if (draft.issuedOn !== undefined) body.TxnDate = validDate(draft.issuedOn, "Invoice date");
      if (draft.dueOn !== undefined) body.DueDate = validDate(draft.dueOn, "Invoice due date");
      const result = await request(
        "invoice creation",
        endpoint("/invoice", { requestid: requestId }),
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      );
      return invoiceOf(asJson(result, "invoice result").Invoice);
    },

    async sendInvoice(id, options) {
      const invoiceId = validId(id, "Invoice ID");
      const requestId = validRequestId(options.requestId, "Request ID");
      const to =
        options.to === undefined ? undefined : bounded(options.to, "Recipient address", 320);
      const result = await request(
        "invoice send",
        endpoint(`/invoice/${encodeURIComponent(invoiceId)}/send`, {
          requestid: requestId,
          ...(to === undefined ? {} : { sendTo: to }),
        }),
        { method: "POST" },
      );
      return invoiceOf(asJson(result, "invoice result").Invoice);
    },

    async listPayments(filter = {}) {
      const customerId =
        filter.customerId === undefined ? undefined : validId(filter.customerId, "Customer ID");
      const since = filter.since === undefined ? undefined : validDate(filter.since, "since");
      const conditions: string[] = [];
      if (customerId !== undefined) conditions.push(`CustomerRef = '${queryLiteral(customerId)}'`);
      if (since !== undefined) conditions.push(`TxnDate >= '${since}'`);
      const body = await request(
        "payment listing",
        endpoint("/query", { query: statementFor("Payment", conditions) }),
      );
      return entityList(body, "Payment").map(paymentOf).sort(comparePayments);
    },
  };
}
