/**
 * The interview's two context steps, as data like the rest of the interview (`../questions.ts`): the
 * short context profile, asked only when the person wants the factory's advice, and the plan, which
 * says each recommendation that cannot be switched on and asks yes or no for each one that can, with
 * its reason. What the answers write is `context_profile` and `context_plan`.
 */

import type { Answers, InterviewStep, Question } from "../questions.js";
import {
  CONTEXT_RULES,
  type ContextProfile,
  isBuilt,
  type Recommendation,
  recommendContext,
} from "./advisor.js";
import type { ContextPlanEntry } from "./plan.js";

const BLANK_IS_NO = "(y/N)";

/** How a person answers each choice, and the profile value it means. */
const SPEED: Readonly<Record<string, ContextProfile["speed"]>> = {
  "it answers customers in real time": "real_time",
  "it works in the back office": "back_office",
};
const REFERENCE_SIZE: Readonly<Record<string, ContextProfile["reference_size"]>> = {
  none: "none",
  "a few pages (about 8,000 tokens in all, or less)": "small",
  "more than a few pages": "large",
};
const REFERENCE_CHANGES: Readonly<
  Record<string, NonNullable<ContextProfile["reference_changes"]>>
> = {
  "quarterly or less often": "rarely",
  "monthly or more often": "often",
};
const TASK_LENGTH: Readonly<Record<string, ContextProfile["task_length"]>> = {
  minutes: "minutes",
  hours: "hours",
  days: "days",
};

/** Whether the person wants the factory to advise on the role's context at all. */
const contextWanted = (answers: Answers): boolean => answers.yes("context_wanted");
const hasReference = (answers: Answers): boolean =>
  contextWanted(answers) && REFERENCE_SIZE[answers.text("context_reference_size")] !== "none";

const COUNT = /^\d+$/;
const count = (answer: string): string | undefined =>
  COUNT.test(answer.trim()) ? undefined : `must be a whole number, 0 or more (got "${answer}")`;

/** The key an accept question's answer is stored under. */
export const acceptKey = (rule: string): string => `context_accept_${rule}`;

/** What each built technique's question asks, in plain words. */
const ACCEPT_PROMPTS: Readonly<Record<string, string>> = {
  promptBudgetTokens:
    "Hold the prompt the role reads on every turn to a fixed size, with its skills read only as needed?",
  maskAmounts:
    "Hide the sample amounts in its skills, so it takes every figure from a tool or its program?",
  historyFilter:
    "Shorten older long tool results to a line it can bring back, and keep every id it cites?",
};

export const CONTEXT_PROFILE_STEP: InterviewStep = {
  id: "context",
  title: "8. How the role manages its context (optional)",
  intro:
    "A few questions about how the role works, so the factory can advise what it should keep in " +
    "front of it on each turn and what it should look up instead. Each piece of advice comes with " +
    "its reason, and you decide on each.",
  optional: true,
  questions: [
    {
      id: "context_wanted",
      path: "context_profile",
      type: "yes-no",
      optional: true,
      prompt: `Do you want advice on how this role manages its context? ${BLANK_IS_NO}`,
      help: "Leave this blank to keep the defaults every role has.",
    },
    {
      id: "context_speed",
      path: "context_profile.speed",
      type: "choice",
      choices: Object.keys(SPEED),
      when: contextWanted,
      prompt: "Does the role answer customers while they wait, or work in the back office?",
    },
    {
      id: "context_reference_size",
      path: "context_profile.reference_size",
      type: "choice",
      choices: Object.keys(REFERENCE_SIZE),
      when: contextWanted,
      prompt: "How much reference material does it work from: price lists, policies, guides?",
      help: "A page is about 500 words.",
    },
    {
      id: "context_reference_changes",
      path: "context_profile.reference_changes",
      type: "choice",
      choices: Object.keys(REFERENCE_CHANGES),
      when: hasReference,
      prompt: "How often does that material change?",
    },
    {
      id: "context_reference_business",
      path: "context_profile.reference_business_specific",
      type: "yes-no",
      when: hasReference,
      prompt: `Is any of it specific to one business rather than true for every business? ${BLANK_IS_NO}`,
    },
    {
      id: "context_reference_tables",
      path: "context_profile.reference_tables",
      type: "yes-no",
      when: hasReference,
      prompt: `Are some of its facts tables, such as rates, price lists or thresholds? ${BLANK_IS_NO}`,
    },
    {
      id: "context_figures",
      path: "context_profile.figures",
      type: "yes-no",
      when: contextWanted,
      prompt: `Do the role's answers contain exact figures? ${BLANK_IS_NO}`,
    },
    {
      id: "context_task_length",
      path: "context_profile.task_length",
      type: "choice",
      choices: Object.keys(TASK_LENGTH),
      when: contextWanted,
      prompt: "How long does a typical task take, from start to finish?",
    },
    {
      id: "context_tool_calls",
      path: "context_profile.tool_calls",
      type: "text",
      when: contextWanted,
      prompt: "About how many times does it use its tools in a typical task?",
      help: "A whole number; a guess is fine.",
      validateText: count,
    },
    {
      id: "context_large_results",
      path: "context_profile.large_results",
      type: "yes-no",
      when: contextWanted,
      prompt: `Do its tools return long results, such as whole documents or long lists? ${BLANK_IS_NO}`,
    },
    {
      id: "context_fan_out",
      path: "context_profile.fan_out",
      type: "text",
      when: contextWanted,
      prompt:
        "If one task covers many similar items, how many at most? 0 if a task is about one thing.",
      validateText: count,
    },
    {
      id: "context_document_pages",
      path: "context_profile.document_pages",
      type: "text",
      when: contextWanted,
      prompt: "How many pages is the longest document it reads? 0 if it reads none.",
      validateText: count,
    },
    {
      id: "context_extracted",
      path: "context_profile.extracted_fields",
      type: "yes-no",
      when: contextWanted,
      prompt: `Does it fill in fields or forms from what it reads? ${BLANK_IS_NO}`,
    },
    {
      id: "context_strict_format",
      path: "context_profile.strict_format",
      type: "yes-no",
      when: contextWanted,
      prompt: `Does it write in a strict format, such as letters or statements? ${BLANK_IS_NO}`,
    },
    {
      id: "context_contacts",
      path: "context_profile.recurring_contacts",
      type: "yes-no",
      when: contextWanted,
      prompt: `Does it deal with the same people again and again? ${BLANK_IS_NO}`,
    },
    {
      id: "context_hand_offs",
      path: "context_profile.hand_offs",
      type: "text",
      when: contextWanted,
      prompt: "How many other roles does it hand work to or take work from? 0 if none.",
      validateText: count,
    },
  ],
};

/** The profile the answers describe, or undefined when the person wanted no advice. */
export function profileFrom(answers: Answers): ContextProfile | undefined {
  if (!contextWanted(answers)) return undefined;
  const size = REFERENCE_SIZE[answers.text("context_reference_size")] ?? "none";
  const changes = REFERENCE_CHANGES[answers.text("context_reference_changes")];
  const number = (key: string) => answers.number(key) ?? 0;
  return {
    speed: SPEED[answers.text("context_speed")] ?? "back_office",
    reference_size: size,
    ...(size === "none"
      ? {}
      : {
          ...(changes === undefined ? {} : { reference_changes: changes }),
          reference_business_specific: answers.yes("context_reference_business"),
          reference_tables: answers.yes("context_reference_tables"),
        }),
    figures: answers.yes("context_figures"),
    task_length: TASK_LENGTH[answers.text("context_task_length")] ?? "minutes",
    tool_calls: number("context_tool_calls"),
    large_results: answers.yes("context_large_results"),
    fan_out: number("context_fan_out"),
    document_pages: number("context_document_pages"),
    extracted_fields: answers.yes("context_extracted"),
    strict_format: answers.yes("context_strict_format"),
    recurring_contacts: answers.yes("context_contacts"),
    hand_offs: number("context_hand_offs"),
  };
}

/** The advisor's recommendations for the answers, or none when the person wanted no advice. */
export function recommendationsFrom(answers: Answers): Recommendation[] {
  const profile = profileFrom(answers);
  return profile === undefined
    ? []
    : recommendContext(profile, { tools: answers.list("tools").length });
}

/** One question per built technique: asked when its rule fires, with the rule's reason as help. */
const acceptQuestions: Question[] = CONTEXT_RULES.filter((rule) => isBuilt(rule.technique)).map(
  (rule) => ({
    id: acceptKey(rule.id),
    path: "context_plan",
    type: "yes-no",
    optional: true,
    when: (answers) =>
      recommendationsFrom(answers).some((recommendation) => recommendation.rule === rule.id),
    prompt: `${ACCEPT_PROMPTS[rule.technique] ?? rule.recommends} ${BLANK_IS_NO}`,
    help: (answers) =>
      recommendationsFrom(answers).find((recommendation) => recommendation.rule === rule.id)
        ?.reason ?? "",
  }),
);

export const CONTEXT_PLAN_STEP: InterviewStep = {
  id: "context_plan",
  title: "9. The context plan (optional)",
  intro:
    "Here is the advice. Some of it cannot be switched on yet; it is listed with its reason so you " +
    "know it is coming. For the rest, say yes to each piece you want.",
  optional: true,
  notes: (answers) =>
    recommendationsFrom(answers)
      .filter((recommendation) => recommendation.unavailable !== undefined)
      .map(
        (recommendation) =>
          `  ${recommendation.rule}, ${recommendation.recommends}: ${recommendation.reason} ` +
          `(${recommendation.unavailable})`,
      ),
  questions: acceptQuestions,
};

/**
 * The spec's `context_plan`: every recommendation, accepted only when it is built and the person said
 * yes, so the spec records the advice that could not be taken as well as the advice that was.
 */
export function planFrom(answers: Answers): ContextPlanEntry[] | undefined {
  const recommendations = recommendationsFrom(answers);
  if (recommendations.length === 0) return undefined;
  return recommendations.map((recommendation) => ({
    rule: recommendation.rule,
    technique: recommendation.technique,
    reason: recommendation.reason,
    accepted: isBuilt(recommendation.technique) && answers.yes(acceptKey(recommendation.rule)),
    ...(recommendation.config === undefined ? {} : { config: recommendation.config }),
  }));
}
