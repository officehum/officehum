/** How long to wait before reconnecting or retrying. */
export interface BackoffOptions {
  /** The first delay. Default 250 ms. */
  readonly initialMs?: number;
  /** The longest delay. Default 10 s. */
  readonly maxMs?: number;
}

/** The delay before attempt `attempt` (0-based): doubling from `initialMs` up to `maxMs`, ±20%. */
export function backoffDelay(attempt: number, options: BackoffOptions = {}): number {
  const initial = options.initialMs ?? 250;
  const max = options.maxMs ?? 10_000;
  const base = Math.min(max, initial * 2 ** Math.min(attempt, 30));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/** Waits `ms`, or less if `signal` aborts first (the client closed), without keeping a timer behind. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done);
  });
}
