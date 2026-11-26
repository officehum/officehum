/**
 * The second layer alone: statements sent straight to the sandbox, with no statement check, still
 * cannot read a file, reach the network, load an extension or change the configuration. And the
 * limits: time, memory and rows.
 */

import { describe, expect, it } from "vitest";
import { DataError } from "./errors.js";
import { type DataLimits, DEFAULT_DATA_LIMITS, dataLimits, withSandbox } from "./sandbox.js";

const csv = (text: string) => ({
  name: "t",
  format: "csv" as const,
  bytes: new TextEncoder().encode(text),
});

async function unchecked(
  sql: string,
  limits: DataLimits = DEFAULT_DATA_LIMITS,
): Promise<DataError> {
  try {
    await withSandbox([csv("a,b\n1,x\n2,y\n")], limits, (sandbox) => sandbox.run(sql));
  } catch (error) {
    if (error instanceof DataError) return error;
    throw error;
  }
  throw new Error(`the sandbox ran: ${sql}`);
}

describe("the sandbox, with no statement check in front of it", () => {
  it("loads the staged tables and answers from them", async () => {
    const result = await withSandbox([csv("a,b\n1,x\n2,y\n")], DEFAULT_DATA_LIMITS, (sandbox) =>
      sandbox.run("SELECT sum(a) AS total, string_agg(b, '') AS letters FROM t"),
    );
    expect(result.columns).toEqual([
      { name: "total", type: "HUGEINT" },
      { name: "letters", type: "VARCHAR" },
    ]);
    expect(result.rows).toEqual([["3", "xy"]]);
  });

  it.each([
    ["read_csv of /etc/passwd", "SELECT * FROM read_csv('/etc/passwd')"],
    ["read_text", "SELECT * FROM read_text('/etc/hosts')"],
    ["a file by its path", "SELECT * FROM '/etc/passwd'"],
    ["glob", "SELECT * FROM glob('/etc/*')"],
    ["a URL", "SELECT * FROM read_csv('https://example.com/data.csv')"],
    ["COPY", "COPY t TO '/tmp/officehum-data-out.csv'"],
    ["ATTACH", "ATTACH '/tmp/officehum-data-attach.db' AS other"],
    ["INSTALL", "INSTALL httpfs"],
    ["LOAD", "LOAD httpfs"],
    ["turning external access back on", "SET enable_external_access = true"],
    ["raising the memory limit", "SET memory_limit = '64GB'"],
    ["unlocking the configuration", "SET lock_configuration = false"],
  ])("refuses %s", async (_name, sql) => {
    const error = await unchecked(sql);
    expect(error.code).toBe("query-failed");
    // A bare path is not even looked up as a file: with external access off it is only a table name.
    expect(error.message).toMatch(
      /disabled by configuration|configuration has been locked|disabled through configuration|Table with name \/etc\/passwd does not exist/u,
    );
  });

  it("can no longer read the folder the tables were staged in", async () => {
    const error = await withSandbox([csv("a\n1\n")], DEFAULT_DATA_LIMITS, async (sandbox) => {
      const settings = await sandbox.run(
        "SELECT value FROM duckdb_settings() WHERE name = 'allowed_directories'",
      );
      const folder = String(settings.rows[0]?.[0] ?? "").replace(/^\[|\]$/gu, "");
      return sandbox.run(`SELECT * FROM read_csv('${folder}0.csv')`).then(
        () => undefined,
        (failure: unknown) => failure,
      );
    });
    expect(error).toBeInstanceOf(DataError);
  });

  it("stops a query at the time limit and says so", async () => {
    const error = await unchecked("SELECT count(*) FROM range(1000000000000) a", {
      ...DEFAULT_DATA_LIMITS,
      timeoutMs: 300,
    });
    expect(error.code).toBe("timeout");
    expect(error.message).toContain("0.3 s, the limit per call");
  });

  it("stops a query at the memory limit and says so", async () => {
    const error = await unchecked("SELECT list(range) FROM range(50000000)", {
      ...DEFAULT_DATA_LIMITS,
      memoryMb: 32,
    });
    expect(error.code).toBe("memory-limit");
    expect(error.message).toContain("32 MB");
  });

  it("refuses a result with more rows than the limit", async () => {
    const error = await unchecked("SELECT * FROM range(11)", {
      ...DEFAULT_DATA_LIMITS,
      maxResultRows: 10,
    });
    expect(error.code).toBe("too-many-rows");
  });

  it("says which table could not be loaded", async () => {
    const error = await withSandbox(
      [{ name: "broken", format: "parquet", bytes: new TextEncoder().encode("not parquet") }],
      DEFAULT_DATA_LIMITS,
      async () => undefined,
    ).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(DataError);
    expect((error as DataError).code).toBe("unsupported-format");
    expect((error as DataError).message).toContain("table broken could not be loaded as parquet");
  });

  it("lets a host lower the limits, never raise them", () => {
    expect(dataLimits({ timeoutMs: 5_000, memoryMb: 4_096 })).toEqual({
      ...DEFAULT_DATA_LIMITS,
      timeoutMs: 5_000,
    });
  });
});
