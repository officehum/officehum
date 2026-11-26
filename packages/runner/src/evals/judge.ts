/**
 * The model judge an eval run grades `expect.reply.judged` with: the SDK's prompt sent
 * as one user message through a model collection, by default the one the trial itself ran on, so a
 * run needs no second provider or key. The SDK reads the answer; this only makes the call.
 *
 * A provider failure throws (the SDK makes the trial `errored`), and nothing here falls back to
 * another provider or model.
 */

import type { Models } from "@earendil-works/pi-ai/models";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { ReplyJudge } from "@officehum/sdk";
import { modelUsageOf } from "./eval-cost.js";

/** The catalogue and the model ref one trial runs under. */
export interface EvalModel {
  readonly models: Models;
  readonly model: ModelRef;
}

/**
 * A `ReplyJudge` over one model. It asks at temperature 0, the lowest the provider path allows,
 * except on a reasoning model, whose sampling the provider fixes (OpenAI's refuse the parameter), so
 * there it sends none.
 */
export function modelJudge(runtime: EvalModel): ReplyJudge {
  const { provider, modelId } = runtime.model;
  const name = `${provider}/${modelId}`;
  return {
    model: name,
    async ask(prompt) {
      const model = runtime.models.getModel(provider, modelId);
      if (model === undefined) {
        throw new Error(
          `${name} is not in the judge's models. Register its provider, or pass --judge with a model it serves.`,
        );
      }
      const answer = await runtime.models.completeSimple(
        model,
        { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
        model.reasoning ? {} : { temperature: 0 },
      );
      if (answer.stopReason === "error" || answer.stopReason === "aborted") {
        throw new Error(
          `${name} answered with ${answer.stopReason}${answer.errorMessage === undefined ? "" : `: ${answer.errorMessage}`}`,
        );
      }
      // A cut-off answer is no verdict, whatever its first word: the trial is errored, not graded.
      if (answer.stopReason === "length") {
        throw new Error(
          `${name}'s answer ended at its output token limit (stop reason "length"); raise --max-output-tokens`,
        );
      }
      return {
        text: answer.content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join(""),
        usage: modelUsageOf(answer.usage),
      };
    },
  };
}
