/**
 * Query results as text, exactly as DuckDB gave them: a decimal keeps every digit of its scale, a
 * double prints in the shortest form that reads back as the same number, and nothing is rounded here.
 * Rounding is the SQL's to ask for (`round(x, 2)`, a cast to `DECIMAL(18,2)`).
 */

import type { Json } from "@duckdb/node-api";
import { markdownTable } from "@officehum/tools-documents";
import type { QueryResult } from "./sandbox.js";

const NUMERIC =
  /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|DECIMAL)\b/u;

/** True for a DuckDB number type; DuckDB gives decimals and big integers as exact text. */
export function isNumericType(type: string): boolean {
  return NUMERIC.test(type);
}

/** One value as text: SQL NULL as `NULL`, nested values as JSON. */
export function cellText(value: Json): string {
  if (value === null) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** The result as a Markdown table, its column names as the header. */
export function resultMarkdown(result: QueryResult): string {
  return markdownTable([
    result.columns.map((column) => column.name),
    ...result.rows.map((row) => row.map(cellText)),
  ]);
}

/** One CSV field: quoted when it holds a comma, a quote or a line break (RFC 4180). */
function csvField(value: Json): string {
  if (value === null) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** The result as UTF-8 CSV with a header row; SQL NULL is an empty field. */
export function resultCsv(result: QueryResult): Uint8Array {
  const lines = [
    result.columns.map((column) => csvField(column.name)).join(","),
    ...result.rows.map((row) => row.map(csvField).join(",")),
  ];
  return new TextEncoder().encode(`${lines.join("\r\n")}\r\n`);
}

/** The column list a model reads before the rows: `name (TYPE)`. */
export function columnList(result: Pick<QueryResult, "columns">): string {
  return result.columns.map((column) => `${column.name} (${column.type})`).join(", ");
}
