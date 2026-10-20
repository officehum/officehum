/**
 * The REST client against recorded HTTP fixtures: no network, no credential, no sandbox. The
 * fixture answers the way QuickBooks Online does — the same paths, the same `QueryResponse` and
 * `{ Invoice }` envelopes, the same `Fault` error body — and records every request so a test can
 * assert the exact request shape, including the `requestid` every write must carry.
 */

import { describe, expect, it } from "vitest";
import {
  QuickBooksAuthError,
  type QuickBooksError,
  QuickBooksNetworkError,
  QuickBooksNotFoundError,
  QuickBooksServerError,
  QuickBooksThrottleError,
  QuickBooksValidationError,
  quickbooksClient,
} from "./index.js";

type Json = Record<string, unknown>;

function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const REALM = "9130347";
const COMPANY = `/v3/company/${REALM}`;

type Call = {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: Json | undefined;
};

// A recorded invoice response, shaped the way GET /v3/company/{realm}/invoice/{id} answers.
function invoiceRecord(overrides: Json = {}): Json {
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

function fixture(environment: "sandbox" | "production" = "sandbox") {
  const calls: Call[] = [];
  const customers = new Map<string, Json>([
    [
      "58",
      {
        Id: "58",
        DisplayName: "Acme Corp",
        Active: true,
        PrimaryEmailAddr: { Address: "ap@acme.example" },
      },
    ],
    ["59", { Id: "59", DisplayName: "Bravo Ltd", Active: false }],
  ]);
  const invoices = new Map<string, Json>([["130", invoiceRecord()]]);
  const payments = new Map<string, Json>([
    [
      "300",
      {
        Id: "300",
        TxnDate: "2026-01-20",
        TotalAmt: 360,
        CustomerRef: { value: "58" },
        CurrencyRef: { value: "USD" },
        Line: [{ LinkedTxn: [{ TxnId: "130", TxnType: "Invoice" }] }],
      },
    ],
  ]);
  const byRequestId = new Map<string, Json>();
  let nextId = 900;

  const transport: typeof fetch = async (input, init = {}) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url,
    );
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Json) : undefined;
    calls.push({
      method,
      url,
      headers: new Headers(init.headers),
      ...(body === undefined ? {} : { body }),
    });

    if (!url.pathname.startsWith(COMPANY)) {
      return json(404, { Fault: { type: "ValidationFault", Error: [{ Message: "Wrong realm" }] } });
    }

    if (url.pathname === `${COMPANY}/query`) {
      const statement = url.searchParams.get("query") ?? "";
      if (statement.includes("from Customer")) {
        const needle = /DisplayName like '%([^'%]*)%'/.exec(statement)?.[1];
        const list = [...customers.values()].filter(
          (customer) =>
            needle === undefined ||
            String(customer.DisplayName).toLowerCase().includes(needle.toLowerCase()),
        );
        return json(200, { QueryResponse: list.length === 0 ? {} : { Customer: list } });
      }
      if (statement.includes("from Invoice")) {
        return json(200, { QueryResponse: { Invoice: [...invoices.values()] } });
      }
      if (statement.includes("from Payment")) {
        return json(200, { QueryResponse: { Payment: [...payments.values()] } });
      }
      return json(400, {
        Fault: { type: "ValidationFault", Error: [{ Message: `Unsupported query: ${statement}` }] },
      });
    }

    const single = /^\/v3\/company\/[^/]+\/(customer|invoice)\/([^/]+)$/.exec(url.pathname);
    if (single !== null) {
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
      const prior = byRequestId.get(requestId);
      if (prior !== undefined) return json(200, { Invoice: prior });
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
    if (send !== null) {
      const id = decodeURIComponent(send[1] ?? "");
      const record = invoices.get(id);
      if (record === undefined) {
        return json(404, { Fault: { Error: [{ Message: "Object Not Found", code: "610" }] } });
      }
      return json(200, { Invoice: record });
    }

    return json(500, { Fault: { Error: [{ Message: "unexpected fixture request" }] } });
  };

  const client = quickbooksClient({
    realmId: REALM,
    getAccessToken: async () => "sandbox-secret-token",
    environment,
    fetch: transport,
  });
  return { client, calls };
}

const draft = {
  customerId: "58",
  issuedOn: "2026-01-05",
  dueOn: "2026-02-04",
  lines: [{ description: "Consulting", quantity: 3, unitPrice: { cents: 12000, currency: "USD" } }],
};

describe("QuickBooks REST client against recorded fixtures", () => {
  it("reads one customer and searches by display name through the query endpoint", async () => {
    const { client, calls } = fixture();

    expect(await client.getCustomer("58")).toEqual({
      id: "58",
      displayName: "Acme Corp",
      active: true,
      email: "ap@acme.example",
    });
    const lookup = calls.at(-1);
    expect(lookup?.method).toBe("GET");
    expect(lookup?.url.pathname).toBe(`${COMPANY}/customer/58`);
    expect(lookup?.headers.get("authorization")).toBe("Bearer sandbox-secret-token");

    expect((await client.findCustomers("bravo")).map((c) => c.id)).toEqual(["59"]);
    expect(calls.at(-1)?.url.searchParams.get("query")).toBe(
      "select * from Customer where DisplayName like '%bravo%'",
    );
    // An empty query lists every customer rather than building a `like '%%'`.
    expect((await client.findCustomers("")).map((c) => c.id)).toEqual(["58", "59"]);
    expect(calls.at(-1)?.url.searchParams.get("query")).toBe("select * from Customer");
  });

  it("builds the invoice and payment query filter and derives the overdue status", async () => {
    const { client, calls } = fixture();

    const invoices = await client.listInvoices({
      customerId: "58",
      status: "overdue",
      since: "2026-01-01",
    });
    expect(calls.at(-1)?.url.searchParams.get("query")).toBe(
      "select * from Invoice where CustomerRef = '58' and TxnDate >= '2026-01-01'",
    );
    expect(invoices.map((invoice) => invoice.id)).toEqual(["130"]);
    expect(invoices[0]).toMatchObject({
      customerId: "58",
      status: "overdue",
      total: { cents: 36000, currency: "USD" },
      balance: { cents: 36000, currency: "USD" },
    });
    // Only the sales-item line is an invoice line; the subtotal line is a total, not a line.
    expect(invoices[0]?.lines).toEqual([
      {
        description: "Consulting",
        quantity: 3,
        unitPrice: { cents: 12000, currency: "USD" },
        amount: { cents: 36000, currency: "USD" },
        itemId: "1",
      },
    ]);

    const payments = await client.listPayments({ customerId: "58" });
    expect(calls.at(-1)?.url.searchParams.get("query")).toBe(
      "select * from Payment where CustomerRef = '58'",
    );
    expect(payments).toEqual([
      {
        id: "300",
        customerId: "58",
        receivedOn: "2026-01-20",
        total: { cents: 36000, currency: "USD" },
        invoiceIds: ["130"],
      },
    ]);
  });

  it("creates an invoice with the requestid parameter and replays it on a retry", async () => {
    const { client, calls } = fixture();

    const created = await client.createInvoice(draft, { requestId: "create-1" });
    const call = calls.at(-1);
    expect(call?.method).toBe("POST");
    expect(call?.url.pathname).toBe(`${COMPANY}/invoice`);
    expect(call?.url.searchParams.get("requestid")).toBe("create-1");
    expect(call?.headers.get("content-type")).toBe("application/json");
    expect(call?.body).toEqual({
      CustomerRef: { value: "58" },
      TxnDate: "2026-01-05",
      DueDate: "2026-02-04",
      Line: [
        {
          LineNum: 1,
          Description: "Consulting",
          Amount: 360,
          DetailType: "SalesItemLineDetail",
          SalesItemLineDetail: { Qty: 3, UnitPrice: 120 },
        },
      ],
    });
    expect(created).toMatchObject({
      customerId: "58",
      total: { cents: 36000, currency: "USD" },
      balance: { cents: 36000, currency: "USD" },
    });

    const retried = await client.createInvoice(draft, { requestId: "create-1" });
    expect(retried.id).toBe(created.id);
  });

  it("sends an invoice with the requestid and the sendTo address, and never a body", async () => {
    const { client, calls } = fixture();

    const sent = await client.sendInvoice("130", { requestId: "send-1", to: "ap@acme.example" });
    const call = calls.at(-1);
    expect(call?.method).toBe("POST");
    expect(call?.url.pathname).toBe(`${COMPANY}/invoice/130/send`);
    expect(call?.url.searchParams.get("requestid")).toBe("send-1");
    expect(call?.url.searchParams.get("sendTo")).toBe("ap@acme.example");
    expect(call?.body).toBeUndefined();
    expect(sent.id).toBe("130");

    await client.sendInvoice("130", { requestId: "send-2" });
    expect(calls.at(-1)?.url.searchParams.get("sendTo")).toBeNull();
  });

  it("carries requestid on every write it makes, and only on writes", async () => {
    const { client, calls } = fixture();
    await client.findCustomers("acme");
    await client.getCustomer("58");
    await client.listInvoices();
    await client.createInvoice(draft, { requestId: "write-a" });
    await client.sendInvoice("130", { requestId: "write-b" });

    const writes = calls.filter((call) => call.method !== "GET");
    expect(writes.map((call) => call.url.searchParams.get("requestid"))).toEqual([
      "write-a",
      "write-b",
    ]);
    for (const call of calls.filter((entry) => entry.method === "GET")) {
      expect(call.url.searchParams.get("requestid")).toBeNull();
    }
  });

  it("uses the sandbox base URL or the production one as the environment asks", async () => {
    const sandbox = fixture("sandbox");
    await sandbox.client.getCustomer("58");
    expect(sandbox.calls[0]?.url.origin).toBe("https://sandbox-quickbooks.api.intuit.com");

    const production = fixture("production");
    await production.client.getCustomer("58");
    expect(production.calls[0]?.url.origin).toBe("https://quickbooks.api.intuit.com");
    expect(production.calls[0]?.url.searchParams.get("minorversion")).toBe("75");
  });

  it("maps an unknown id to a not-found error carrying QuickBooks' own message", async () => {
    const { client } = fixture();
    let caught: unknown;
    try {
      await client.getInvoice("missing");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(QuickBooksNotFoundError);
    const error = caught as QuickBooksNotFoundError;
    expect(error.status).toBe(404);
    expect(error.message).toContain("Object Not Found");
    expect(error.message).toContain("610");
    expect(error.message).toMatch(/deleted/i);
  });

  it.each([
    [401, QuickBooksAuthError],
    [403, QuickBooksAuthError],
    [400, QuickBooksValidationError],
    [422, QuickBooksValidationError],
    [429, QuickBooksThrottleError],
    [500, QuickBooksServerError],
    [503, QuickBooksServerError],
  ])("maps HTTP %i to a typed error that keeps the API message and code", async (status, Type) => {
    const client = quickbooksClient({
      realmId: REALM,
      getAccessToken: async () => "token",
      environment: "sandbox",
      fetch: async () =>
        json(status, {
          Fault: {
            type: "ValidationFault",
            Error: [
              {
                Message: "Duplicate Name Exists Error",
                Detail: "The name supplied already exists.",
                code: "6240",
                element: "DisplayName",
              },
            ],
          },
        }),
    });

    let caught: unknown;
    try {
      await client.createInvoice(draft, { requestId: "boom" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Type);
    const error = caught as QuickBooksError;
    expect(error.status).toBe(status);
    expect(error.code).toBe("6240");
    expect(error.type).toBe("ValidationFault");
    // The API's own words survive into the message, alongside a hint at the fix.
    expect(error.message).toContain("Duplicate Name Exists Error");
    expect(error.message).toMatch(/retry|reconnect|wait|Fix/i);
  });

  it("maps a dropped connection, a refused token and malformed JSON to typed errors", async () => {
    const network = quickbooksClient({
      realmId: REALM,
      getAccessToken: async () => "token",
      environment: "sandbox",
      fetch: async () => {
        throw new Error("network-secret");
      },
    });
    let caught: unknown;
    try {
      await network.findCustomers("acme");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(QuickBooksNetworkError);
    expect((caught as Error).message).toMatch(/check the network/i);
    expect((caught as Error).message).not.toContain("network-secret");

    const refused = quickbooksClient({
      realmId: REALM,
      getAccessToken: async () => "",
      environment: "sandbox",
      fetch: async () => json(200, {}),
    });
    await expect(refused.getCustomer("58")).rejects.toThrow(/nonempty access token/i);

    const thrown = quickbooksClient({
      realmId: REALM,
      getAccessToken: async () => {
        throw new Error("token-callback-secret");
      },
      environment: "sandbox",
      fetch: async () => json(200, {}),
    });
    await expect(thrown.getCustomer("58")).rejects.toThrow(/could not obtain/i);

    const malformed = quickbooksClient({
      realmId: REALM,
      getAccessToken: async () => "token",
      environment: "sandbox",
      fetch: async () => new Response("not json", { status: 200 }),
    });
    await expect(malformed.getCustomer("58")).rejects.toThrow(/malformed/i);
  });

  it("validates its options and the draft before it sends anything", async () => {
    expect(() =>
      quickbooksClient({
        realmId: REALM,
        getAccessToken: async () => "token",
        environment: "live" as "sandbox",
        fetch: async () => json(200, {}),
      }),
    ).toThrow(/sandbox.*production/i);

    const { client, calls } = fixture();
    await expect(
      client.createInvoice(
        {
          customerId: "58",
          lines: [{ description: "X", quantity: 0, unitPrice: { cents: 1, currency: "USD" } }],
        },
        { requestId: "bad-draft" },
      ),
    ).rejects.toThrow(/line 1 quantity/i);
    expect(calls).toHaveLength(0);
  });
});
