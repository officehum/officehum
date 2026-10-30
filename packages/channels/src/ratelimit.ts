/**
 * The ceiling on what one unregistered number may cost this office in an hour.
 *
 * A number nobody has registered is a stranger with the office's number. Without a ceiling, one
 * sender's loop is one ticket per text, and the workboard — which is the office's queue, not a spam
 * filter — fills with the same sentence. Registered senders are a different question (a customer with
 * a job in flight is not a stranger), and this stage has no registration data to answer it with, so the
 * route applies this ceiling and says so.
 *
 * The window is a fixed bucket, not a sliding one: the counter's identity is `(number, window_start)`,
 * which is one row per number per window and one upsert per message. A sliding window would need a row
 * per message and a sweep to forget them, and forgetting would be a second writer. The price is that a
 * sender can straddle a bucket boundary and fit twice the limit into a few minutes; that is accepted
 * here, because the ceiling exists to stop a flood, not to meter a conversation.
 */

export interface RateLimit {
  /** Messages a number may send in one window. The message that would take it past this is refused. */
  readonly limit: number;
  readonly windowMs: number;
}

/** Three messages an hour: enough for a person splitting a thought, too few for a script. */
export const DEFAULT_SMS_RATE_LIMIT: RateLimit = { limit: 3, windowMs: 60 * 60 * 1000 };

/**
 * The one store call the limiter makes, as a shape. The board implements it; a test can too, and the
 * window arithmetic below then has nothing to do with SQLite.
 */
export interface RateLimitStore {
  countInWindow(
    number: string,
    windowStart: string,
    limit: number,
  ): { readonly allowed: boolean; readonly count: number };
}

/**
 * The first instant of the bucket `at` falls in, ISO 8601. Buckets are aligned to the epoch, so they
 * are stable across restarts and two processes would agree on which one a message belongs to.
 */
export function rateLimitWindow(at: string, window: RateLimit = DEFAULT_SMS_RATE_LIMIT): string {
  const instant = Date.parse(at);
  if (Number.isNaN(instant)) throw new Error(`Cannot place ${at} in a rate-limit window.`);
  if (!Number.isSafeInteger(window.windowMs) || window.windowMs <= 0) {
    throw new Error("A rate-limit window is a positive number of milliseconds.");
  }
  return new Date(Math.floor(instant / window.windowMs) * window.windowMs).toISOString();
}

/**
 * Count this message against the sender's window and answer whether it may go on. The count is taken
 * first, on purpose: a refused message still costs the sender a slot, so a flood's counter climbs
 * instead of sitting politely at the limit, and the office can see how hard it was pushed.
 */
export function admitWithin(
  store: RateLimitStore,
  number: string,
  at: string,
  window: RateLimit = DEFAULT_SMS_RATE_LIMIT,
): { readonly allowed: boolean; readonly count: number } {
  return store.countInWindow(number, rateLimitWindow(at, window), window.limit);
}
