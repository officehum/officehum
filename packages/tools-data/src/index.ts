/**
 * @officehum/tools-data — the portable data and spreadsheets pack.
 *
 * Agents answer questions over spreadsheets and exports ("which customers bought less this quarter",
 * "reconcile this bank CSV against open invoices") with exact results computed by DuckDB, export them
 * as CSV or Excel, and chart them with Vega-Lite. The model writes SQL and a chart spec, never a
 * figure. Each call runs in its own in-memory database that can read only the files it loaded.
 *
 * It depends on Pi Durable and pi-ai (peers), the SDK, the reading pack (for its Excel reader) and
 * `@officehum/tools-paper-office`, never on a host, so the same pack runs in a bare Pi
 * Durable harness. See README.md.
 *
 * This entry loads the whole pack, DuckDB included. A host that only builds the pack imports
 * `@officehum/tools-data/pack`, which defines the tools and loads the engine at their first call.
 */

export {
  CHART_MARKS,
  chartRows,
  checkChartSpec,
  MAX_CHART_ROWS,
  MAX_PREVIEW_BYTES,
  RESULT_DATA,
  type RenderedChart,
  renderChart,
} from "./chart.js";
export {
  CHART_RENDER,
  DATA_EXPORT,
  DATA_INSPECT,
  DATA_PACK_ID,
  DATA_QUERY,
  DATA_TOOLS,
  type DataToolDefinition,
  MAX_INLINE_ROWS,
} from "./definitions.js";
export { DATA_POLICY_VERSION } from "./engine.js";
export { DATA_ERROR_CODES, DataError, type DataErrorCode } from "./errors.js";
export { cellText, isNumericType, resultCsv, resultMarkdown } from "./format.js";
export {
  type DataFileKind,
  type DataFiles,
  dataFileKind,
  MAX_TABLES,
  sheetCsv,
  type TableRequest,
} from "./load.js";
export { type DataPack, type DataPackOptions, dataPack } from "./pack.js";
export {
  type DataLimits,
  DEFAULT_DATA_LIMITS,
  dataLimits,
  type QueryColumn,
  type QueryResult,
  type Sandbox,
  type StagedFormat,
  type StagedTable,
  withSandbox,
} from "./sandbox.js";
export { checkStatement, MAX_SQL_CHARS } from "./statement.js";
