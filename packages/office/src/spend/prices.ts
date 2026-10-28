/**
 * The token → cents price table (RASF-3141).
 *
 * A budget in dollars needs a rate, and the only honest rate is a number someone wrote down. Pi's
 * provider catalog reports a cost per response, but it is the *provider's* figure, it is a float in
 * dollars, and it moves when the vendor re-prices — none of which makes a ceiling that a reviewer can
 * reproduce from the board a week later. So billing uses this table instead: integer cents per million
 * tokens, per `provider/modelId`, checked in or supplied by the office's operator, and nothing is
 * looked up at charge time.
 *
 * The arithmetic is deterministic on purpose. Each component is rounded to whole cents once
 * (`Math.round` over an exact integer product) and the components are summed; the same tokens and the
 * same model therefore always produce the same number of cents, which is what lets a test assert an
 * exact figure and a person reconcile a bill.
 *
 * A model the table does not price charges `fallback` — zero cents by default. That is a deliberate,
 * stated limit rather than a guess: tokens are always counted (they cannot lie), cents are only as good
 * as the operator's table, and an office that wants a dollar ceiling prices the models it runs.
 */
import type { Usage } from "@earendil-works/pi-ai";

/** Cents per million tokens, mirroring pi-ai's `cost` shape but in integer cents. */
export interface ModelPrice {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** A price table: one rate per `provider/modelId`, plus the rate for anything unlisted. */
export interface PriceTable {
  readonly prices: Readonly<Record<string, ModelPrice>>;
  readonly fallback: ModelPrice;
}

/** Nothing charged. Used for the fallback and for models that genuinely cost nothing to run. */
export const FREE: ModelPrice = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * The table this repository can stand behind. Only one model has a rate written down in this repo —
 * `@officehum/provider-paper`'s catalog entry for `paper/ultramarine-1-flash`, whose dollar cost per
 * million tokens is `{ input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0.15 }` — and these are
 * that figure in cents, doubled-checked by hand rather than converted at run time so no float ever
 * reaches the ledger.
 *
 * There is no office-level config file in this repository to hold an operator's own table (the office's
 * configuration today is the arguments an operator passes to `officehum run`), so the table is data an
 * office supplies when it builds its hooks: pass a `PriceTable` to `budgetHooks` and it is used as
 * given. Inventing a config format for one table would be a second source of truth for the same fact.
 */
export const DEFAULT_PRICE_TABLE: PriceTable = {
  prices: {
    "paper/ultramarine-1-flash": { input: 15, output: 50, cacheRead: 3, cacheWrite: 15 },
    // The offline providers. A test that budgets dollars against a scripted model prices it here or
    // passes its own table; these cost nothing to run, and saying so is honest.
    "scripted/scripted-1": FREE,
    "officehum-demo/frontdesk-demo": FREE,
  },
  fallback: FREE,
};

/** The key a table is looked up by: `provider/modelId`, the pair pi reports on every response. */
export function priceKey(model: { readonly provider: string; readonly modelId: string }): string {
  return `${model.provider}/${model.modelId}`;
}

/** The tokens a usage record counts. `totalTokens` is the provider's own total when it gives one. */
export function tokensOf(usage: Usage): number {
  const total = usage.totalTokens;
  if (Number.isFinite(total) && total > 0) return Math.trunc(total);
  const parts = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
  return parts.reduce(
    (sum, value) => sum + (Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0),
    0,
  );
}

/** One component's cents: an exact integer product, rounded once, never negative. */
function componentCents(tokens: number, centsPerMillion: number): number {
  if (!Number.isFinite(tokens) || !Number.isFinite(centsPerMillion)) return 0;
  const product = Math.trunc(tokens) * centsPerMillion;
  if (!Number.isFinite(product)) return 0;
  return Math.max(0, Math.round(product / 1_000_000));
}

/** The rate for a model: its own row, or the table's fallback. Never a live lookup. */
export function priceFor(
  table: PriceTable,
  model: { readonly provider: string; readonly modelId: string },
): ModelPrice {
  return table.prices[priceKey(model)] ?? table.fallback;
}

/**
 * What one response cost, in whole cents.
 *
 * Rounded per component and summed, in that order, because the order is part of the answer: rounding a
 * total gives a different figure from summing rounded parts, and only one of them can be reproduced by
 * hand from a token count.
 */
export function centsFor(
  table: PriceTable,
  model: { readonly provider: string; readonly modelId: string },
  usage: Usage,
): number {
  const price = priceFor(table, model);
  return (
    componentCents(usage.input, price.input) +
    componentCents(usage.output, price.output) +
    componentCents(usage.cacheRead, price.cacheRead) +
    componentCents(usage.cacheWrite, price.cacheWrite)
  );
}

/** Cents as a person writes money: `$0.12`, `$1.00`, `$0.00`. */
export function formatCents(cents: number): string {
  return `$${(Math.max(0, cents) / 100).toFixed(2)}`;
}
