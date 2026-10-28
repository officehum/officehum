/**
 * The price table's contract (RASF-3141).
 *
 * The claim under test is narrow and load-bearing: the same tokens and the same model always convert to
 * the same number of cents, with no clock, no network and no floating-point surprise. A budget in
 * dollars is only worth having if two runs of the same work agree on the bill.
 */
import type { Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  centsFor,
  DEFAULT_PRICE_TABLE,
  formatCents,
  type PriceTable,
  priceFor,
  priceKey,
  tokensOf,
} from "./prices.js";

function usage(parts: Partial<Usage>): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...parts,
  };
}

/** One cent per thousand tokens in, two per thousand out — easy to check by hand. */
const TABLE: PriceTable = {
  prices: {
    "test/model": { input: 1000, output: 2000, cacheRead: 0, cacheWrite: 0 },
  },
  fallback: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const MODEL = { provider: "test", modelId: "model" };

describe("spend price table", () => {
  it("converts tokens to cents deterministically, the same way every time", () => {
    const answer = usage({ input: 1000, output: 500, totalTokens: 1500 });
    const first = centsFor(TABLE, MODEL, answer);
    // 1000 tokens at 1000¢/M = 1¢; 500 at 2000¢/M = 1¢.
    expect(first).toBe(2);
    for (let run = 0; run < 5; run += 1) {
      expect(centsFor(TABLE, MODEL, answer)).toBe(first);
    }
    expect(Number.isInteger(first)).toBe(true);
  });

  it("scales with tokens and never goes backwards", () => {
    let previous = -1;
    for (const tokens of [0, 1, 500, 999, 1000, 10_000, 1_000_000]) {
      const cents = centsFor(TABLE, MODEL, usage({ input: tokens, totalTokens: tokens }));
      expect(cents).toBeGreaterThanOrEqual(previous);
      expect(Number.isInteger(cents)).toBe(true);
      previous = cents;
    }
    // A million input tokens at 1000¢/M is 1000¢, exactly — no accumulated float error.
    expect(centsFor(TABLE, MODEL, usage({ input: 1_000_000, totalTokens: 1_000_000 }))).toBe(1000);
  });

  it("prices the model it names and falls back for anything else", () => {
    expect(priceFor(TABLE, MODEL)).toEqual(TABLE.prices["test/model"]);
    expect(priceFor(TABLE, { provider: "other", modelId: "thing" })).toEqual(TABLE.fallback);
    // An unpriced model charges nothing: the operator's table is the only rate there is.
    expect(centsFor(TABLE, { provider: "other", modelId: "thing" }, usage({ input: 5000 }))).toBe(
      0,
    );
    expect(priceKey(MODEL)).toBe("test/model");
  });

  it("prices the paper model from the rate this repository already states", () => {
    // `packages/provider-paper` declares $0.15/M in and $0.50/M out for ultramarine-1-flash; the default
    // table is that in cents, so 1M in + 1M out is 15¢ + 50¢.
    const paper = { provider: "paper", modelId: "ultramarine-1-flash" };
    const million = usage({ input: 1_000_000, output: 1_000_000, totalTokens: 2_000_000 });
    expect(centsFor(DEFAULT_PRICE_TABLE, paper, million)).toBe(65);
    expect(tokensOf(million)).toBe(2_000_000);
  });

  it("counts tokens from the provider's total, or from the components when it gives none", () => {
    expect(tokensOf(usage({ totalTokens: 1234 }))).toBe(1234);
    expect(tokensOf(usage({ input: 10, output: 20, cacheRead: 5, totalTokens: 0 }))).toBe(35);
    // A negative or non-finite figure is not spend; it counts as nothing rather than as a refund.
    expect(tokensOf(usage({ totalTokens: -5 }))).toBe(0);
  });

  it("writes cents as money a person reads", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(1)).toBe("$0.01");
    expect(formatCents(65)).toBe("$0.65");
    expect(formatCents(1234)).toBe("$12.34");
  });
});
