import { describe, expect, it } from "vitest";
import { type CheckInput, checkExtraction, textHasAmount, toCents } from "./checks.js";

const CLEAN: CheckInput = {
  documentNumber: "BW-1107",
  issueDate: "2026-11-02",
  dueDate: "2026-12-02",
  currency: "GBP",
  subtotal: "1500.00",
  total: "1800.00",
  lineItems: [
    { quantity: "4", unitPrice: "300.00", amount: "1200.00" },
    { quantity: "2", unitPrice: "150.00", amount: "300.00" },
  ],
  taxLines: [{ amount: "300.00" }],
};

const SOURCE = [
  "Invoice no: BW-1107",
  "Office cleaning (weeks) 4 300.00 1,200.00",
  "Total GBP 1,800.00",
];

function byName(input: CheckInput, source: readonly string[] = SOURCE) {
  return Object.fromEntries(
    checkExtraction(input, source).map((check) => [check.name, check] as const),
  );
}

describe("toCents", () => {
  it("reads plain decimals with up to two places as integer cents", () => {
    expect(toCents("1800.00")).toBe(180000n);
    expect(toCents("0.1")).toBe(10n);
    expect(toCents("45")).toBe(4500n);
    expect(toCents("-12.50")).toBe(-1250n);
  });

  it("refuses anything that is not a plain decimal, rather than guessing", () => {
    for (const text of ["1,800.00", "£10", "10.005", "", "ten", "1e3", " 10"]) {
      expect(toCents(text)).toBeUndefined();
    }
  });

  it("keeps cents exact where floating point would not", () => {
    expect((toCents("0.10") ?? 0n) + (toCents("0.20") ?? 0n)).toBe(toCents("0.30"));
  });
});

describe("textHasAmount", () => {
  it("finds an amount however the document groups and separates it", () => {
    expect(textHasAmount(["Total GBP 1,800.00"], 180000n)).toBe(true);
    expect(textHasAmount(["Summe 1.800,00 EUR"], 180000n)).toBe(true);
    expect(textHasAmount(["TOTAL 1800"], 180000n)).toBe(true);
    expect(textHasAmount(["Total GBP 1,800.00"], 18000n)).toBe(false);
  });

  it("does not join numbers that a space separates", () => {
    expect(textHasAmount(["Office cleaning 4 300.00"], 430000n)).toBe(false);
  });
});

describe("checkExtraction", () => {
  it("passes every check for a bill whose figures agree", () => {
    const checks = checkExtraction(CLEAN, SOURCE);
    expect(checks.filter((check) => check.result === "fail")).toEqual([]);
    expect(checks.map((check) => check.name)).toEqual([
      "line-amount",
      "line-amount",
      "lines-subtotal",
      "subtotal-tax-total",
      "dates",
      "currency",
      "source-total",
      "source-document-number",
    ]);
  });

  it("catches lines that do not add up and a wrong total", () => {
    const checks = byName({
      ...CLEAN,
      subtotal: "1520.00",
      total: "1830.00",
    });
    expect(checks["lines-subtotal"]?.result).toBe("fail");
    expect(checks["lines-subtotal"]?.message).toContain("1500.00");
    expect(checks["lines-subtotal"]?.message).toContain("1520.00");
    expect(checks["subtotal-tax-total"]?.result).toBe("fail");
    expect(checks["subtotal-tax-total"]?.message).toContain("1820.00");
  });

  it("checks quantity times unit price, rounded to the cent", () => {
    const fails = checkExtraction(
      {
        ...CLEAN,
        lineItems: [
          { quantity: "1.5", unitPrice: "33.33", amount: "50.00" },
          { quantity: "3", unitPrice: "19.99", amount: "59.99" },
        ],
        subtotal: "109.99",
        taxLines: [],
        total: "109.99",
      },
      ["BW-1107 109.99"],
    ).filter((check) => check.result === "fail");
    expect(fails).toEqual([
      { name: "line-amount", result: "fail", message: expect.stringContaining("line 2") },
    ]);
    expect(fails[0]?.message).toContain("59.97");
  });

  it("fails a line that gives a quantity but no unit price, and skips one that gives neither", () => {
    const checks = checkExtraction(
      {
        ...CLEAN,
        lineItems: [
          { quantity: "4", unitPrice: null, amount: "1200.00" },
          { quantity: null, unitPrice: null, amount: "300.00" },
        ],
      },
      SOURCE,
    );
    const lines = checks.filter((check) => check.name === "line-amount");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.result).toBe("fail");
  });

  it("fails a figure that is missing or not a plain decimal", () => {
    const missing = byName({ ...CLEAN, subtotal: null });
    expect(missing["lines-subtotal"]?.message).toBe("no subtotal is stated");
    expect(missing["subtotal-tax-total"]?.result).toBe("fail");
    const grouped = byName({ ...CLEAN, total: "1,800.00" });
    expect(grouped["subtotal-tax-total"]?.result).toBe("fail");
    expect(grouped["subtotal-tax-total"]?.message).toContain('"1,800.00"');
  });

  it("checks that dates are real and the due date is not before the issue date", () => {
    expect(byName({ ...CLEAN, dueDate: "2026-10-01" }).dates?.result).toBe("fail");
    expect(byName({ ...CLEAN, issueDate: "2026-02-30" }).dates?.result).toBe("fail");
    expect(byName({ ...CLEAN, issueDate: "02/11/2026" }).dates?.result).toBe("fail");
    expect(byName({ ...CLEAN, issueDate: null }).dates?.result).toBe("fail");
    expect(byName({ ...CLEAN, dueDate: null }).dates).toMatchObject({
      result: "pass",
      message: expect.stringContaining("no due date"),
    });
    expect(byName({ ...CLEAN, dueDate: "2026-11-02" }).dates?.result).toBe("pass");
  });

  it("checks the currency is an ISO 4217 code", () => {
    expect(byName({ ...CLEAN, currency: "GBP" }).currency?.result).toBe("pass");
    expect(byName({ ...CLEAN, currency: "£" }).currency?.result).toBe("fail");
    expect(byName({ ...CLEAN, currency: "XYZ" }).currency?.result).toBe("fail");
    expect(byName({ ...CLEAN, currency: null }).currency?.result).toBe("fail");
  });

  it("cross-checks the total and the document number against the source text", () => {
    const checks = byName(CLEAN, ["Office cleaning 4 300.00 1,200.00"]);
    expect(checks["source-total"]?.result).toBe("fail");
    expect(checks["source-document-number"]?.result).toBe("fail");
    expect(
      byName(CLEAN, ["Invoice no:-bw 1107", "1800.00"])["source-document-number"]?.result,
    ).toBe("pass");
    expect(byName({ ...CLEAN, documentNumber: null })["source-document-number"]?.result).toBe(
      "fail",
    );
  });
});
