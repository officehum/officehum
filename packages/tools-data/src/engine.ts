/**
 * The data pack's engine: what each tool does once it runs. `./pack.ts` imports it the first time a
 * tool runs, so DuckDB, Vega and resvg load then and never just because the tools were defined.
 *
 * Every figure is DuckDB's. A model writes SQL and a chart spec, never a value: the statement check
 * and the sandbox keep a query to one read of the loaded tables, and a chart spec that carries data of
 * its own is refused. Values from files are data, not instructions, and reach the model framed as
 * such.
 */

import { createHash } from "node:crypto";
import { version as duckdbVersion } from "@duckdb/node-api";
import {
  canonicalJson,
  type FileMetadata,
  FileStoreError,
  fileResult,
  frameOutsideOutput,
  type VersionedFileRef,
} from "@officehum/sdk";
import {
  DocumentError,
  type LeaseLookup,
  MAX_XLSX_RANGE_CELLS,
  xlsxProgram,
} from "@officehum/tools-paper-office";
import { chartRows, checkChartSpec, renderChart } from "./chart.js";
import {
  CHART_RENDER,
  DATA_EXPORT,
  DATA_INSPECT,
  DATA_QUERY,
  MAX_INLINE_ROWS,
} from "./definitions.js";
import { DataError } from "./errors.js";
import { cellText, columnList, isNumericType, resultCsv, resultMarkdown } from "./format.js";
import { type StagedSources, stageTables, tableRequests } from "./load.js";
import type { DataPackOptions } from "./pack.js";
import {
  type DataLimits,
  dataLimits,
  type QueryResult,
  type Sandbox,
  withSandbox,
} from "./sandbox.js";
import { checkStatement } from "./statement.js";

const SAMPLE_ROWS = 10;
/** Recorded with every file the pack saves, so a reader knows which rules produced it. */
export const DATA_POLICY_VERSION = "officehum-data/1";

type ToolDetails = {
  files?: string[];
  rows?: number;
  columns?: string[];
  code?: string;
};

export type ToolResult = {
  readonly output: (
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "image"; readonly data: string; readonly mimeType: string }
  )[];
  readonly isError?: boolean;
  readonly details: ToolDetails;
};

/** The call a tool runs for: whose task it is, and the operation ID a saved file is kept under. */
export interface CallContext {
  readonly lookup: LeaseLookup;
  readonly operationId: string;
}

type Run = (
  options: DataPackOptions,
  limits: DataLimits,
  args: Record<string, unknown>,
  call: CallContext,
) => Promise<ToolResult>;

/** Runs one of the pack's tools. A refusal is thrown as a `DataError`, which the pack reports. */
export async function runDataTool(
  name: string,
  options: DataPackOptions,
  args: Record<string, unknown>,
  call: CallContext,
): Promise<ToolResult> {
  const run = RUNS[name];
  if (run === undefined) throw new DataError("invalid-request", `the data pack has no ${name}`);
  return await run(options, dataLimits(options.limits), args, call);
}

const RUNS: Readonly<Record<string, Run>> = {
  [DATA_INSPECT]: async (options, limits, args, call) => {
    const tables = tableRequests([
      {
        name: "data",
        file_id: args.file_id,
        ...(args.sheet === undefined ? {} : { sheet: args.sheet }),
      },
    ]);
    const loaded = await stage(options, limits, call, tables);
    const source = loaded.sources[0];
    const text = await withSandbox(loaded.tables, limits, (sandbox) => inspect(sandbox));
    const header = `${source?.name ?? "the file"} (file ${source?.fileId ?? ""})`;
    return framed(DATA_INSPECT, loaded, `${header}\n\n${text.body}`, {
      rows: text.rows,
      columns: text.columns,
    });
  },
  [DATA_QUERY]: async (options, limits, args, call) => {
    const loaded = await stage(options, limits, call, tableRequests(args.tables));
    const result = await withSandbox(loaded.tables, limits, (sandbox) => query(sandbox, args.sql));
    const columns = result.columns.map((column) => column.name);
    const count = result.rows.length;
    if (count <= MAX_INLINE_ROWS) {
      const body = [
        `${count} row${count === 1 ? "" : "s"}. Columns: ${columnList(result)}`,
        "",
        resultMarkdown(result),
      ].join("\n");
      return framed(DATA_QUERY, loaded, body, { rows: count, columns });
    }
    const ref = await save(options, call, loaded, {
      bytes: resultCsv(result),
      name: "query-result.csv",
      mimeType: "text/csv",
      args,
    });
    const body = [
      `${count} rows, more than ${MAX_INLINE_ROWS}, so they were saved as ${ref.name} (file ${ref.id}).`,
      `Columns: ${columnList(result)}`,
      "Ask a narrower question (aggregate, filter or LIMIT) to see rows here.",
    ].join("\n");
    return framed(DATA_QUERY, loaded, body, { rows: count, columns, files: [ref.id] });
  },
  [DATA_EXPORT]: async (options, limits, args, call) => {
    const format = args.format;
    if (format !== "csv" && format !== "xlsx") {
      throw new DataError("invalid-request", "format must be csv or xlsx");
    }
    const name = fileName(args.name, format);
    const loaded = await stage(options, limits, call, tableRequests(args.tables));
    const result = await withSandbox(loaded.tables, limits, (sandbox) => query(sandbox, args.sql));
    const ref =
      format === "csv"
        ? await save(options, call, loaded, {
            bytes: resultCsv(result),
            name,
            mimeType: "text/csv",
            args,
          })
        : await exportWorkbook(options, call, result, name);
    const summary = {
      ok: true,
      format,
      rows: result.rows.length,
      columns: result.columns.map((column) => column.name),
      versionId: ref.versionId,
      published: false,
    };
    const files = fileResult([ref], { tool: DATA_EXPORT });
    return {
      output: [...files.output, { type: "text", text: JSON.stringify(summary) }],
      details: { files: files.details.files, rows: summary.rows, columns: summary.columns },
    } as ToolResult;
  },
  [CHART_RENDER]: async (options, limits, args, call) => {
    // The spec is checked before any file is read: a refused spec costs nothing.
    const spec = checkChartSpec(args.spec);
    const name = fileName(args.name ?? "chart.png", "png");
    const loaded = await stage(options, limits, call, tableRequests(args.tables));
    const result = await withSandbox(loaded.tables, limits, (sandbox) => query(sandbox, args.sql));
    const chart = await renderChart(chartRows(result), spec);
    const ref = await save(options, call, loaded, {
      bytes: chart.png,
      name,
      mimeType: "image/png",
      args,
    });
    const files = fileResult([ref], {
      tool: CHART_RENDER,
      ...(chart.preview === undefined
        ? {}
        : { preview: { bytes: chart.preview, mimeType: "image/png" } }),
    });
    const summary = {
      ok: true,
      rows: result.rows.length,
      columns: result.columns.map((column) => column.name),
      ...(chart.preview === undefined
        ? { preview: "no preview: the chart does not fit in 100 KB; open the file" }
        : {}),
    };
    return {
      output: [...files.output, { type: "text", text: JSON.stringify(summary) }],
      details: { files: files.details.files, rows: summary.rows, columns: summary.columns },
    } as ToolResult;
  },
};

async function stage(
  options: DataPackOptions,
  limits: DataLimits,
  call: CallContext,
  requests: ReturnType<typeof tableRequests>,
): Promise<StagedSources> {
  return stageTables(requests, {
    files: await options.filesFor(call.lookup),
    lease: await options.leaseFor?.(call.lookup),
    service: options.service,
    taskId: call.lookup.taskId,
    operationId: call.operationId,
    limits,
  });
}

async function query(sandbox: Sandbox, sql: unknown): Promise<QueryResult> {
  return sandbox.run(await checkStatement(sandbox.connection, sql));
}

/** An identifier for SQL the pack writes itself: double-quoted, inner quotes doubled. */
const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;

async function inspect(
  sandbox: Sandbox,
): Promise<{ body: string; rows: number; columns: string[] }> {
  const described = await sandbox.run("SELECT column_name, column_type FROM (DESCRIBE data)");
  const columns = described.rows.map((row) => ({ name: String(row[0]), type: String(row[1]) }));
  const missing =
    columns.length === 0
      ? []
      : ((
          await sandbox.run(
            `SELECT ${columns.map((column) => `count(*) - count(${ident(column.name)})`).join(", ")} FROM data`,
          )
        ).rows[0] ?? []);
  const count = (await sandbox.run("SELECT count(*) FROM data")).rows[0]?.[0] ?? 0;
  const sample = await sandbox.run(`SELECT * FROM data LIMIT ${SAMPLE_ROWS}`);
  const rows = Number(count);
  const table = [
    "| column | type | missing |",
    "| --- | --- | --- |",
    ...columns.map(
      (column, index) =>
        `| ${column.name.replaceAll("|", "\\|")} | ${column.type} | ${cellText(missing[index] ?? 0)} |`,
    ),
  ].join("\n");
  const body = [
    `${cellText(count)} rows, ${columns.length} columns.`,
    "",
    table,
    "",
    `First ${Math.min(SAMPLE_ROWS, sample.rows.length)} rows:`,
    "",
    resultMarkdown(sample),
  ].join("\n");
  return { body, rows, columns: columns.map((column) => column.name) };
}

function framed(
  name: string,
  loaded: Pick<StagedSources, "external">,
  body: string,
  details: ToolDetails,
): ToolResult {
  const origin = loaded.external
    ? "data from outside the office (an email, an upload or another outside source)"
    : "data in the office's files";
  const [block] = frameOutsideOutput({ tool: name, origin, tag: "data" }, [
    { type: "text", text: body },
  ]);
  return {
    output: [{ type: "text", text: block?.type === "text" ? block.text : body }],
    details,
  };
}

/** A file name with the format's extension, added when it is missing. */
function fileName(value: unknown, extension: string): string {
  if (typeof value !== "string" || value.trim() === "" || /[/\\]/u.test(value)) {
    throw new DataError("invalid-request", "name must be a file name, with no folder");
  }
  const trimmed = value.trim();
  return trimmed.toLowerCase().endsWith(`.${extension}`) ? trimmed : `${trimmed}.${extension}`;
}

const LIBRARIES = { duckdb: duckdbVersion(), vega: "6.4.0", "vega-lite": "6.5.0", resvg: "2.6.2" };

/**
 * Saves the call's one file under its operation ID. A replay finds the file the first run saved and
 * returns it, so the same call never saves twice, even if the bytes would differ.
 */
async function save(
  options: DataPackOptions,
  call: CallContext,
  loaded: StagedSources,
  file: { bytes: Uint8Array; name: string; mimeType: string; args: Record<string, unknown> },
): Promise<VersionedFileRef> {
  const files = await options.filesFor(call.lookup);
  if (files === undefined) {
    throw new DataError("no-files", "this task has no file access, so the result cannot be saved");
  }
  try {
    const prior = await files.lookupOperation(call.operationId);
    if (prior !== undefined) {
      if (prior.kind !== "create") {
        throw new DataError(
          "store-error",
          `operation ${call.operationId} is already used for something other than a new file`,
        );
      }
      return prior.output;
    }
    const metadata: FileMetadata = {
      createdBy: options.createdBy,
      source: "derived",
      derivedFrom: [...new Set(loaded.sources.map((source) => source.fileId))],
      ...(loaded.external ? { provenance: "external" as const } : {}),
    };
    const receipt = await files.create({
      operationId: call.operationId,
      bytes: file.bytes,
      name: file.name,
      mimeType: file.mimeType,
      metadata,
      context: {
        taskId: call.lookup.taskId,
        policyVersion: DATA_POLICY_VERSION,
        worker: { image: `duckdb:${LIBRARIES.duckdb}`, libraries: LIBRARIES },
        argumentsSha256: createHash("sha256").update(canonicalJson(file.args)).digest("hex"),
      },
    });
    return receipt.output;
  } catch (error) {
    if (error instanceof DataError) throw error;
    const message =
      error instanceof FileStoreError || error instanceof Error ? error.message : String(error);
    throw new DataError("store-error", `the file store refused ${file.name}: ${message}`);
  }
}

/**
 * A workbook value. A numeric column's exact text (a decimal or a big integer) becomes a number only
 * when the number reads back as the same value, so `12.340000` is 12.34 and a 20-digit integer stays
 * text; a text column stays text, so `00123` keeps its zeros.
 */
function workbookValue(
  value: QueryResult["rows"][number][number],
  numeric: boolean,
): string | number | boolean | null {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "object") return JSON.stringify(value);
  if (!numeric || !/^-?\d+(\.\d+)?$/u.test(value)) return value;
  const normal = value
    .replace(/(\.\d*?)0+$/u, "$1")
    .replace(/\.$/u, "")
    .replace(/^(-?)0+(?=\d)/u, "$1");
  const number = Number(value);
  return String(number) === normal ? number : value;
}

/** An `.xlsx` draft through the Paper worker's create program, with the task's lease. */
async function exportWorkbook(
  options: DataPackOptions,
  call: CallContext,
  result: QueryResult,
  name: string,
): Promise<VersionedFileRef> {
  if (options.service === undefined) {
    throw new DataError(
      "no-service",
      "an .xlsx export is written by the Paper document worker, which the host has not connected. Export as csv instead.",
    );
  }
  const lease = await options.leaseFor?.(call.lookup);
  if (lease === undefined) {
    throw new DataError(
      "no-lease",
      "this task has no document lease, so it may not write an .xlsx file. Export as csv, or ask the host for a lease.",
    );
  }
  const cells = (result.rows.length + 1) * Math.max(1, result.columns.length);
  if (cells > MAX_XLSX_RANGE_CELLS) {
    throw new DataError(
      "too-many-rows",
      `the export is ${cells} cells; an .xlsx export holds at most ${MAX_XLSX_RANGE_CELLS}. Export as csv, or aggregate first.`,
    );
  }
  const numeric = result.columns.map((column) => isNumericType(column.type));
  const rows = [
    result.columns.map((column) => column.name),
    ...result.rows.map((row) =>
      row.map((value, index) => workbookValue(value, numeric[index] ?? false)),
    ),
  ];
  let program: ReturnType<typeof xlsxProgram>;
  try {
    program = xlsxProgram("create", { output: name, sheets: [{ name: "Data", rows }] }, lease);
  } catch (error) {
    if (error instanceof DocumentError) throw new DataError(error.code, error.message);
    throw error;
  }
  const outcome = await options.service.runDocumentPython({
    operationId: call.operationId,
    taskId: call.lookup.taskId,
    lease,
    code: program.code,
    arguments: program.arguments,
  });
  if (outcome.kind === "refused") throw new DataError(outcome.code, outcome.message);
  const [output, ...extra] = outcome.receipt.outputs;
  if (output === undefined || extra.length > 0 || output.name !== name) {
    throw new DataError(
      "store-error",
      `the worker did not commit exactly one workbook named ${name}`,
    );
  }
  const files = await options.filesFor(call.lookup);
  const stored = await files?.info(output.fileId).catch(() => undefined);
  if (stored === undefined) {
    throw new DataError("store-error", `the workbook ${name} was committed but cannot be found`);
  }
  return stored;
}
