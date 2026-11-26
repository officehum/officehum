/** Chart specs: what is refused, and that a drawn chart's data is the query's and nothing else. */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { chartRows, checkChartSpec, MAX_PREVIEW_BYTES, renderChart } from "./chart.js";
import { DataError } from "./errors.js";
import type { QueryResult } from "./sandbox.js";

const BAR = {
  $schema: "https://vega.github.io/schema/vega-lite/v6.json",
  mark: "bar",
  encoding: {
    x: { field: "region", type: "nominal" },
    y: { field: "total", type: "quantitative" },
  },
};

const RESULT: QueryResult = {
  columns: [
    { name: "region", type: "VARCHAR" },
    { name: "total", type: "DECIMAL(38,6)" },
  ],
  rows: [
    ["East", "1250.500000"],
    ["North", "980.250000"],
    ["South", "1730.000000"],
  ],
};

function refused(spec: unknown): string {
  try {
    checkChartSpec(spec);
  } catch (error) {
    if (error instanceof DataError && error.code === "invalid-spec") return error.message;
    throw error;
  }
  throw new Error("the spec was accepted");
}

describe("checkChartSpec", () => {
  it("accepts a spec without data and points it at the query result", () => {
    const spec = checkChartSpec(BAR);
    expect(spec.data).toEqual({ name: "result" });
    expect(spec).not.toHaveProperty("$schema");
    expect(checkChartSpec({ ...BAR, data: { name: "result" } }).mark).toBe("bar");
  });

  it("refuses inline values, URLs and datasets, wherever they are, and names each", () => {
    const message = refused({
      ...BAR,
      data: { values: [{ region: "East", total: 1 }] },
      datasets: { made_up: [{ total: 9 }] },
      layer: [{ mark: "line", data: { url: "https://example.com/sales.csv" } }],
      transform: [{ lookup: "region", from: { data: { url: "file:///etc/passwd" }, key: "r" } }],
      title: "https://example.com/tracker.png",
    });
    expect(message).toContain("data must be");
    expect(message).toContain("data.values: a chart may not carry values");
    expect(message).toContain("datasets: a chart may not carry datasets");
    expect(message).toContain("layer[0].data.url: a chart may not load or link to a URL");
    expect(message).toContain("transform[0].from.data.url");
    expect(message).toContain("title is a link");
  });

  it("refuses values even outside a data block, and marks it does not draw", () => {
    expect(
      refused({
        ...BAR,
        encoding: {
          ...BAR.encoding,
          x: { field: "region", type: "nominal", axis: { values: ["East"] } },
        },
      }),
    ).toContain("encoding.x.axis.values");
    expect(refused({ mark: { type: "image", url: "x.png" } })).toContain('mark is "image"');
    expect(refused({ encoding: {} })).toContain("the spec has no mark");
    expect(refused([BAR])).toContain("spec object");
  });

  it("accepts the five kinds of chart", () => {
    for (const mark of ["bar", "line", "area", "arc", "text"]) {
      expect(checkChartSpec({ mark, encoding: {} }).mark).toBe(mark);
    }
  });
});

describe("renderChart", () => {
  it("draws only the query's rows: one bar each, labelled with the query's figures", async () => {
    const chart = await renderChart(chartRows(RESULT), checkChartSpec(BAR));
    const bars = [...chart.svg.matchAll(/aria-label="region: (\w+); total: ([\d.,]+)"/gu)].map(
      (match) => [match[1], match[2]],
    );
    expect(bars).toEqual([
      ["East", "1250.5"],
      ["North", "980.25"],
      ["South", "1730"],
    ]);
    expect([...chart.png.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(chart.preview?.byteLength).toBeLessThanOrEqual(MAX_PREVIEW_BYTES);
  });

  it("turns exact decimals into numbers for drawing, and leaves text alone", () => {
    expect(chartRows(RESULT)[0]).toEqual({ region: "East", total: 1250.5 });
  });

  it("never fetches, even for a spec that skipped the check", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.end("region,total\nWest,1\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const unchecked = {
        ...BAR,
        width: 200,
        height: 100,
        data: { url: `http://127.0.0.1:${port}/sales.csv` },
      };
      const outcome = await renderChart([], unchecked).then(
        (chart) => chart.svg,
        (error: unknown) => error,
      );
      expect(requests).toBe(0);
      if (typeof outcome === "string") expect(outcome).not.toContain("West");
    } finally {
      server.close();
    }
  });

  it("refuses more rows than a chart draws", async () => {
    const rows = Array.from({ length: 5_001 }, (_, index) => ({ region: `r${index}`, total: 1 }));
    await expect(renderChart(rows, checkChartSpec(BAR))).rejects.toMatchObject({
      code: "too-many-rows",
    });
  });
});
