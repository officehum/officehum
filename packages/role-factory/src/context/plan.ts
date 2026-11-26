/**
 * The `context_plan` block of `ROLE_SPEC.md`: one entry per recommendation the advisor made, each with
 * the rule behind it, its reason, and whether a person accepted it. The accepted entries become the
 * manifest's `contextPlan`, so the SDK's built patterns act on them.
 *
 * There is no second schema: an entry's `config` is checked against the SDK's own schema for the
 * `contextPlan` field its technique names, and the merged tools and plan go through the SDK's own
 * `context_recall` rule. See docs/design/role-spec.md, "The context plan".
 */

import {
  type AgentManifest,
  CONTEXT_RECALL_TOOL,
  type ContextPlanDeclaration,
  contextRecallIssues,
  type Issue,
  joinPath,
  ManifestSchema,
  schemaIssues,
  show,
} from "@officehum/sdk";
import { type Static, Type } from "typebox";
import { contextRule, isBuilt, TECHNIQUES } from "./advisor.js";

/** The `contextPlan` field schemas of the SDK, by field name. */
const PLAN_FIELDS = ManifestSchema.properties.contextPlan.properties;

/** One recommendation in the spec: the rule, its technique and reason, and the person's decision. */
export const ContextPlanEntrySchema = Type.Object(
  {
    rule: Type.String({ pattern: "^C[0-9]+$", "x-hint": 'a rule id, like "C6"' }),
    technique: Type.Enum([...TECHNIQUES]),
    /** Why, in words a person reviews; quotes the profile. No technique is enabled without one. */
    reason: Type.String({ minLength: 1, maxLength: 400 }),
    accepted: Type.Boolean(),
    /** The `contextPlan` value of a built technique; checked against the SDK's schema for it. */
    config: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export const ContextPlanSchema = Type.Array(ContextPlanEntrySchema);
export type ContextPlanEntry = Static<typeof ContextPlanEntrySchema>;

/** The block's path in the spec. */
export const CONTEXT_PLAN_PATH = "context_plan";

/** The manifest's `contextPlan` from the accepted entries, or undefined when none is accepted. */
export function contextPlanOf(
  entries: readonly ContextPlanEntry[] | undefined,
): ContextPlanDeclaration | undefined {
  const accepted = (entries ?? []).filter((entry) => entry.accepted && isBuilt(entry.technique));
  if (accepted.length === 0) return undefined;
  return Object.fromEntries(
    accepted.map((entry) => [entry.technique, entry.config]),
  ) as ContextPlanDeclaration;
}

/**
 * The role's tools as the manifest declares them: `context_recall` is added when the plan turns on
 * the relevance filter, whose stubs point at it, unless the spec already declares it.
 */
export function toolsWithPlan<T extends { readonly name: string }>(
  tools: readonly T[],
  plan: ContextPlanDeclaration | undefined,
): (T | { name: string; replay: "safe" })[] {
  if (plan?.historyFilter === undefined || tools.some((tool) => tool.name === CONTEXT_RECALL_TOOL))
    return [...tools];
  return [...tools, { name: CONTEXT_RECALL_TOOL, replay: "safe" }];
}

/**
 * The problems of a `context_plan` the schema has accepted the shape of: an unknown rule, a technique
 * that is not its rule's, an accepted technique that is not built, config where none belongs or
 * missing where it does, config the SDK's schema refuses, a technique accepted twice, and the SDK's
 * own `context_recall` rule over the merged tools and plan.
 */
export function contextPlanIssues(
  entries: readonly unknown[],
  roleTools: readonly unknown[],
  source: string,
): Issue[] {
  const issues: Issue[] = [];
  const add = (path: string, message: string) => issues.push({ source, path, message });
  const acceptedAt = new Map<string, number>();

  entries.forEach((value, index) => {
    if (value === null || typeof value !== "object") return;
    const entry = value as Partial<ContextPlanEntry>;
    const at = joinPath(CONTEXT_PLAN_PATH, index);
    const technique = typeof entry.technique === "string" ? entry.technique : undefined;
    const rule = typeof entry.rule === "string" ? contextRule(entry.rule) : undefined;
    if (typeof entry.rule === "string" && rule === undefined) {
      add(joinPath(at, "rule"), `${show(entry.rule)} is not a rule of the context advisor`);
    } else if (rule !== undefined && technique !== undefined && rule.technique !== technique) {
      add(
        joinPath(at, "technique"),
        `rule ${rule.id} recommends ${show(rule.technique)}, not ${show(technique)}`,
      );
    }
    // A technique the schema refused is the schema's to report.
    if (technique === undefined || !(TECHNIQUES as readonly string[]).includes(technique)) return;

    if (!isBuilt(technique)) {
      const why =
        rule !== undefined && "unavailable" in rule.plan
          ? rule.plan.unavailable
          : "not available yet";
      if (entry.accepted === true) {
        add(
          joinPath(at, "accepted"),
          `${show(technique)} cannot be switched on: ${why}; set accepted to false`,
        );
      }
      if (entry.config !== undefined) {
        add(joinPath(at, "config"), `${show(technique)} has nothing to configure: ${why}`);
      }
      return;
    }

    if (entry.config === undefined) {
      add(at, `${show(technique)} needs its config: the value contextPlan.${technique} is given`);
    } else {
      for (const issue of schemaIssues(PLAN_FIELDS[technique], entry.config, source)) {
        issues.push({ ...issue, path: joinPath(joinPath(at, "config"), issue.path) });
      }
    }
    if (entry.accepted === true) {
      const first = acceptedAt.get(technique);
      if (first !== undefined) {
        add(
          joinPath(at, "accepted"),
          `${show(technique)} is already accepted at ${joinPath(CONTEXT_PLAN_PATH, first)}; accept it once`,
        );
      } else acceptedAt.set(technique, index);
    }
  });

  if (issues.length > 0) return issues;
  // The SDK's rule reads only the tools and the plan. A spec states the filter in the plan and the
  // generator adds the tool, so what is left for it to refuse is a context_recall declared by hand.
  const plan = contextPlanOf(entries as ContextPlanEntry[]);
  const tools = toolsWithPlan(
    roleTools.filter(
      (tool): tool is { name: string } =>
        tool !== null &&
        typeof tool === "object" &&
        typeof (tool as { name?: unknown }).name === "string",
    ),
    plan,
  );
  const fragment = { tools, ...(plan === undefined ? {} : { contextPlan: plan }) };
  contextRecallIssues(fragment as unknown as AgentManifest, (path, message) => {
    const filterAt = acceptedAt.get("historyFilter");
    add(
      path === "contextPlan.historyFilter" && filterAt !== undefined
        ? joinPath(CONTEXT_PLAN_PATH, filterAt)
        : path.replace(/^tools/, "role.tools"),
      message,
    );
  });
  return issues;
}
