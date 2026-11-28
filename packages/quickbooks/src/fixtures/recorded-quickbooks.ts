/**
 * A recorded QuickBooks Online upstream: a `fetch` that answers the way the Accounting API does — the
 * same paths, the same `QueryResponse` and `{ Invoice }` envelopes, the same `Fault` error body, the
 * same `requestid` replay — and records every request so a test can assert its exact shape. No
 * network, no credential, no sandbox.
 *
 * Test-only: the package's build excludes it. The REST client's tests run against it directly, and
 * the connector gateway's tests import it by path and reach it through the
 * gateway and a credential layer.
 */

import type { Customer, InvoiceSeed, Payment, QuickBooksSeed } from "../types.js";

export type Json = Record<string, unknown>;

/** The company every recording answers for. */
export const REALM = "9130347";
export const COMPANY = `/v3/company/${REALM}`;

export function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export type RecordedCall = {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: Json | undefined;
};

/** QuickBooks' own records, by id, as the API stores them. */
export interface QuickBooksRecords {
  readonly customers?: readonly Json[];
  readonly invoices?: readonly Json[];
  readonly payments?: readonly Json[];
}

export interface RecordedQuickBooks {
  readonly fetch: typeof fetch;
  readonly calls: RecordedCall[];
  readonly customers: Map<string, Json>;
  readonly invoices: Map<string, Json>;
  readonly payments: Map<string, Json>;
}

/** A recorded invoice, shaped the way GET /v3/company/{realm}/invoice/{id} answers. */
export function invoiceRecord(overrides: Json = {}): Json {
  return {
    Id: "130",
    DocNumber: "1037",
    TxnDate: "2026-01-05",
    DueDate: "2026-02-04",
    TotalAmt: 360,
    Balance: 360,
    CustomerRef: { value: "58" },
    CurrencyRef: { value: "USD" },
    Line: [
      {
        Id: "1",
        LineNum: 1,
        Description: "Consulting",
        Amount: 360,
        DetailType: "SalesItemLineDetail",
        SalesItemLineDetail: { ItemRef: { value: "1", name: "Services" }, Qty: 3, UnitPrice: 120 },
      },
      // QuickBooks appends non-billable detail lines; the client must not treat them as invoice lines.
      { LineNum: 2, Amount: 360, DetailType: "SubTotalLineDetail" },
    ],
    ...overrides,
  };
}

const amount = (cents: number): number => cents / 100;

function customerRecord(customer: Customer): Json {
  return {
    Id: customer.id,
    DisplayName: customer.displayName,
    Active: customer.active,
    ...(customer.email === undefined ? {} : { PrimaryEmailAddr: { Address: customer.email } }),
  };
}

function invoiceRecordOf(invoice: InvoiceSeed): Json {
  return {
    Id: invoice.id,
    ...(invoice.number === undefined ? {} : { DocNumber: invoice.number }),
    TxnDate: invoice.issuedOn,
    DueDate: invoice.dueOn,
    TotalAmt: amount(invoice.total.cents),
    Balance: amount(invoice.balance.cents),
    CustomerRef: { value: invoice.customerId },
    CurrencyRef: { value: invoice.total.currency },
    Line: invoice.lines.map((line, index) => ({
      Id: String(index + 1),
      LineNum: index + 1,
      Description: line.description,
      Amount: amount(line.amount.cents),
      DetailType: "SalesItemLineDetail",
      SalesItemLineDetail: {
        Qty: line.quantity,
        UnitPrice: amount(line.unitPrice.cents),
        ...(line.itemId === undefined ? {} : { ItemRef: { value: line.itemId } }),
      },
    })),
  };
}

function paymentRecord(payment: Payment): Json {
  return {
    Id: payment.id,
    TxnDate: payment.receivedOn,
    TotalAmt: amount(payment.total.cents),
    CustomerRef: { value: payment.customerId },
    CurrencyRef: { value: payment.total.currency },
    Line: payment.invoiceIds.map((id) => ({ LinkedTxn: [{ TxnId: id, TxnType: "Invoice" }] })),
  };
}

/** The records QuickBooks would hold for a fake's seed, so one seed drives every implementation. */
export function recordsOf(seed: QuickBooksSeed): QuickBooksRecords {
  return {
    customers: (seed.customers ?? []).map(customerRecord),
    invoices: (seed.invoices ?? []).map(invoiceRecordOf),
    payments: (seed.payments ?? []).map(paymentRecord),
  };
}

/** The `where` conditions a query's statement filters a transaction on. */
function matchesConditions(statement: string, record: Json): boolean {
  const customer = / CustomerRef = '([^']*)'/.exec(statement)?.[1];
  const since = / TxnDate >= '([^']*)'/.exec(statement)?.[1];
  const ref = record.CustomerRef as Json | undefined;
  if (customer !== undefined && ref?.value !== customer) return false;
  if (since !== undefined && String(record.TxnDate) < since) return false;
  return true;
}

export function recordedQuickBooks(records: QuickBooksRecords = {}): RecordedQuickBooks {
  const calls: RecordedCall[] = [];
  const byId = (list: readonly Json[] = []) =>
    new Map<string, Json>(list.map((record) => [String(record.Id), record]));
  const customers = byId(records.customers);
  const invoices = byId(records.invoices);
  const payments = byId(records.payments);
  const byRequestId = new Map<string, Json>();
  let nextId = 900;

  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url,
    );
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Json) : undefined;
    calls.push({ method, url, headers: new Headers(init.headers), body });

    if (!url.pathname.startsWith(COMPANY)) {
      return json(404, { Fault: { type: "ValidationFault", Error: [{ Message: "Wrong realm" }] } });
    }

    if (url.pathname === `${COMPANY}/query`) {
      const statement = url.searchParams.get("query") ?? "";
      // QuickBooks answers a query one page at a time: 100 rows unless `maxresults` asks for more.
      const start = Number(/ startposition (\d+)/.exec(statement)?.[1] ?? 1);
      const size = Number(/ maxresults (\d+)/.exec(statement)?.[1] ?? 100);
      const page = (rows: Json[]) => rows.slice(start - 1, start - 1 + size);
      if (statement.includes("from Customer")) {
        const needle = /DisplayName like '%([^'%]*)%'/.exec(statement)?.[1];
        const list = [...customers.values()].filter(
          (customer) =>
            needle === undefined ||
            String(customer.DisplayName).toLowerCase().includes(needle.toLowerCase()),
        );
        const rows = page(list);
        return json(200, { QueryResponse: rows.length === 0 ? {} : { Customer: rows } });
      }
      for (const [entity, store] of [
        ["Invoice", invoices],
        ["Payment", payments],
      ] as const) {
        if (statement.includes(`from ${entity}`)) {
          const rows = page(
            [...store.values()].filter((record) => matchesConditions(statement, record)),
          );
          return json(200, { QueryResponse: rows.length === 0 ? {} : { [entity]: rows } });
        }
      }
      return json(400, {
        Fault: { type: "ValidationFault", Error: [{ Message: `Unsupported query: ${statement}` }] },
      });
    }

    const single = /^\/v3\/company\/[^/]+\/(customer|invoice)\/([^/]+)$/.exec(url.pathname);
    if (single !== null && method === "GET") {
      const entity = single[1] ?? "";
      const id = decodeURIComponent(single[2] ?? "");
      const record = entity === "customer" ? customers.get(id) : invoices.get(id);
      if (record === undefined) {
        return json(404, {
          Fault: { type: "ValidationFault", Error: [{ Message: "Object Not Found", code: "610" }] },
        });
      }
      return json(200, { [entity === "customer" ? "Customer" : "Invoice"]: record });
    }

    if (url.pathname === `${COMPANY}/invoice` && method === "POST") {
      const requestId = url.searchParams.get("requestid");
      if (requestId === null) {
        return json(400, { Fault: { Error: [{ Message: "requestid is required" }] } });
      }
      // QuickBooks replays the first response for a repeated requestid, whatever the body.
      const prior = byRequestId.get(requestId);
      if (prior !== undefined) return json(200, { Invoice: prior });
      const customerId = String((body?.CustomerRef as Json | undefined)?.value);
      if (!customers.has(customerId)) {
        return json(400, {
          Fault: {
            type: "ValidationFault",
            Error: [{ Message: "Invalid Reference Id", code: "2500" }],
          },
        });
      }
      const lines = Array.isArray(body?.Line) ? (body.Line as Json[]) : [];
      const total = lines.reduce((sum, line) => sum + Number(line.Amount ?? 0), 0);
      const record = invoiceRecord({
        Id: String(nextId),
        CustomerRef: body?.CustomerRef,
        DocNumber: body?.DocNumber,
        TxnDate: body?.TxnDate ?? "2026-01-05",
        DueDate: body?.DueDate ?? "2026-02-04",
        TotalAmt: total,
        Balance: total,
        Line: lines,
      });
      nextId += 1;
      byRequestId.set(requestId, record);
      invoices.set(String(record.Id), record);
      return json(200, { Invoice: record });
    }

    const send = /^\/v3\/company\/[^/]+\/invoice\/([^/]+)\/send$/.exec(url.pathname);
    if (send !== null && method === "POST") {
      const id = decodeURIComponent(send[1] ?? "");
      const record = invoices.get(id);
      if (record === undefined) {
        return json(404, { Fault: { Error: [{ Message: "Object Not Found", code: "610" }] } });
      }
      return json(200, { Invoice: record });
    }

    return json(500, { Fault: { Error: [{ Message: "unexpected fixture request" }] } });
  };

  return { fetch, calls, customers, invoices, payments };
}
