import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "agents/*/src/**/*.test.ts"],
    // The Paper Office suites spawn a Python worker per test. Left to the default worker count they
    // thrash: single tests ran for 30-60 s, hit their caps, and failed as timeouts while passing
    // alone — a flaky gate is still a broken gate. Capping the pool removes the contention and is
    // *faster* than the default here (30 s versus 150 s of thrashing), and 30 s per test covers a
    // cold interpreter start while still failing a genuine hang.
    maxWorkers: 4,
    testTimeout: 30_000,
  },
});
