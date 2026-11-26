/**
 * The first layer alone: DuckDB's parser decides what a statement is. These run on a plain connection
 * with external access on and nothing locked, so a refusal here is the parser's, not the sandbox's.
 */

import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DataError } from "./errors.js";
import { checkStatement } from "./statement.js";

let instance: DuckDBInstance;
let connection: DuckDBConnection;

beforeAll(async () => {
  instance = await DuckDBInstance.create(":memory:", { threads: "1" });
  connection = await instance.connect();
  await connection.run("CREATE TABLE t AS SELECT 1 AS a");
});

afterAll(() => {
  connection.closeSync();
  instance.closeSync();
});

async function refusal(sql: string): Promise<DataError> {
  try {
    await checkStatement(connection, sql);
  } catch (error) {
    if (error instanceof DataError) return error;
    throw error;
  }
  throw new Error(`the check let through: ${sql}`);
}

describe("the statement check, on an open connection", () => {
  it.each([
    ["COPY", "COPY t TO '/tmp/officehum-data-copy.csv'"],
    ["COPY from a query", "COPY (SELECT * FROM t) TO '/tmp/officehum-data-copy.csv'"],
    ["ATTACH", "ATTACH '/tmp/officehum-data.db' AS other"],
    ["INSTALL", "INSTALL httpfs"],
    ["LOAD", "LOAD httpfs"],
    ["PRAGMA", "PRAGMA version"],
    ["SET", "SET enable_external_access = true"],
    ["RESET", "RESET memory_limit"],
    ["CREATE", "CREATE TABLE u AS SELECT 1"],
    ["DELETE", "DELETE FROM t"],
    ["EXPLAIN", "EXPLAIN SELECT 1"],
    ["CALL", "CALL pragma_version()"],
    ["EXPORT DATABASE", "EXPORT DATABASE '/tmp/officehum-data-export'"],
  ])("refuses %s", async (_name, sql) => {
    expect((await refusal(sql)).code).toBe("not-select");
  });

  it("refuses more than one statement, even when each is a SELECT", async () => {
    expect((await refusal("SELECT 1; SELECT 2")).message).toContain("exactly one");
    expect((await refusal("SELECT 1; COPY t TO '/tmp/x.csv'")).code).toBe("not-select");
  });

  it("refuses SQL that does not parse, and says so", async () => {
    const error = await refusal("SELEC 1");
    expect(error.code).toBe("invalid-sql");
    expect(error.message).toContain("syntax error");
  });

  it("is a parse, not a text match: a keyword inside a string or a comment is not a statement", async () => {
    for (const sql of [
      "SELECT 'COPY t TO x; ATTACH y' AS note",
      "-- PRAGMA version\nSELECT a FROM t /* SET x = 1 */",
      "WITH c AS (SELECT a FROM t) SELECT * FROM c",
      "SELECT 1 UNION ALL SELECT 2",
      "FROM t",
      "SELECT 1;",
    ]) {
      await expect(checkStatement(connection, sql)).resolves.toBe(sql);
    }
  });

  it("lets a SELECT that names a file reader through: that is the sandbox's layer to stop", async () => {
    await expect(
      checkStatement(connection, "SELECT * FROM read_csv('/etc/hosts')"),
    ).resolves.toBeTypeOf("string");
  });
});
