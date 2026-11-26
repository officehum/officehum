import { wordProgram, xlsxProgram } from "@officehum/tools-paper-office";
import { describe, expect, it } from "vitest";
import { NEUTRAL_BRANDING } from "./branding.js";
import { formatMoney, layoutFor, textCell } from "./layouts.js";
import { sampleData } from "./schema.js";
import { builtinTemplates } from "./templates.js";
import { leaseFor } from "./test-helpers.js";

const brand = { ...NEUTRAL_BRANDING, companyName: "Acme Supplies" };
const example = (name: string) => {
  const template = builtinTemplates().find((entry) => entry.name === name);
  if (template === undefined) throw new Error(`no template ${name}`);
  return structuredClone(sampleData(template.schema)) as Record<string, unknown>;
};

describe("formatMoney", () => {
  it("prints two decimals with thousands separators, rounding half away from zero", () => {
    expect(formatMoney(1234.5)).toBe("1,234.50");
    expect(formatMoney(1077.84)).toBe("1,077.84");
    expect(formatMoney(-1250)).toBe("-1,250.00");
    expect(formatMoney(0.005)).toBe("0.01");
    expect(formatMoney(-0.005)).toBe("-0.01");
    expect(formatMoney(-0.004)).toBe("0.00");
    expect(formatMoney(1234567.891)).toBe("1,234,567.89");
  });
});

describe("textCell", () => {
  it("keeps text that starts with = as text, so data never becomes a spreadsheet formula", () => {
    expect(textCell('=WEBSERVICE("http://x")')).toBe('\'=WEBSERVICE("http://x")');
    expect(textCell("Bolts")).toBe("Bolts");
  });
});

describe("the built-in layouts", () => {
  for (const template of builtinTemplates()) {
    const layout = layoutFor(template.name);
    it(`${template.name}: its example is consistent and makes a valid Word draft`, () => {
      const data = example(template.name);
      expect(layout.checks(data)).toEqual([]);
      const blocks = layout.word(data, brand);
      expect(() =>
        wordProgram("create", { output: `${template.name}.docx`, blocks }, leaseFor()),
      ).not.toThrow();
    });
    if (template.formats.includes("xlsx")) {
      it(`${template.name}: its example makes a valid Excel draft`, () => {
        const sheets = layout.excel(example(template.name), brand);
        expect(() =>
          xlsxProgram("create", { output: `${template.name}.xlsx`, sheets }, leaseFor()),
        ).not.toThrow();
      });
    }
  }

  it("lays a statement's totals out as formulas over exactly its line rows", () => {
    const data = example("customer-statement");
    const [sheet] = layoutFor("customer-statement").excel(data, brand);
    if (sheet === undefined) throw new Error("no sheet");
    const rows = sheet.rows;
    const header = rows.findIndex((row) => row[0] === "Date" && row[3] === "Charges");
    const totals = rows.findIndex((row) => row[2] === "Totals");
    const lines = data.lines as { charges: number; payments: number; balance: number }[];
    // The opening balance sits under the header; the lines follow it, one row each.
    const first = header + 3;
    const last = first + lines.length - 1;
    expect(rows.slice(first - 1, last).map((row) => row[3])).toEqual(
      lines.map((line) => line.charges),
    );
    expect(rows[totals]?.slice(3)).toEqual([
      `=SUM(D${first}:D${last})`,
      `=SUM(E${first}:E${last})`,
      data.closingBalance,
    ]);
    expect(layoutFor("customer-statement").formulas(data)).toBe(2);
  });

  it("shows a statement's figures in Word exactly as the PDF prints them", () => {
    const data = example("customer-statement");
    const text = JSON.stringify(layoutFor("customer-statement").word(data, brand));
    for (const figure of ["1,142.04", "1,250.00", "1,077.84", "2,327.84"]) {
      expect(text).toContain(figure);
    }
  });
});

describe("the consistency checks", () => {
  it("refuses a statement whose totals do not match its lines", () => {
    const data = example("customer-statement");
    data.totals = { charges: 1000, payments: 1250 };
    expect(layoutFor("customer-statement").checks(data)).toEqual([
      {
        path: "data.totals.charges",
        message: "is 1,000.00, but the lines' charges add up to 1,142.04",
      },
    ]);
    data.totals = { charges: 1142.04, payments: 1250 };
    data.closingBalance = 1;
    expect(layoutFor("customer-statement").checks(data)).toEqual([
      {
        path: "data.closingBalance",
        message: "is 1.00, but the opening balance plus charges less payments is 1,142.04",
      },
    ]);
  });

  it("refuses a quote whose subtotal or total does not add up", () => {
    const data = example("quote");
    data.subtotal = 990;
    expect(layoutFor("quote").checks(data)).toEqual([
      { path: "data.subtotal", message: "is 990.00, but the line amounts add up to 998.00" },
      { path: "data.total", message: "is 1,077.84, but the subtotal plus tax is 1,069.84" },
    ]);
  });

  it("refuses a report table whose rows do not match its columns", () => {
    const data = example("report");
    const sections = data.sections as { table?: { rows: string[][] } }[];
    sections[0]?.table?.rows.push(["Week 3", "40"]);
    expect(layoutFor("report").checks(data)).toEqual([
      { path: "data.sections[0].table.rows[2]", message: "has 2 cells; the table has 3 columns" },
    ]);
  });
});
