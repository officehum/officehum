/**
 * Charts from a query's result: the model writes the Vega-Lite spec, the query supplies every value.
 *
 * The spec is checked before it is compiled. It may not carry data of its own: no `values`, no `url`
 * (or any other link), no `datasets`, and its only data source is the query's result, named `result`.
 * Its marks are bar, line, area, arc (a pie) and text (a table of values). Vega then renders it with a
 * loader that refuses every load, so even a spec that slipped past the check could not fetch anything,
 * to SVG, and resvg turns the SVG into a PNG. Labels use the system's sans-serif fonts; no font is
 * fetched.
 */

import type { Json } from "@duckdb/node-api";
import { Resvg } from "@resvg/resvg-js";
import { type Loader, logger, None, parse, View, loader as vegaLoader } from "vega";
import { compile, type TopLevelSpec } from "vega-lite";
import { DataError } from "./errors.js";
import { isNumericType } from "./format.js";
import type { QueryResult } from "./sandbox.js";

/** The marks a chart may use: bar, line, area, arc for a pie, text for a table of values. */
export const CHART_MARKS = ["bar", "line", "area", "arc", "text"] as const;

/** The most rows a chart may draw; aggregate in the query before charting more. */
export const MAX_CHART_ROWS = 5_000;

/** The name the query's result has inside the spec. */
export const RESULT_DATA = "result";

export const MAX_PREVIEW_BYTES = 100_000;

const LINK = /^\s*(?:[a-z][a-z0-9+.-]*:\/\/|data:|\/\/)/iu;
const COMPOSITION = ["layer", "hconcat", "vconcat", "concat", "facet", "repeat"];

/**
 * The spec, checked: an object whose only data is the query result, with no inline values and no
 * link anywhere, and only the allowed marks. Every problem is reported, each with its path.
 */
export function checkChartSpec(spec: unknown): Record<string, unknown> {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    throw new DataError("invalid-spec", "spec must be a Vega-Lite spec object");
  }
  const problems: string[] = [];
  const marks: string[] = [];
  const walk = (value: unknown, path: string) => {
    if (typeof value === "string") {
      if (LINK.test(value)) problems.push(`${path} is a link; a chart may not link to anything`);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    if (Array.isArray(value)) {
      for (const [index, entry] of value.entries()) walk(entry, `${path}[${index}]`);
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      const at = path === "" ? key : `${path}.${key}`;
      if (key === "values") {
        problems.push(`${at}: a chart may not carry values; select them in the query`);
      } else if (key === "url" || key === "href") {
        problems.push(`${at}: a chart may not load or link to a URL`);
      } else if (key === "datasets") {
        problems.push(`${at}: a chart may not carry datasets; its data is the query result`);
      } else if (key === "data") {
        const name = (entry as { name?: unknown } | null)?.name;
        if (
          typeof entry !== "object" ||
          entry === null ||
          Object.keys(entry).length !== 1 ||
          name !== RESULT_DATA
        ) {
          problems.push(`${at} must be {"name": "${RESULT_DATA}"} or left out`);
        }
      } else if (key === "mark") {
        const type = typeof entry === "string" ? entry : (entry as { type?: unknown })?.type;
        marks.push(String(type));
        if (!(CHART_MARKS as readonly string[]).includes(String(type))) {
          problems.push(
            `${at} is ${JSON.stringify(type)}; a chart's marks are ${CHART_MARKS.join(", ")}`,
          );
        }
      }
      if (key === "$schema") continue;
      walk(entry, at);
    }
  };
  walk(spec, "");
  if (marks.length === 0)
    problems.push(`the spec has no mark; use one of ${CHART_MARKS.join(", ")}`);
  if (problems.length > 0) {
    throw new DataError("invalid-spec", `the chart spec was refused:\n- ${problems.join("\n- ")}`);
  }
  const { $schema: _schema, ...rest } = spec as Record<string, unknown>;
  const composed = COMPOSITION.some((key) => key in rest);
  return {
    ...(composed ? {} : { width: 640, height: 360 }),
    ...rest,
    data: { name: RESULT_DATA },
  };
}

/**
 * The result as the rows a chart draws: column names as fields, and exact numbers (decimals and big
 * integers, which DuckDB gives as text) as numbers, since a chart places them in pixels.
 */
export function chartRows(result: QueryResult): Record<string, Json>[] {
  const numeric = result.columns.map((column) => isNumericType(column.type));
  return result.rows.map((row) =>
    Object.fromEntries(
      result.columns.map((column, index) => {
        const value = row[index] ?? null;
        return [column.name, numeric[index] && typeof value === "string" ? Number(value) : value];
      }),
    ),
  );
}

/** A loader that loads nothing: a chart never reads a file or the network. */
function closedLoader(): Loader {
  const closed = vegaLoader();
  const refuse = async (uri: string) => {
    throw new DataError("invalid-spec", `a chart may not load ${uri}`);
  };
  closed.load = refuse;
  closed.sanitize = refuse;
  closed.http = refuse;
  closed.file = refuse;
  return closed;
}

export interface RenderedChart {
  readonly svg: string;
  readonly png: Uint8Array;
  /** A smaller PNG for the model to look at, at most 100 KB, or `undefined` when none fits. */
  readonly preview: Uint8Array | undefined;
}

/** Draws `rows` with a spec `checkChartSpec` accepted: SVG, a PNG at twice the size, a preview. */
export async function renderChart(
  rows: readonly Record<string, Json>[],
  spec: Record<string, unknown>,
): Promise<RenderedChart> {
  if (rows.length > MAX_CHART_ROWS) {
    throw new DataError(
      "too-many-rows",
      `the query gave ${rows.length} rows; a chart draws at most ${MAX_CHART_ROWS}. Aggregate in the query first.`,
    );
  }
  let svg: string;
  try {
    const silent = logger(None);
    const compiled = compile(spec as unknown as TopLevelSpec, { logger: silent }).spec;
    const view = new View(parse(compiled), {
      renderer: "none",
      loader: closedLoader(),
      logger: silent,
    });
    view.data(
      RESULT_DATA,
      rows.map((row) => ({ ...row })),
    );
    svg = await view.toSVG();
    view.finalize();
  } catch (error) {
    if (error instanceof DataError) throw error;
    throw new DataError(
      "render-failed",
      `the chart could not be drawn: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const png = rasterise(svg, 2);
  let preview: Uint8Array | undefined;
  for (const zoom of [1, 0.75, 0.5]) {
    const candidate = rasterise(svg, zoom);
    if (candidate.byteLength <= MAX_PREVIEW_BYTES) {
      preview = candidate;
      break;
    }
  }
  return { svg, png, preview };
}

function rasterise(svg: string, zoom: number): Uint8Array {
  const image = new Resvg(svg, {
    fitTo: { mode: "zoom", value: zoom },
    background: "white",
    font: { loadSystemFonts: true },
  });
  return new Uint8Array(image.render().asPng());
}
