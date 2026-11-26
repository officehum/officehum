/**
 * What an eval run spent on models: tokens and the provider's estimated cost, as plain
 * numbers a runner reports. The SDK makes no model call and reads no price table; it only adds up
 * what the runner and the judge hand it and prints one line.
 */

/** Model spend: tokens by kind and the estimated cost, as the provider's price table priced them. */
export interface ModelUsage {
  /** Input tokens not read from the provider's prompt cache. */
  readonly input: number;
  /** Input tokens read from the provider's prompt cache, billed at its cached rate. */
  readonly cacheRead: number;
  /** Input tokens written to the cache, where the provider bills writes apart. */
  readonly cacheWrite: number;
  /** Output tokens, reasoning included. */
  readonly output: number;
  /** The part of `output` that was reasoning, where the provider reports it; else 0. */
  readonly reasoning: number;
  /** Estimated cost in US dollars. */
  readonly cost: number;
}

/** Adds two usages, counter by counter. */
export function addUsage(left: ModelUsage, right: ModelUsage): ModelUsage {
  return {
    input: left.input + right.input,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    output: left.output + right.output,
    reasoning: left.reasoning + right.reasoning,
    cost: left.cost + right.cost,
  };
}

/**
 * The sum of the usages given. Undefined when none was reported, so a report from a runner that
 * measures nothing never reads as a free run.
 */
export function sumUsage(usages: readonly (ModelUsage | undefined)[]): ModelUsage | undefined {
  const reported = usages.filter((usage): usage is ModelUsage => usage !== undefined);
  const [first, ...rest] = reported;
  return first === undefined ? undefined : rest.reduce(addUsage, first);
}

/**
 * The one summary line: every input token (the cached ones in brackets), every output token (the
 * reasoning ones in brackets) and the estimated cost.
 */
export function formatUsage(usage: ModelUsage): string {
  const count = (value: number) => Math.round(value).toLocaleString("en-US");
  const input = usage.input + usage.cacheRead + usage.cacheWrite;
  return (
    `Model usage: ${count(input)} input tokens (${count(usage.cacheRead)} cached), ` +
    `${count(usage.output)} output tokens (${count(usage.reasoning)} reasoning); ` +
    `estimated cost $${usage.cost.toFixed(4)}`
  );
}
