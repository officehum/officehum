/**
 * The context advisor: from a role's context profile — the short account of its work the interview
 * gathers — to the context-engineering techniques that fit it, each with a reason a person can read
 * and accept or decline in `ROLE_SPEC.md`.
 *
 * It is a rule table and nothing else: no model is asked, so the same profile always gives the same
 * advice, and every rule can be tested on the profile that triggers it and one that does not.
 *
 * **Only built techniques can be switched on.** A rule whose technique the SDK acts on today carries
 * the `contextPlan` config it recommends. A rule whose technique has no runtime yet is still shown,
 * with its reason, and says why it cannot be accepted: it is not available yet, or the block of the
 * spec already carries it. See docs/design/role-spec.md, "The context plan".
 */

import { DEFAULT_PROMPT_BUDGET_TOKENS } from "@officehum/sdk";
import { type Static, Type } from "typebox";

const Count = Type.Integer({ minimum: 0 });

export const SPEEDS = ["real_time", "back_office"] as const;
export const REFERENCE_SIZES = ["none", "small", "large"] as const;
export const REFERENCE_CHANGES = ["rarely", "often"] as const;
export const TASK_LENGTHS = ["minutes", "hours", "days"] as const;

/**
 * The `context_profile` block: what the interview learned about how the role works, in the terms the
 * rules read. The number of tools is not here: the rules read it from `role.tools`.
 */
export const ContextProfileSchema = Type.Object(
  {
    /** Whether it answers customers in real time or works in the back office. */
    speed: Type.Enum([...SPEEDS]),
    /** How much reference material it works from: none, a few pages (about 8,000 tokens), or more. */
    reference_size: Type.Enum([...REFERENCE_SIZES]),
    /** How often the material changes: quarterly or less (`rarely`), monthly or more (`often`). */
    reference_changes: Type.Optional(Type.Enum([...REFERENCE_CHANGES])),
    /** Whether any of it is specific to one business. */
    reference_business_specific: Type.Optional(Type.Boolean()),
    /** Whether some of its facts are tables: rates, price lists, thresholds. */
    reference_tables: Type.Optional(Type.Boolean()),
    /** Whether its answers contain exact figures. */
    figures: Type.Boolean(),
    task_length: Type.Enum([...TASK_LENGTHS]),
    /** Tool calls a typical task takes. */
    tool_calls: Count,
    /** Whether its tools return long results: whole documents, long lists. */
    large_results: Type.Boolean(),
    /** The most similar items one task covers; 0 when a task is about one thing. */
    fan_out: Count,
    /** The longest document it reads, in pages; 0 when it reads none. */
    document_pages: Count,
    /** Whether it fills in fields or forms from what it reads. */
    extracted_fields: Type.Boolean(),
    /** Whether it writes in a strict format: letters, statements. */
    strict_format: Type.Boolean(),
    /** Whether it deals with the same people again and again. */
    recurring_contacts: Type.Boolean(),
    /** How many other roles it hands work to or takes work from. */
    hand_offs: Count,
  },
  { additionalProperties: false },
);

export type ContextProfile = Static<typeof ContextProfileSchema>;

/**
 * The techniques the rules recommend. The three a role can switch on today are `contextPlan` field
 * names, so an accepted entry's config is that field's value; the others are named the same way for
 * the ones that are manifest fields not acted on yet, and in plain words for the rest.
 */
export const TECHNIQUES = [
  "promptBudgetTokens",
  "skillReferences",
  "retrieval",
  "engineTables",
  "maskAmounts",
  "historyFilter",
  "subagents",
  "structuredOutput",
  "modelTiers",
  "memorySubjects",
  "toolGroups",
  "dispatches",
  "documentTemplates",
] as const;
export type Technique = (typeof TECHNIQUES)[number];

/** The techniques with a runtime today: the ones a person can accept into the plan. */
export const BUILT_TECHNIQUES = ["promptBudgetTokens", "maskAmounts", "historyFilter"] as const;
export type BuiltTechnique = (typeof BUILT_TECHNIQUES)[number];

export function isBuilt(technique: string): technique is BuiltTechnique {
  return (BUILT_TECHNIQUES as readonly string[]).includes(technique);
}

/** What the rules read about the role besides its profile. */
export interface RoleFacts {
  /** How many tools the role declares. */
  readonly tools: number;
}

/** One rule of the table. */
export interface ContextRule {
  readonly id: string;
  readonly technique: Technique;
  /** The condition, in words, as the rule table in the docs states it. */
  readonly when: string;
  /** What it recommends, in words. */
  readonly recommends: string;
  readonly fires: (profile: ContextProfile, role: RoleFacts) => boolean;
  /** One sentence a non-developer can read, quoting the profile. */
  readonly reason: (profile: ContextProfile, role: RoleFacts) => string;
  /**
   * The `contextPlan` value a built technique is switched on with, or why the technique cannot be
   * switched on: it is not available yet, or the spec already carries it.
   */
  readonly plan:
    | { readonly config: (profile: ContextProfile) => unknown }
    | { readonly unavailable: string };
}

/** One recommendation: a rule that fired, with its reason and what accepting it would write. */
export interface Recommendation {
  readonly rule: string;
  readonly technique: Technique;
  readonly recommends: string;
  readonly reason: string;
  /** The `contextPlan` value; present exactly when the technique is built. */
  readonly config?: unknown;
  /** Why it cannot be accepted; present exactly when the technique is not built. */
  readonly unavailable?: string;
}

/** The prompt budget for a role that answers customers while they wait. */
export const REAL_TIME_PROMPT_BUDGET_TOKENS = 3000;

/**
 * The relevance filter the advisor recommends: the values the SDK's own long-session test runs with.
 * A first guess of "keep 3 rounds, stub results over 1,500 tokens" cannot hold a long session to a
 * 4,000-token budget — three whole rounds of results that size exceed it, and smaller results are
 * never stubbed.
 */
export const RECOMMENDED_HISTORY_FILTER = {
  keepRecentRounds: 2,
  keepCitedIds: true,
  maxToolResultTokens: 200,
} as const;

/** Past this many tool calls a task's history is filtered (C6). */
export const LONG_TASK_TOOL_CALLS = 20;
/** At this many similar items a task fans out (C7). */
export const FAN_OUT_ITEMS = 20;
/** Past this many pages a document is long (C7). */
export const LONG_DOCUMENT_PAGES = 30;
/** Past this many tools a role groups them (C11). */
export const MANY_TOOLS = 15;
/** At this many roles a role's hand-offs are declared (C12). */
export const MANY_HAND_OFFS = 3;

const NOT_YET = "not available yet";

const realTime = (profile: ContextProfile) => profile.speed === "real_time";
const budgetOf = (profile: ContextProfile) =>
  realTime(profile) ? REAL_TIME_PROMPT_BUDGET_TOKENS : DEFAULT_PROMPT_BUDGET_TOKENS;
const hasReference = (profile: ContextProfile) => profile.reference_size !== "none";
const tokens = (count: number) => count.toLocaleString("en-US");

/** The rule table, in the order the advice is given. */
export const CONTEXT_RULES: readonly ContextRule[] = [
  {
    id: "C1",
    technique: "promptBudgetTokens",
    when: "always",
    recommends:
      "stable prompt sections, skills read only as needed, and a budget for the prompt sent every turn: 4,000 tokens, or 3,000 for a role that answers customers in real time",
    fires: () => true,
    reason: (profile) =>
      realTime(profile)
        ? `It answers customers in real time, so the prompt it sends every turn is held to ${tokens(budgetOf(profile))} tokens and its skills are read only as needed.`
        : `Every role keeps the prompt it sends every turn small and stable, so it is held to ${tokens(budgetOf(profile))} tokens and its skills are read only as needed.`,
    plan: { config: budgetOf },
  },
  {
    id: "C2",
    technique: "skillReferences",
    when: "the reference material is small (about 8,000 tokens in all), changes quarterly or less, and is not specific to one business",
    recommends: "skill references, one file per topic",
    // Material specific to one business never goes into the role itself, which every business
    // installs: that is C3's, through retrieval.
    fires: (profile) =>
      profile.reference_size === "small" &&
      profile.reference_changes === "rarely" &&
      profile.reference_business_specific !== true,
    reason: () =>
      "Its reference material is a few pages and changes quarterly or less, so it fits in skill reference files the role opens when it needs them.",
    plan: {
      unavailable:
        "nothing to switch on: write the material as reference files of the role's skills (knowledge.skills[].references), one per topic",
    },
  },
  {
    id: "C3",
    technique: "retrieval",
    when: "the reference material is larger, changes monthly or faster, or is specific to the business",
    recommends: "retrieval sources the role searches and cites instead of pasting them in",
    fires: (profile) =>
      profile.reference_size === "large" ||
      (hasReference(profile) &&
        (profile.reference_changes === "often" || profile.reference_business_specific === true)),
    reason: (profile) => {
      const why = [
        ...(profile.reference_size === "large" ? ["is more than a few pages"] : []),
        ...(hasReference(profile) && profile.reference_changes === "often"
          ? ["changes monthly or more often"]
          : []),
        ...(hasReference(profile) && profile.reference_business_specific === true
          ? ["is specific to one business"]
          : []),
      ];
      return `Its reference material ${joinWords(why)}, so it should be searched and cited before answering rather than copied into the role.`;
    },
    plan: { unavailable: NOT_YET },
  },
  {
    id: "C4",
    technique: "engineTables",
    when: "facts are tables (rates, price lists, thresholds)",
    recommends: "data tables in the role's engine, queried by engine tools, never prose",
    fires: (profile) => hasReference(profile) && profile.reference_tables === true,
    reason: () =>
      "Some of its facts are tables, so they belong in the role's engine where a tool looks them up, never in text the model reads and copies.",
    plan: {
      unavailable:
        "nothing to switch on: keep the tables in the role's engine (role.engine) and give it a tool that queries them",
    },
  },
  {
    id: "C5",
    technique: "maskAmounts",
    when: "outputs contain exact figures",
    recommends:
      "amount masking in skills and references, figures from an engine, and a citation for each",
    fires: (profile) => profile.figures,
    reason: () =>
      "Its answers contain exact figures, so sample amounts in its skills are masked and it takes every figure from a tool or the engine, with its source.",
    plan: { config: () => true },
  },
  {
    id: "C6",
    technique: "historyFilter",
    when: `tasks run past about ${LONG_TASK_TOOL_CALLS} tool calls or for days, or tool results are large`,
    recommends:
      "the relevance filter (older long results become one-line stubs it can recall) and compaction that keeps ids",
    fires: (profile) =>
      profile.tool_calls > LONG_TASK_TOOL_CALLS ||
      profile.task_length === "days" ||
      profile.large_results,
    reason: (profile) => {
      const why = [
        ...(profile.tool_calls > LONG_TASK_TOOL_CALLS
          ? [`a task takes about ${profile.tool_calls} tool calls`]
          : []),
        ...(profile.task_length === "days" ? ["a task runs for days"] : []),
        ...(profile.large_results ? ["its tools return long results"] : []),
      ];
      return `${capitalize(joinWords(why))}, so older long results are shortened to a line it can recall, and the ids it cites are kept.`;
    },
    plan: { config: () => ({ ...RECOMMENDED_HISTORY_FILTER }) },
  },
  {
    id: "C7",
    technique: "subagents",
    when: `a task fans out over ${FAN_OUT_ITEMS} or more similar items, or documents run past about ${LONG_DOCUMENT_PAGES} pages`,
    recommends:
      "a sub-agent per kind of item: small model, tools that change nothing, an output schema",
    fires: (profile) =>
      profile.fan_out >= FAN_OUT_ITEMS || profile.document_pages > LONG_DOCUMENT_PAGES,
    reason: (profile) => {
      const why = [
        ...(profile.fan_out >= FAN_OUT_ITEMS
          ? [`a task covers up to ${profile.fan_out} similar items`]
          : []),
        ...(profile.document_pages > LONG_DOCUMENT_PAGES
          ? [`it reads documents of up to ${profile.document_pages} pages`]
          : []),
      ];
      return `${capitalize(joinWords(why))}, so each item or document is better read by a narrow worker that returns a fixed shape.`;
    },
    plan: { unavailable: NOT_YET },
  },
  {
    id: "C8",
    technique: "structuredOutput",
    when: "outputs are extracted fields or forms",
    recommends: "structured output schemas and checked extraction",
    fires: (profile) => profile.extracted_fields,
    reason: () =>
      "It fills in fields from what it reads, so each result should match a fixed shape and be checked before it is used.",
    plan: { unavailable: NOT_YET },
  },
  {
    id: "C9",
    technique: "modelTiers",
    when: "the role talks to customers in real time",
    recommends:
      "the small model for triage and classification, and no sub-agents in the reply path",
    fires: realTime,
    reason: () =>
      "It answers customers while they wait, so quick sorting can run on the small model and nothing slow sits between a message and its reply.",
    plan: { unavailable: NOT_YET },
  },
  {
    id: "C10",
    technique: "memorySubjects",
    when: "recurring contacts",
    recommends: "memory of the people it deals with",
    fires: (profile) => profile.recurring_contacts,
    reason: () =>
      "It deals with the same people again and again, so it should remember what it learned about each of them.",
    plan: { unavailable: NOT_YET },
  },
  {
    id: "C11",
    technique: "toolGroups",
    when: `more than ${MANY_TOOLS} tools`,
    recommends: "tool groups by ticket type, so each task sees only the tools it needs",
    fires: (_profile, role) => role.tools > MANY_TOOLS,
    reason: (_profile, role) =>
      `It has ${role.tools} tools, so each kind of work should see only the tools it needs.`,
    plan: { unavailable: NOT_YET },
  },
  {
    id: "C12",
    technique: "dispatches",
    when: `hand-offs with ${MANY_HAND_OFFS} or more roles`,
    recommends:
      "a declared hand-off for each, and a note that the office directory lists colleagues",
    fires: (profile) => profile.hand_offs >= MANY_HAND_OFFS,
    reason: (profile) =>
      `It hands work to or takes work from ${profile.hand_offs} other roles, so each hand-off should be declared by the kind of work it passes.`,
    plan: { unavailable: NOT_YET },
  },
  {
    id: "C13",
    technique: "documentTemplates",
    when: "outputs follow a strict format (letters, statements)",
    recommends: "document templates, and examples in references with amounts masked",
    fires: (profile) => profile.strict_format,
    reason: () =>
      "It writes in a strict format, so it should fill in a template rather than write each document from scratch.",
    plan: { unavailable: NOT_YET },
  },
];

/** The rule with this id, if the table has one. */
export function contextRule(id: string): ContextRule | undefined {
  return CONTEXT_RULES.find((rule) => rule.id === id);
}

/** Every rule that fires on the profile, in table order, with its reason and what it would write. */
export function recommendContext(profile: ContextProfile, role: RoleFacts): Recommendation[] {
  return CONTEXT_RULES.filter((rule) => rule.fires(profile, role)).map((rule) => ({
    rule: rule.id,
    technique: rule.technique,
    recommends: rule.recommends,
    reason: rule.reason(profile, role),
    ...("config" in rule.plan
      ? { config: rule.plan.config(profile) }
      : { unavailable: rule.plan.unavailable }),
  }));
}

/** "a", "a and b", "a, b and c". */
function joinWords(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
