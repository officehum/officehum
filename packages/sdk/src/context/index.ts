/**
 * The durable context patterns, wired from a role's `contextPlan`. Each request sees a
 * projection of the transcript, and the transcript in storage stays whole. See "Context engineering"
 * in docs/design/agent-package.md.
 *
 * - `historyFilter` turns on the relevance filter (`beforeRequest`), `context_recall`, and compaction
 *   that keeps ids (`beforeCompact`).
 * - `maskAmounts: true` masks amounts in what `read_skill` returns.
 * - The stable-section check is part of `checkAgent`, for every role.
 *
 * A plan that turns nothing on returns the extension itself, so a role without one is unchanged.
 */

import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import type { ContextPlanDeclaration } from "../manifest.js";
import { type IdPreservingCompactionOptions, idPreservingCompaction } from "./compaction.js";
import { maskAmounts } from "./masking.js";
import { contextFilter, contextRecallTool } from "./relevance-filter.js";

export {
  type IdPreservingCompactionOptions,
  idPreservingCompaction,
  KEPT_HEADING,
  rangeFacts,
  SUMMARY_INSTRUCTIONS,
  withKeptIds,
} from "./compaction.js";
export { messageText, type ResultFacts, resultFacts, resultText, tokensOf } from "./ids.js";
export { MASKED_AMOUNT, maskAmounts } from "./masking.js";
export {
  contextFilter,
  contextRecallTool,
  type DecisionStore,
  type FilterDecision,
  filterMessages,
  stubText,
} from "./relevance-filter.js";
export {
  DYNAMIC_ROLE_SECTIONS,
  type SectionProblem,
  stableSectionProblems,
} from "./stable-sections.js";

/** The SDK tool whose text `maskAmounts` applies to. */
const READ_SKILL = "read_skill";

export type ContextPatternOptions = IdPreservingCompactionOptions;

/** `extension` with the patterns its context plan turns on. */
export function withContextPatterns(
  extension: Extension,
  plan: ContextPlanDeclaration | undefined,
  options: ContextPatternOptions,
): Extension {
  const filter = plan?.historyFilter;
  const mask = plan?.maskAmounts === true;
  if (filter === undefined && !mask) return extension;
  const tools = (extension.tools ?? []).map((tool) =>
    mask && tool.name === READ_SKILL ? maskedTool(tool) : tool,
  );
  return {
    ...extension,
    tools: filter === undefined ? tools : [...tools, contextRecallTool()],
    hooks:
      filter === undefined
        ? (extension.hooks ?? [])
        : [...(extension.hooks ?? []), contextFilter(filter), idPreservingCompaction(options)],
  };
}

/** A copy of `tool` whose text output is masked. */
function maskedTool(tool: ToolRegistration): ToolRegistration {
  const execute = tool.execute;
  return {
    ...tool,
    execute: async (args, api, context) => {
      const result = await execute(args, api, context);
      if (result.output === undefined) return result;
      return {
        ...result,
        output: result.output.map((block) =>
          block.type === "text" ? { ...block, text: maskAmounts(block.text) } : block,
        ),
      };
    },
  };
}
