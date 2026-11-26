/**
 * The statement check: a query is one SELECT (a `WITH` query is one too), decided by DuckDB's own
 * parser, never by matching text.
 *
 * Two parses, both DuckDB's:
 *
 * 1. `json_serialize_sql` parses the text and serialises it only when every statement is a SELECT;
 *    anything else (COPY, ATTACH, INSTALL, LOAD, PRAGMA, SET, CREATE, EXPLAIN, CALL) comes back as an
 *    error. Exactly one statement must come back.
 * 2. The node API's statement extraction must also find one statement, and preparing it must give
 *    the SELECT statement type.
 *
 * A SELECT may still name a reader such as `read_csv('/etc/passwd')`; the parser cannot know a
 * function reads a file. That is the sandbox's layer: with external access off and the configuration
 * locked, such a query fails on its own (see `sandbox.ts`).
 */

import { type DuckDBConnection, StatementType } from "@duckdb/node-api";
import { DataError } from "./errors.js";

/** The most characters of SQL one call may send. */
export const MAX_SQL_CHARS = 20_000;

interface Serialised {
  readonly error: boolean;
  readonly error_message?: string;
  readonly statements?: readonly unknown[];
}

/** Refuses `sql` unless it is exactly one SELECT statement. */
export async function checkStatement(connection: DuckDBConnection, sql: unknown): Promise<string> {
  if (typeof sql !== "string" || sql.trim() === "") {
    throw new DataError("invalid-request", "sql must be a non-empty SELECT statement");
  }
  if (sql.length > MAX_SQL_CHARS) {
    throw new DataError("invalid-request", `sql is longer than ${MAX_SQL_CHARS} characters`);
  }

  const reader = await connection.runAndReadAll("SELECT json_serialize_sql($1)", [sql]);
  const serialised = JSON.parse(String(reader.getRows()[0]?.[0])) as Serialised;
  if (serialised.error) {
    const message = serialised.error_message ?? "";
    if (/Only SELECT statements/u.test(message)) throw notSelect();
    throw new DataError("invalid-sql", `the SQL does not parse: ${message}`);
  }
  if ((serialised.statements ?? []).length !== 1) throw oneStatement();

  const extracted = await connection.extractStatements(sql);
  if (extracted.count !== 1) throw oneStatement();
  let type: StatementType;
  try {
    type = (await extracted.prepare(0)).statementType;
  } catch (error) {
    const message = error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error);
    throw new DataError("query-failed", `DuckDB refused the query: ${message}`);
  }
  if (type !== StatementType.SELECT) throw notSelect();
  return sql;
}

function notSelect(): DataError {
  return new DataError(
    "not-select",
    "only a SELECT (or WITH ... SELECT) query is allowed: no COPY, ATTACH, INSTALL, LOAD, PRAGMA, SET, CREATE or other statement",
  );
}

function oneStatement(): DataError {
  return new DataError("not-select", "send exactly one SELECT statement, not several");
}
