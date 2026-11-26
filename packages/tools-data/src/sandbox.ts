/**
 * One in-memory DuckDB per tool call, shut off from everything but the files the call staged.
 *
 * DuckDB's readers take a path, so the call's files are written to a private temporary folder first.
 * Before anything loads, the database may read only that folder (`allowed_directories` with
 * `enable_external_access = false`), loads no extension it does not already carry, runs on one thread
 * (so a replay sees rows in the same order), stays within the memory limit and spills nothing to disk.
 * After loading, the folder is deleted and the configuration is locked, so a query can neither read
 * another file or the network nor change those settings back. The time limit interrupts the
 * connection.
 *
 * This is the second layer: the statement check (`statement.ts`) refuses anything but one SELECT
 * before it reaches `run`. Either layer alone keeps a query from reading `/etc/passwd`.
 *
 * This is the only module in the pack that writes a file.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DuckDBConnection, DuckDBInstance, type Json } from "@duckdb/node-api";
import { DataError } from "./errors.js";

export interface DataLimits {
  /** How long one tool call may spend loading and querying. Default 20 s. */
  readonly timeoutMs: number;
  /** The most memory DuckDB may use for one call. Default 512 MB. */
  readonly memoryMb: number;
  /** The largest file a call may load. Default 50 MB. */
  readonly maxFileBytes: number;
  /** The most rows a result may have, inline or saved. Default 100,000. */
  readonly maxResultRows: number;
}

export const DEFAULT_DATA_LIMITS: DataLimits = {
  timeoutMs: 20_000,
  memoryMb: 512,
  maxFileBytes: 50 * 1024 * 1024,
  maxResultRows: 100_000,
};

/** The host's limits, never above the defaults. */
export function dataLimits(given: Partial<DataLimits> = {}): DataLimits {
  const lower = (key: keyof DataLimits) =>
    Math.min(given[key] ?? Infinity, DEFAULT_DATA_LIMITS[key]);
  return {
    timeoutMs: lower("timeoutMs"),
    memoryMb: lower("memoryMb"),
    maxFileBytes: lower("maxFileBytes"),
    maxResultRows: lower("maxResultRows"),
  };
}

/** How a staged file is read: DuckDB's own CSV, Parquet or JSON reader. */
export type StagedFormat = "csv" | "parquet" | "json";

export interface StagedTable {
  /** The table's name in SQL; an identifier `tableName` accepted. */
  readonly name: string;
  readonly format: StagedFormat;
  readonly bytes: Uint8Array;
}

export interface QueryColumn {
  readonly name: string;
  /** DuckDB's type, e.g. `DECIMAL(38,6)`, `BIGINT`, `VARCHAR`, `DATE`. */
  readonly type: string;
}

export interface QueryResult {
  readonly columns: readonly QueryColumn[];
  /**
   * The rows as DuckDB gives them as JSON: big integers, decimals, dates and times as exact text,
   * doubles as numbers, nested values as JSON.
   */
  readonly rows: readonly (readonly Json[])[];
}

export interface Sandbox {
  /**
   * Runs one statement with no check of its own: callers pass it through `checkStatement` first.
   * Refused with `too-many-rows` when the result has more than `maxResultRows` rows.
   */
  run(sql: string): Promise<QueryResult>;
  /** The connection, for the statement check. */
  readonly connection: DuckDBConnection;
}

const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u;

/** A table name a query may use: letters, digits and underscores, not starting with a digit. */
export function tableName(value: unknown, what: string): string {
  if (typeof value !== "string" || !TABLE_NAME.test(value)) {
    throw new DataError(
      "invalid-request",
      `${what} must be a table name of letters, digits and underscores that starts with a letter (at most 63 characters)`,
    );
  }
  return value;
}

/** Types DuckDB's sniffer may give a CSV column. Exact decimals come before doubles. */
const CSV_TYPES = "['BOOLEAN','BIGINT','DECIMAL(38,6)','DOUBLE','DATE','TIMESTAMP','VARCHAR']";

const quoted = (text: string) => `'${text.replaceAll("'", "''")}'`;

function reader(format: StagedFormat, path: string): string {
  switch (format) {
    case "csv":
      return `read_csv(${quoted(path)}, header = true, sample_size = -1, auto_type_candidates = ${CSV_TYPES})`;
    case "parquet":
      return `read_parquet(${quoted(path)})`;
    default:
      return `read_json(${quoted(path)}, sample_size = -1)`;
  }
}

/**
 * Opens a sandbox with `tables` loaded, runs `work` in it, and closes it. The time limit covers the
 * loading and the work; past it, a running statement is interrupted and the call is refused.
 */
export async function withSandbox<T>(
  tables: readonly StagedTable[],
  limits: DataLimits,
  work: (sandbox: Sandbox) => Promise<T>,
): Promise<T> {
  const folder = await mkdtemp(join(tmpdir(), "officehum-data-"));
  const instance = await DuckDBInstance.create(":memory:", {
    threads: "1",
    memory_limit: `${limits.memoryMb}MB`,
    autoinstall_known_extensions: "false",
    autoload_known_extensions: "false",
  });
  const connection = await instance.connect();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    connection.interrupt();
  }, limits.timeoutMs);

  const execute = async (sql: string, maxRows: number): Promise<QueryResult> => {
    if (timedOut) throw timeout(limits);
    try {
      const result = await connection.runAndReadUntil(sql, maxRows + 1);
      if (result.currentRowCount > maxRows) {
        throw new DataError(
          "too-many-rows",
          `the result has more than ${maxRows.toLocaleString("en-US")} rows, the limit per call. Aggregate it, filter it or add a LIMIT.`,
        );
      }
      const names = result.columnNames();
      const types = result.columnTypes();
      return {
        columns: names.map((name, index) => ({ name, type: String(types[index]) })),
        rows: result.getRowsJson(),
      };
    } catch (error) {
      throw translate(error, timedOut, limits);
    }
  };

  try {
    const setup = [
      "SET temp_directory = ''",
      `SET allowed_directories = [${quoted(`${folder}/`)}]`,
      "SET enable_external_access = false",
    ];
    for (const statement of setup) await connection.run(statement);
    for (const [index, table] of tables.entries()) {
      const path = join(folder, `${index}.${table.format}`);
      await writeFile(path, table.bytes);
      try {
        await execute(
          `CREATE TABLE "${table.name}" AS SELECT * FROM ${reader(table.format, path)}`,
          1,
        );
      } catch (error) {
        if (error instanceof DataError && error.code === "query-failed") {
          throw new DataError(
            "unsupported-format",
            `table ${table.name} could not be loaded as ${table.format}: ${error.message.replace(/^DuckDB refused the query: /u, "")}`,
          );
        }
        throw error;
      }
    }
    await rm(folder, { recursive: true, force: true });
    await connection.run("SET lock_configuration = true");
    return await work({ run: (sql) => execute(sql, limits.maxResultRows), connection });
  } finally {
    clearTimeout(timer);
    connection.closeSync();
    instance.closeSync();
    await rm(folder, { recursive: true, force: true });
  }
}

function timeout(limits: DataLimits): DataError {
  return new DataError(
    "timeout",
    `the call took longer than ${limits.timeoutMs / 1000} s, the limit per call. Narrow the query, or load fewer or smaller files.`,
  );
}

/** DuckDB's error as this pack's: the limits by name, anything else as the query's own failure. */
function translate(error: unknown, timedOut: boolean, limits: DataLimits): DataError {
  if (error instanceof DataError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (timedOut || /^INTERRUPT Error/u.test(message)) return timeout(limits);
  if (/^Out of Memory Error/u.test(message)) {
    return new DataError(
      "memory-limit",
      `the query needed more than ${limits.memoryMb} MB, the memory limit per call. Aggregate earlier, select fewer columns or filter the rows first.`,
    );
  }
  const first = message.split("\n")[0] ?? message;
  return new DataError("query-failed", `DuckDB refused the query: ${first}`);
}
