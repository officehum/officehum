/**
 * The price table's contract (RASF-3141).
 *
 * The claim under test is narrow and load-bearing: the same tokens and the same model always convert to
 * the same number of micro-dollars, with no clock, no network and no floating-point surprise. A budget in
 * dollars is only worth having if two runs of the same work agree on the bill.
 */
import type { Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRICE_TABLE,
  formatMicros,
  MICROS_PER_CENT,
  microsFor,
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
  it("converts tokens to micro-dollars deterministically, the same way every time", () => {
    const answer = usage({ input: 1000, output: 500, totalTokens: 1500 });
    const first = microsFor(TABLE, MODEL, answer);
    // 1000 tokens at 1000¢/M = 1¢; 500 at 2000¢/M = 1¢.
    expect(first).toBe(2 * MICROS_PER_CENT);
    for (let run = 0; run < 5; run += 1) {
      expect(microsFor(TABLE, MODEL, answer)).toBe(first);
    }
    expect(Number.isInteger(first)).toBe(true);
  });

  it("scales with tokens and never goes backwards", () => {
    let previous = -1;
    for (const tokens of [0, 1, 500, 999, 1000, 10_000, 1_000_000]) {
      const micros = microsFor(TABLE, MODEL, usage({ input: tokens, totalTokens: tokens }));
      expect(micros).toBeGreaterThanOrEqual(previous);
      expect(Number.isInteger(micros)).toBe(true);
      previous = micros;
    }
    // A million input tokens at 1000¢/M is 1000¢, exactly — no accumulated float error.
    expect(microsFor(TABLE, MODEL, usage({ input: 1_000_000, totalTokens: 1_000_000 }))).toBe(
      1000 * MICROS_PER_CENT,
    );
  });

  it("prices the model it names and falls back for anything else", () => {
    expect(priceFor(TABLE, MODEL)).toEqual(TABLE.prices["test/model"]);
    expect(priceFor(TABLE, { provider: "other", modelId: "thing" })).toEqual(TABLE.fallback);
    // An unpriced model charges nothing: the operator's table is the only rate there is.
    expect(microsFor(TABLE, { provider: "other", modelId: "thing" }, usage({ input: 5000 }))).toBe(
      0,
    );
    expect(priceKey(MODEL)).toBe("test/model");
  });

  it("prices the paper model from the rate this repository already states", () => {
    // `packages/provider-paper` declares $0.15/M in and $0.50/M out for ultramarine-1-flash; the default
    // table is that in cents, so 1M in + 1M out is 15¢ + 50¢.
    const paper = { provider: "paper", modelId: "ultramarine-1-flash" };
    const million = usage({ input: 1_000_000, output: 1_000_000, totalTokens: 2_000_000 });
    expect(microsFor(DEFAULT_PRICE_TABLE, paper, million)).toBe(65 * MICROS_PER_CENT);
    expect(tokensOf(million)).toBe(2_000_000);
  });

  it("counts tokens from the provider's total, or from the components when it gives none", () => {
    expect(tokensOf(usage({ totalTokens: 1234 }))).toBe(1234);
    expect(tokensOf(usage({ input: 10, output: 20, cacheRead: 5, totalTokens: 0 }))).toBe(35);
    // A negative or non-finite figure is not spend; it counts as nothing rather than as a refund.
    expect(tokensOf(usage({ totalTokens: -5 }))).toBe(0);
  });

  it("charges a small turn something: micro-dollars do not round a cheap turn to nothing", () => {
    const paper = { provider: "paper", modelId: "ultramarine-1-flash" };
    // 2,000 tokens in and 300 out at $0.15/M and $0.50/M: $0.0003 + $0.00015. In whole cents each
    // component rounded to zero, which is why a dollar ceiling never bound.
    const turn = usage({ input: 2000, output: 300, totalTokens: 2300 });
    expect(microsFor(DEFAULT_PRICE_TABLE, paper, turn)).toBe(300 + 150);
    // A thousand such turns cost what one turn of the same tokens costs.
    const large = usage({ input: 2_000_000, output: 300_000, totalTokens: 2_300_000 });
    expect(microsFor(DEFAULT_PRICE_TABLE, paper, large)).toBe(450 * 1000);
  });

  it("keeps micro-dollars whole, deterministic and never negative", () => {
    for (const tokens of [0, 1, 7, 49, 50, 999, 123_457]) {
      const micros = microsFor(TABLE, MODEL, usage({ input: tokens, output: tokens }));
      expect(Number.isInteger(micros)).toBe(true);
      expect(micros).toBe(microsFor(TABLE, MODEL, usage({ input: tokens, output: tokens })));
      expect(micros).toBeGreaterThanOrEqual(0);
    }
    // One token at 15 cents per million is 0.15 micro-dollars: below the unit, rounded per component.
    const paper = { provider: "paper", modelId: "ultramarine-1-flash" };
    expect(microsFor(DEFAULT_PRICE_TABLE, paper, usage({ input: 1 }))).toBe(0);
    expect(microsFor(DEFAULT_PRICE_TABLE, paper, usage({ input: 4 }))).toBe(1);
    expect(microsFor(TABLE, { provider: "other", modelId: "thing" }, usage({ input: 5000 }))).toBe(
      0,
    );
  });

  it("writes micro-dollars as money a person reads, rounded only for display", () => {
    expect(formatMicros(0)).toBe("$0.00");
    // Spent, but too little to round up to a cent: "$0.00" would read as nothing spent at all.
    expect(formatMicros(1)).toBe("<$0.01");
    expect(formatMicros(450)).toBe("<$0.01");
    expect(formatMicros(4_999)).toBe("<$0.01");
    expect(formatMicros(5_000)).toBe("$0.01");
    expect(formatMicros(650_000)).toBe("$0.65");
    expect(formatMicros(12_340_000)).toBe("$12.34");
    expect(formatMicros(65 * MICROS_PER_CENT)).toBe("$0.65");
  });
});
