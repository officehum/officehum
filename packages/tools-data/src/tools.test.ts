/**
 * The four tools, driven directly. Nothing here needs a Python interpreter: CSV, Parquet and JSON are
 * loaded in process, and the Excel refusals happen before the worker is asked to run anything. The
 * interpreter-backed workbook tests are in office.test.ts.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { localVersionedFileStore, type VersionedFileStore } from "@officehum/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHART_RENDER, DATA_EXPORT, DATA_INSPECT, DATA_QUERY } from "./definitions.js";
import { type DataPackOptions, dataPack } from "./pack.js";
import {
  callTool,
  decimalText,
  leasedInput,
  leaseOf,
  putFile,
  salesTotals,
  tableRows,
} from "./test-helpers.js";

let root = "";
let store: VersionedFileStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "data-tools-"));
  store = localVersionedFileStore(join(root, "files"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function pack(overrides: Partial<DataPackOptions> = {}) {
  return dataPack({ filesFor: async () => store, createdBy: "role:data-desk", ...overrides });
}

const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

describe("the pack", () => {
  it("carries four replay-safe tools", () => {
    const tools = pack().tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      DATA_INSPECT,
      DATA_QUERY,
      DATA_EXPORT,
      CHART_RENDER,
    ]);
    expect(tools.map((tool) => tool.replay)).toEqual(["safe", "safe", "safe", "safe"]);
    expect(pack().id).toBe("data");
  });
});

describe("data_inspect", () => {
  it("gives the columns with their types, the row count, missing values and ten rows", async () => {
    const sales = await putFile(store, "sales.csv");
    const result = await callTool(pack(), DATA_INSPECT, { file_id: sales.id });
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain(`sales.csv (file ${sales.id})`);
    expect(result.text).toContain("10000 rows, 8 columns.");
    expect(result.text).toContain("| order_date | DATE | 0 |");
    expect(result.text).toContain("| quantity | BIGINT | 0 |");
    expect(result.text).toContain("| amount | DECIMAL(38,6) | 0 |");
    expect(result.text).toContain("SO-100001");
    expect(result.text).not.toContain("SO-100011");
    expect(result.details).toMatchObject({ rows: 10_000 });
  });

  it("counts the values each column is missing", async () => {
    const file = await putFile(
      store,
      "gaps.csv",
      new TextEncoder().encode("name,amount\nA,1.50\n,2.00\nC,\n"),
    );
    const result = await callTool(pack(), DATA_INSPECT, { file_id: file.id });
    expect(result.text).toContain("| name | VARCHAR | 1 |");
    expect(result.text).toContain("| amount | DECIMAL(38,6) | 1 |");
    expect(result.text).toContain("| NULL |");
  });
});

describe("data_query", () => {
  it("gives exact sums, to the cent, over 10,000 rows", async () => {
    const sales = await putFile(store, "sales.csv");
    const expected = salesTotals();
    const result = await callTool(pack(), DATA_QUERY, {
      tables: [{ name: "sales", file_id: sales.id }],
      sql: "SELECT region, sum(amount) AS total, count(*) AS orders FROM sales GROUP BY region ORDER BY region",
    });
    expect(result.isError).toBeUndefined();
    const [header, ...rows] = tableRows(result.text);
    expect(header).toEqual(["region", "total", "orders"]);
    expect(rows.map((row) => [row[0], row[1]])).toEqual(
      [...expected.byRegion.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([region, cents]) => [region, decimalText(cents)]),
    );
    expect(rows.reduce((sum, row) => sum + Number(row[2]), 0)).toBe(10_000);

    const total = await callTool(pack(), DATA_QUERY, {
      tables: [{ name: "sales", file_id: sales.id }],
      sql: "SELECT sum(amount) AS total FROM sales",
    });
    expect(tableRows(total.text)[1]).toEqual([decimalText(expected.cents)]);
  });

  it("rounds nothing the SQL did not ask it to", async () => {
    const file = await putFile(store, "one.csv", new TextEncoder().encode("a\n1\n"));
    const result = await callTool(pack(), DATA_QUERY, {
      tables: [{ name: "t", file_id: file.id }],
      sql: "SELECT 0.1::DOUBLE + 0.2::DOUBLE AS sum, round(2 / 3, 2) AS rounded, 1/3 AS third FROM t",
    });
    expect(tableRows(result.text)[1]).toEqual([
      "0.30000000000000004",
      "0.67",
      "0.3333333333333333",
    ]);
  });

  it("matches bank payments to open invoices by amount and reference", async () => {
    const bank = await putFile(store, "bank-statement.csv");
    const invoices = await putFile(store, "open-invoices.csv");
    const tables = [
      { name: "bank", file_id: bank.id },
      { name: "invoices", file_id: invoices.id },
    ];
    const matched = await callTool(pack(), DATA_QUERY, {
      tables,
      sql: [
        "SELECT i.invoice_number, b.date AS paid_on, b.amount",
        "FROM invoices i JOIN bank b",
        "  ON b.amount = i.amount AND strpos(b.description, i.invoice_number) > 0",
        "ORDER BY i.invoice_number",
      ].join("\n"),
    });
    expect(tableRows(matched.text).slice(1)).toEqual([
      ["INV-1001", "2026-10-01", "1250.000000"],
      ["INV-1002", "2026-10-03", "480.500000"],
      ["INV-1006", "2026-10-16", "156.200000"],
      ["INV-1008", "2026-10-24", "1999.990000"],
      ["INV-1009", "2026-10-10", "899.000000"],
    ]);

    const open = await callTool(pack(), DATA_QUERY, {
      tables,
      sql: [
        "SELECT invoice_number, amount FROM invoices i",
        "WHERE NOT EXISTS (SELECT 1 FROM bank b",
        "  WHERE b.amount = i.amount AND strpos(b.description, i.invoice_number) > 0)",
        "ORDER BY invoice_number",
      ].join("\n"),
    });
    // INV-1004 has the same amount as the INV-1009 payment, but not its reference.
    expect(
      tableRows(open.text)
        .slice(1)
        .map((row) => row[0]),
    ).toEqual(["INV-1003", "INV-1004", "INV-1005", "INV-1007", "INV-1010"]);
  });

  it.each([
    ["COPY", "COPY sales TO '/tmp/officehum-data-stolen.csv'", "not-select"],
    ["ATTACH", "ATTACH '/tmp/officehum-data.db' AS other", "not-select"],
    ["INSTALL", "INSTALL httpfs", "not-select"],
    ["PRAGMA", "PRAGMA database_list", "not-select"],
    ["SET", "SET enable_external_access = true", "not-select"],
    ["two statements", "SELECT 1; SELECT 2", "not-select"],
    ["read_csv('/etc/passwd')", "SELECT * FROM read_csv('/etc/passwd')", "query-failed"],
  ])("refuses %s", async (_name, sql, code) => {
    const sales = await putFile(store, "bank-statement.csv");
    const result = await callTool(pack(), DATA_QUERY, {
      tables: [{ name: "sales", file_id: sales.id }],
      sql,
    });
    expect(result.isError).toBe(true);
    expect(result.details.code).toBe(code);
    expect(result.text).toMatch(new RegExp(`^data_query refused \\(${code}\\)`, "u"));
  });

  it("saves a result over 200 rows as a CSV file, and a replay returns the same file", async () => {
    const sales = await putFile(store, "sales.csv");
    const args = {
      tables: [{ name: "sales", file_id: sales.id }],
      sql: "SELECT order_id, amount FROM sales ORDER BY order_id",
    };
    const first = await callTool(pack(), DATA_QUERY, args, "call-replayed");
    expect(first.text).toContain(
      "10000 rows, more than 200, so they were saved as query-result.csv",
    );
    const [fileId] = first.details.files as string[];
    const saved = await store.get(fileId ?? "");
    const lines = text(saved?.bytes).trim().split("\r\n");
    expect(lines).toHaveLength(10_001);
    expect(lines[0]).toBe("order_id,amount");
    expect(lines[1]).toBe("SO-100001,298.000000");
    expect(saved?.ref.metadata).toMatchObject({ source: "derived", derivedFrom: [sales.id] });

    const replay = await callTool(pack(), DATA_QUERY, args, "call-replayed");
    expect(replay.details.files).toEqual([fileId]);
  });

  it("loads Parquet and JSON files", async () => {
    const folder = join(root, "made");
    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    await connection.run(
      `CREATE TABLE p AS SELECT * FROM (VALUES ('A-1', 12.50::DECIMAL(10,2)), ('A-2', 7.25::DECIMAL(10,2))) v(sku, price)`,
    );
    await rm(folder, { recursive: true, force: true });
    await connection.run(`COPY p TO '${folder}.parquet' (FORMAT parquet)`);
    connection.closeSync();
    instance.closeSync();
    const parquet = await putFile(
      store,
      "prices.parquet",
      new Uint8Array(await readFile(`${folder}.parquet`)),
    );
    const json = await putFile(
      store,
      "stock.json",
      new TextEncoder().encode('[{"sku": "A-1", "on_hand": 4}, {"sku": "A-2", "on_hand": 10}]'),
    );
    const result = await callTool(pack(), DATA_QUERY, {
      tables: [
        { name: "prices", file_id: parquet.id },
        { name: "stock", file_id: json.id },
      ],
      sql: "SELECT sum(price * on_hand) AS value FROM prices JOIN stock USING (sku)",
    });
    expect(tableRows(result.text)[1]).toEqual(["122.50"]);
  });

  it("frames values from an outside file as data, not instructions", async () => {
    const bank = await putFile(store, "bank-statement.csv", undefined, "external");
    const result = await callTool(pack(), DATA_QUERY, {
      tables: [{ name: "bank", file_id: bank.id }],
      sql: "SELECT count(*) AS lines FROM bank",
    });
    expect(result.text).toContain("outside the office");
    expect(result.text).toContain("| 10 |");
  });

  it("refuses bad table names, unknown files and a sheet of a CSV file", async () => {
    const bank = await putFile(store, "bank-statement.csv");
    const ask = (tables: unknown) => callTool(pack(), DATA_QUERY, { tables, sql: "SELECT 1" });
    expect((await ask([{ name: "1bad", file_id: bank.id }])).details.code).toBe("invalid-request");
    expect(
      (
        await ask([
          { name: "a", file_id: bank.id },
          { name: "A", file_id: bank.id },
        ])
      ).text,
    ).toContain("two tables are named A");
    expect((await ask([{ name: "a", file_id: "file_missing" }])).details.code).toBe("not-found");
    expect((await ask([{ name: "a", file_id: bank.id, sheet: "Sheet1" }])).text).toContain(
      "which has no sheets",
    );
    const none = await callTool(pack({ filesFor: async () => undefined }), DATA_QUERY, {
      tables: [{ name: "a", file_id: bank.id }],
      sql: "SELECT 1",
    });
    expect(none.details.code).toBe("no-files");
  });

  it("reads an Excel workbook only through the lease and the Paper worker", async () => {
    const workbook = await putFile(store, "open-invoices.xlsx");
    const ask = (options: Partial<DataPackOptions>) =>
      callTool(pack(options), DATA_QUERY, {
        tables: [{ name: "invoices", file_id: workbook.id }],
        sql: "SELECT 1",
      });
    expect((await ask({})).details.code).toBe("no-lease");
    expect((await ask({ leaseFor: async () => leaseOf([]) })).details.code).toBe("ungranted-input");
    expect(
      (await ask({ leaseFor: async () => leaseOf([leasedInput(workbook)]) })).details.code,
    ).toBe("no-service");
  });
});

describe("data_export", () => {
  it("saves the rows as a CSV file, adding the extension", async () => {
    const bank = await putFile(store, "bank-statement.csv");
    const result = await callTool(pack(), DATA_EXPORT, {
      tables: [{ name: "bank", file_id: bank.id }],
      sql: "SELECT date, description, amount FROM bank WHERE amount < 0 ORDER BY date",
      format: "csv",
      name: "outgoings",
    });
    expect(result.isError).toBeUndefined();
    const [fileId] = result.details.files as string[];
    const saved = await store.get(fileId ?? "");
    expect(saved?.ref.name).toBe("outgoings.csv");
    expect(text(saved?.bytes)).toBe(
      [
        "date,description,amount",
        "2026-10-02,DIRECT DEBIT OFFICE RENT OCTOBER,-2750.000000",
        "2026-10-08,CARD PAYMENT STATIONERY WHOLESALE,-312.480000",
        "2026-10-20,BANK CHARGES,-18.500000",
        "",
      ].join("\r\n"),
    );
    expect(result.text).toContain('"published":false');
  });

  it("refuses .xlsx without the Paper worker, and points to CSV", async () => {
    const bank = await putFile(store, "bank-statement.csv");
    const result = await callTool(pack(), DATA_EXPORT, {
      tables: [{ name: "bank", file_id: bank.id }],
      sql: "SELECT * FROM bank",
      format: "xlsx",
      name: "bank.xlsx",
    });
    expect(result.details.code).toBe("no-service");
    expect(result.text).toContain("Export as csv");
  });
});

describe("chart_render", () => {
  const spec = {
    mark: "bar",
    encoding: {
      x: { field: "region", type: "nominal" },
      y: { field: "total", type: "quantitative" },
    },
  };

  it("charts the query's result and saves it as a PNG, with a preview", async () => {
    const sales = await putFile(store, "sales.csv");
    const result = await callTool(pack(), CHART_RENDER, {
      tables: [{ name: "sales", file_id: sales.id }],
      sql: "SELECT region, sum(amount) AS total FROM sales GROUP BY region ORDER BY region",
      spec,
      name: "sales-by-region",
    });
    expect(result.isError).toBeUndefined();
    const image = result.output.find((block) => block.type === "image");
    expect(Buffer.from(image?.data ?? "", "base64").byteLength).toBeLessThanOrEqual(100_000);
    const [fileId] = result.details.files as string[];
    const saved = await store.get(fileId ?? "");
    expect(saved?.ref).toMatchObject({ name: "sales-by-region.png", mimeType: "image/png" });
    expect(result.text).toContain('"rows":4');
  });

  it("refuses a spec that carries its own values before reading any file", async () => {
    const result = await callTool(pack(), CHART_RENDER, {
      tables: [{ name: "sales", file_id: "file_never_read" }],
      sql: "SELECT 1",
      spec: { ...spec, data: { values: [{ region: "East", total: 1_000_000 }] } },
    });
    expect(result.details.code).toBe("invalid-spec");
    expect(result.text).toContain("a chart may not carry values");
  });
});
