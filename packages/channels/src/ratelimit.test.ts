import { describe, expect, it } from "vitest";
import {
  admitWithin,
  DEFAULT_SMS_RATE_LIMIT,
  type RateLimitStore,
  rateLimitWindow,
} from "./ratelimit.js";

const NUMBER = "+15551234567";

/** A store that answers from a counter, so the arithmetic here can be checked without SQLite. */
function countingStore(limit: number): RateLimitStore & { seen: string[] } {
  const counts = new Map<string, number>();
  const seen: string[] = [];
  return {
    seen,
    countInWindow(number, windowStart, receivedLimit) {
      expect(receivedLimit).toBe(limit);
      seen.push(windowStart);
      const key = `${number}@${windowStart}`;
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { allowed: count <= receivedLimit, count };
    },
  };
}

describe("rate-limit windows", () => {
  it("defaults to three messages an hour", () => {
    expect(DEFAULT_SMS_RATE_LIMIT).toEqual({ limit: 3, windowMs: 60 * 60 * 1000 });
  });

  it("puts every instant of an hour in one bucket, aligned to the epoch", () => {
    expect(rateLimitWindow("2030-01-01T00:00:00.000Z")).toBe("2030-01-01T00:00:00.000Z");
    expect(rateLimitWindow("2030-01-01T00:59:59.999Z")).toBe("2030-01-01T00:00:00.000Z");
    expect(rateLimitWindow("2030-01-01T01:00:00.000Z")).toBe("2030-01-01T01:00:00.000Z");
  });

  it("honours an injected window length", () => {
    const window = { limit: 2, windowMs: 60_000 };
    expect(rateLimitWindow("2030-01-01T00:00:00.000Z", window)).toBe("2030-01-01T00:00:00.000Z");
    expect(rateLimitWindow("2030-01-01T00:00:59.999Z", window)).toBe("2030-01-01T00:00:00.000Z");
    expect(rateLimitWindow("2030-01-01T00:01:00.000Z", window)).toBe("2030-01-01T00:01:00.000Z");
  });

  it("refuses an instant it cannot place", () => {
    expect(() => rateLimitWindow("yesterday")).toThrow(/window/);
    expect(() => rateLimitWindow("2030-01-01T00:00:00.000Z", { limit: 3, windowMs: 0 })).toThrow(
      /positive/,
    );
  });

  it("counts each message against the sender's bucket and refuses past the limit", () => {
    const store = countingStore(2);
    const at = "2030-01-01T00:10:00.000Z";
    expect(admitWithin(store, NUMBER, at, { limit: 2, windowMs: 60 * 60 * 1000 })).toEqual({
      allowed: true,
      count: 1,
    });
    expect(admitWithin(store, NUMBER, at, { limit: 2, windowMs: 60 * 60 * 1000 })).toEqual({
      allowed: true,
      count: 2,
    });
    // The message that would take the sender past the ceiling is refused, and it still counts.
    expect(admitWithin(store, NUMBER, at, { limit: 2, windowMs: 60 * 60 * 1000 })).toEqual({
      allowed: false,
      count: 3,
    });
    expect(store.seen).toEqual([
      "2030-01-01T00:00:00.000Z",
      "2030-01-01T00:00:00.000Z",
      "2030-01-01T00:00:00.000Z",
    ]);
  });

  it("counts a number that moved into a new window from zero", () => {
    const store = countingStore(1);
    const window = { limit: 1, windowMs: 60 * 60 * 1000 };
    expect(admitWithin(store, NUMBER, "2030-01-01T00:59:00.000Z", window).allowed).toBe(true);
    expect(admitWithin(store, NUMBER, "2030-01-01T01:00:00.000Z", window)).toEqual({
      allowed: true,
      count: 1,
    });
  });
});
