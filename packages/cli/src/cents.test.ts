import type { ApprovalRequest } from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import { formatCents, parseCents, readApprovalValue } from "./cents.js";
import type { CliIo } from "./cli.js";

describe("parseCents", () => {
  it("reads dollars and cents as text, with no floating point", () => {
    expect(parseCents("12", false)).toBe(1_200);
    expect(parseCents("12.5", false)).toBe(1_250);
    expect(parseCents("12.50", false)).toBe(1_250);
    expect(parseCents("12.", false)).toBe(1_200);
    expect(parseCents(" 0.29 ", false)).toBe(29);
    expect(parseCents("1.10", false)).toBe(110);
    expect(parseCents("0.07", false)).toBe(7);
  });

  it("takes a leading minus only when the bounds allow a negative value", () => {
    expect(parseCents("-3.07", true)).toBe(-307);
    expect(parseCents("-0", true)).toBe(0);
    expect(Object.is(parseCents("-0", true), -0)).toBe(false);
    expect(parseCents("-3.07", false)).toBeUndefined();
  });

  it("refuses anything that is not digits and at most two decimals", () => {
    for (const text of [
      "",
      "abc",
      "1.234",
      ".5",
      "$5",
      "1,000",
      "1e3",
      "+5",
      "5-",
      "- 5",
      "0x10",
    ]) {
      expect(parseCents(text, true), text).toBeUndefined();
    }
    expect(parseCents("99999999999999999", false)).toBeUndefined();
  });
});

describe("formatCents", () => {
  it("writes whole cents as dollars and cents", () => {
    expect(formatCents(1_250)).toBe("12.50");
    expect(formatCents(-7)).toBe("-0.07");
    expect(formatCents(0)).toBe("0.00");
  });
});

describe("readApprovalValue", () => {
  const request = {
    approvalId: "pay_adjustment",
    description: "Approve a correction",
    tool: "adjust_pay",
    arguments: {},
    conversationId: "c",
    taskId: "t",
    callId: "k",
    amount: 1_000,
    valueRequest: { name: "adjustmentCents", label: "Adjustment", min: -2_000, max: 2_000 },
  } satisfies ApprovalRequest;

  function io(answers: (string | undefined)[]) {
    const out: string[] = [];
    const errors: string[] = [];
    const terminal = {
      output: (line: string) => out.push(line),
      error: (line: string) => errors.push(line),
      readApproval: async () => answers.shift(),
    } as unknown as CliIo;
    return { terminal, out, errors };
  }

  it("shows the label, bounds and proposal, asks again until the answer parses and fits, and returns cents", async () => {
    const { terminal, out, errors } = io(["lots", "25.00", "-12.34"]);
    expect(await readApprovalValue(terminal, request)).toBe(-1_234);
    expect(out).toEqual(["Enter Adjustment (from -20.00 to 20.00, proposed 10.00)."]);
    expect(errors).toEqual([
      '"lots" is not an amount like 12.50 or -12.50; try again.',
      "25.00 is outside from -20.00 to 20.00; try again.",
    ]);
  });

  it("returns nothing for an empty answer or the end of input, which declines", async () => {
    expect(await readApprovalValue(io([""]).terminal, request)).toBeUndefined();
    expect(await readApprovalValue(io([]).terminal, request)).toBeUndefined();
  });
});
