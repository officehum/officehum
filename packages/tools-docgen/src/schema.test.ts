import { describe, expect, it } from "vitest";
import { dataProblems, sampleData } from "./schema.js";

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["customer", "lines", "total"],
  properties: {
    customer: { type: "string", minLength: 1 },
    lines: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["amount"],
        properties: { amount: { type: "number" }, note: { type: "string" } },
      },
    },
    total: { type: "number" },
    kind: { enum: ["invoice", "credit"] },
  },
};

describe("dataProblems", () => {
  it("accepts data that matches", () => {
    expect(dataProblems(schema, { customer: "Lee", lines: [{ amount: 1 }], total: 1 })).toEqual([]);
  });

  it("names every field that does not match, each with its path", () => {
    expect(
      dataProblems(schema, {
        customer: "",
        lines: [{ amount: "12.50" }, {}],
        kind: "refund",
        extra: true,
      }),
    ).toEqual([
      { path: "data", message: "is missing total" },
      { path: "data.customer", message: "must not have fewer than 1 characters" },
      { path: "data.extra", message: "is not a field this template takes" },
      { path: "data.kind", message: "must be one of invoice, credit" },
      { path: "data.lines[0].amount", message: "must be number" },
      { path: "data.lines[1]", message: "is missing amount" },
    ]);
  });

  it("refuses data that is not an object at all", () => {
    expect(dataProblems(schema, [1, 2])).toEqual([{ path: "data", message: "must be object" }]);
  });
});

describe("sampleData", () => {
  it("uses the schema's first example when it has one", () => {
    expect(sampleData({ ...schema, examples: [{ customer: "Example" }] })).toEqual({
      customer: "Example",
    });
  });

  it("otherwise builds data that matches the schema", () => {
    const sample = sampleData(schema);
    expect(dataProblems(schema, sample)).toEqual([]);
    expect(sample).toEqual({ customer: "Sample", lines: [{ amount: 1 }], total: 1 });
  });

  it("honours defaults, constants, enums, formats and bounds", () => {
    const rich = {
      type: "object",
      required: ["a", "b", "c", "d", "e", "f", "g"],
      properties: {
        a: { type: "string", default: "given" },
        b: { const: 7 },
        c: { enum: ["x", "y"] },
        d: { type: "string", format: "date" },
        e: { type: "integer", minimum: 5 },
        f: { type: "array", minItems: 2, items: { type: "boolean" } },
        g: { type: "string", minLength: 10 },
      },
    };
    const sample = sampleData(rich);
    expect(sample).toEqual({
      a: "given",
      b: 7,
      c: "x",
      d: "2026-01-31",
      e: 5,
      f: [true, true],
      g: "SampleSample",
    });
    expect(dataProblems(rich, sample)).toEqual([]);
  });
});
