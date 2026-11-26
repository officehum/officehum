/**
 * What an eval run spends and how much it asks a provider to reserve.
 *
 * Usage: Pi Durable keeps each conversation's spend (`pi.usage`), and a trial's office is its own
 * in-memory harness, so the harness's total is the trial's: every request, failed attempts and
 * compaction included. It is handed to the SDK as plain numbers.
 *
 * The output cap: pi-ai asks for `maxTokens` output tokens per request, and without one it asks for
 * the model's whole limit (32,768 for Ultramarine). A provider that reserves balance for each
 * request's largest possible cost then refuses requests long before a small balance is spent. An
 * eval run caps its requests through a view of the model collection that adds `maxTokens` when the
 * caller gave none; the provider, the model and production are unchanged.
 */

import type { Usage } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import type { UsageState } from "@earendil-works/pi-durable";
import type { ModelUsage } from "@officehum/sdk";

/** One pi-ai usage record as the SDK's plain numbers. */
export function modelUsageOf(usage: Usage): ModelUsage {
  return {
    input: usage.input,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    output: usage.output,
    reasoning: usage.reasoning ?? 0,
    cost: usage.cost.total,
  };
}

/** A harness's `pi.usage`, every model and tool bucket summed. */
export function usageTotal(state: UsageState): ModelUsage {
  let total: ModelUsage = {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    cost: 0,
  };
  for (const bucket of [state.models, state.tools]) {
    for (const usage of Object.values(bucket)) {
      const counted = modelUsageOf(usage as Usage);
      total = {
        input: total.input + counted.input,
        cacheRead: total.cacheRead + counted.cacheRead,
        cacheWrite: total.cacheWrite + counted.cacheWrite,
        output: total.output + counted.output,
        reasoning: total.reasoning + counted.reasoning,
        cost: total.cost + counted.cost,
      };
    }
  }
  return total;
}

/**
 * `models`, with every `streamSimple` and `completeSimple` request that names no `maxTokens` asking
 * for at most `maxTokens` output tokens. Everything else is the collection's own. Undefined `maxTokens`
 * returns `models` itself.
 */
export function cappedModels(models: Models, maxTokens: number | undefined): Models {
  if (maxTokens === undefined) return models;
  return new Proxy(models, {
    get(target, property) {
      if (property === "streamSimple" || property === "completeSimple") {
        const request = target[property].bind(target);
        return (...[model, context, options]: Parameters<Models["streamSimple"]>) =>
          request(model, context, { ...options, maxTokens: options?.maxTokens ?? maxTokens });
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Why a trial whose model reply hit the output cap is not graded. */
export function outputLimitError(maxTokens: number | undefined): string {
  const cap = maxTokens === undefined ? "the model's output limit" : `${maxTokens} output tokens`;
  return (
    `a model reply ended at ${cap} (stop reason "length"), so what the agent would have said or ` +
    "called is unknown and the trial is not graded; raise the cap (officehum eval " +
    "--max-output-tokens N) and run it again"
  );
}
