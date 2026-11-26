/**
 * The role bundle a role package's factory returns, and `checkAgent`, which confirms it matches the
 * package's `officehum.json`. A role bundle is plain Pi Durable objects: it installs into any harness.
 */

import type { AgentChange, Extension } from "@earendil-works/pi-durable";
import { APPROVED_VALUE_ARG, type ApprovalFactsReader, isApprovalGate } from "./approvals.js";
import { stableSectionProblems } from "./context/stable-sections.js";
import { type Issue, show, type Validation } from "./issues.js";
import {
  type AgentManifest,
  DEFAULT_PROMPT_BUDGET_TOKENS,
  SDK_TOOL_NAMES,
  subagentIssues,
} from "./manifest.js";

/** Pi Durable renders the agent's `instructions` under this section key; roles may not use it. */
export const INSTRUCTIONS_SECTION_KEY = "instructions";

/**
 * What a role package's default export returns.
 *
 * ```ts
 * const role = bookkeeper({ quickbooks });
 * for (const extension of role.extensions) registry.install(extension);
 * const root = await harness.root(context, { agent: role.agent });
 * ```
 */
export interface RoleBundle {
  /** The role extension first, named after the manifest `id`; then one per skill that brings tools. */
  readonly extensions: readonly Extension[];
  /** Recommended Pi Durable agent settings: the default model and the extensions to select. */
  readonly agent: AgentChange;
}

/** The default export of a role package. */
export type RoleFactory<Options> = (options: Options) => RoleBundle;

/** The name of a skill's extension: `<role id>.<skill id>`. */
export function skillExtensionName(roleId: string, skillId: string): string {
  return `${roleId}.${skillId}`;
}

const SOURCE = "role";

/** How `checkAgent` judges what the issues that can be warnings depend on. */
export interface CheckAgentOptions {
  /**
   * Every issue an error, following `checkFourLayers`' rule: a role under `agents/`, or one the Role
   * Factory generated. Otherwise the stable-prompt budget finding is a warning, while every other
   * issue stays an error.
   */
  readonly strict?: boolean;
  /**
   * The ids of the tool packs the role was given. A tool the manifest declares from one
   * of them must be offered; one from a pack not given must not be required, since the role was
   * loaded without it. Omitted: none was given.
   */
  readonly packs?: readonly string[];
}

/**
 * Checks a role bundle, as its factory returns it with no overlays, against its manifest: extension
 * names, each extension's tools and their `replay` policy, the arguments its completion evidence
 * passes, the approval gate, reserved section keys,
 * the recommended agent settings, its declared sub-agents' references, the size of its stable
 * prompt, and that its stable sections render the same under any clock (see `context/`).
 *
 * Async because it renders the role's prompt sections to measure them; `PromptSection.render` may
 * return a promise.
 */
export async function checkAgent(
  bundle: RoleBundle,
  manifest: AgentManifest,
  options: CheckAgentOptions = {},
): Promise<Validation<RoleBundle>> {
  const issues: Issue[] = [];
  const add = (path: string, message: string) => issues.push({ source: SOURCE, path, message });

  // Which extension should provide each declared tool: the role's own, or its skill's.
  const extensionFor = (skill: string | undefined) =>
    skill === undefined ? manifest.id : skillExtensionName(manifest.id, skill);
  // A pack tool is offered only when the host gave the role its pack.
  const givenPacks = new Set(options.packs ?? []);
  const offered = manifest.tools.filter(
    (tool) => tool.pack === undefined || givenPacks.has(tool.pack),
  );
  // Only skills that bring tools need an extension; instruction-only skills are files.
  const toolSkills = new Set(
    offered.flatMap((tool) => (tool.skill === undefined ? [] : [tool.skill])),
  );
  const expectedExtensions = [manifest.id, ...[...toolSkills].map((skill) => extensionFor(skill))];
  const sdkTools = new Set<string>(SDK_TOOL_NAMES);
  const declared = new Map(manifest.tools.map((tool) => [tool.name, tool]));

  const [first] = bundle.extensions;
  if (first === undefined) {
    add("extensions", "is empty; the role extension must come first");
    return { ok: false, issues };
  }
  if (first.name !== manifest.id) {
    add(
      "extensions[0]",
      `must be the role extension ${show(manifest.id)} (got ${show(first.name)})`,
    );
  }

  const seen = new Set<string>();
  for (const extension of bundle.extensions) {
    if (seen.has(extension.name)) add(extension.name, "is returned more than once");
    seen.add(extension.name);
    if (!expectedExtensions.includes(extension.name)) {
      add(
        extension.name,
        `is not the role or one of its declared skills (expected ${expectedExtensions.map(show).join(", ")})`,
      );
      continue;
    }

    for (const tool of extension.tools ?? []) {
      const path = `${extension.name} › ${tool.name}`;
      // read_skill comes from defineRole, not from the manifest.
      if (extension.name === manifest.id && sdkTools.has(tool.name)) continue;
      const declaration = declared.get(tool.name);
      if (declaration === undefined) {
        add(path, "is not declared in officehum.json");
        continue;
      }
      const owner = extensionFor(declaration.skill);
      if (owner !== extension.name) {
        add(path, `is declared in officehum.json as part of ${show(owner)}`);
      }
      if (tool.replay === undefined) {
        add(
          path,
          `must set replay explicitly ("${declaration.replay}" in officehum.json); Pi Durable would default to "unsafe"`,
        );
      } else if (tool.replay !== declaration.replay) {
        add(
          path,
          `replay is ${show(tool.replay)} in code but ${show(declaration.replay)} in officehum.json`,
        );
      }
    }

    for (const promptSection of extension.sections ?? []) {
      if (promptSection.key === INSTRUCTIONS_SECTION_KEY) {
        add(
          `${extension.name} › sections`,
          `must not use the key "${INSTRUCTIONS_SECTION_KEY}"; Pi Durable reserves it for the customer's instructions`,
        );
      }
    }
  }

  for (const name of expectedExtensions) {
    if (!seen.has(name)) add(name, "is declared in officehum.json but not returned by the factory");
  }

  const provided = new Set(
    bundle.extensions.flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name)),
  );
  for (const tool of offered) {
    if (!provided.has(tool.name))
      add(
        `${extensionFor(tool.skill)} › ${tool.name}`,
        "is declared in officehum.json but no extension provides it",
      );
  }

  if (manifest.approvals.length > 0 && !(first.hooks ?? []).some(isApprovalGate)) {
    add(
      `${first.name} › hooks`,
      "must include approvalGate(), because officehum.json declares approvals",
    );
  }

  approvalAmountIssues(bundle, manifest, add);
  approvalValueIssues(bundle, manifest, add);
  evidenceArgumentIssues(bundle, manifest, add);
  checkAgentSettings(bundle.agent, manifest, toolSkills, add);
  // `validateManifest` applies the same rules; a manifest built in code reaches only this check.
  subagentIssues(manifest, add);
  await promptBudgetIssues(bundle, manifest, options.strict ?? false, issues);
  for (const problem of stableSectionProblems(first)) {
    add(`${first.name} › sections › ${problem.key}`, problem.message);
  }

  // A warning leaves the role valid, as in the four-layer check; anything else refuses it.
  const errors = issues.filter((issue) => issue.severity !== "warning");
  return errors.length > 0 ? { ok: false, issues } : { ok: true, value: bundle, issues };
}

/**
 * Money approvals declare their amount. An approver's `approvalLimit` is compared with the
 * approval's amount; with none, a limited approver is refused and the real figure is never checked.
 * So an approval on an unsafe tool whose facts reader states a `…Cents` field must declare `amount`,
 * and an amount read from the facts must name a fact its reader states. Only the code knows the
 * readers, which is why this is not in `validateManifest`.
 */
function approvalAmountIssues(
  bundle: RoleBundle,
  manifest: AgentManifest,
  add: (path: string, message: string) => void,
): void {
  const readers = (bundle as { approvalFacts?: Readonly<Record<string, ApprovalFactsReader>> })
    .approvalFacts;
  const replay = new Map(manifest.tools.map((tool) => [tool.name, tool.replay]));
  manifest.approvals.forEach((approval, index) => {
    const reader = readers?.[approval.id];
    const fields = reader?.fields ?? [];
    const amount = approval.amount;
    if (amount !== undefined && "fact" in amount) {
      if (reader === undefined) {
        add(
          `approvals[${index}].amount.fact`,
          `${show(approval.id)} has no facts reader to read ${show(amount.fact)} from; give it one with approvalFacts, or read the amount from an argument`,
        );
      } else if (reader.fields !== undefined && !fields.includes(amount.fact)) {
        add(
          `approvals[${index}].amount.fact`,
          `${show(amount.fact)} is not a fact the ${show(approval.id)} reader declares (it declares ${fields.map(show).join(", ")})`,
        );
      }
      return;
    }
    // An approval that asks for a value has its limit compared with the value entered,
    // so an amount is only its proposal, never required.
    if (amount !== undefined || approval.value !== undefined) return;
    if (replay.get(approval.tool) !== "unsafe") return;
    const cents = fields.find((field) => field.endsWith("Cents"));
    if (cents === undefined) return;
    add(
      `approvals[${index}].amount`,
      `is missing: ${show(approval.id)} gates the unsafe tool ${show(approval.tool)} and its facts carry ${show(cents)}, so an approver's limit would never be checked against it; declare { "fact": ${show(cents)} } (or the fact that is the amount approved)`,
    );
  });
}

/**
 * An approval that asks the person for a value: its fact bounds are read by its facts
 * reader, so they must be facts the reader states, as for `amount.fact`; and its tool reads the value
 * through `approvedValue`, so its parameters declare `APPROVED_VALUE_ARG`
 * (`approvedValueParameter()`), or Pi Durable refuses every approved call's rewritten arguments.
 */
function approvalValueIssues(
  bundle: RoleBundle,
  manifest: AgentManifest,
  add: (path: string, message: string) => void,
): void {
  const readers = (bundle as { approvalFacts?: Readonly<Record<string, ApprovalFactsReader>> })
    .approvalFacts;
  const parameters = toolParameters(bundle);
  manifest.approvals.forEach((approval, index) => {
    const value = approval.value;
    if (value === undefined) return;
    const reader = readers?.[approval.id];
    for (const side of ["minFact", "maxFact"] as const) {
      const fact = value[side];
      if (fact === undefined) continue;
      const at = `approvals[${index}].value.${side}`;
      if (reader === undefined) {
        add(
          at,
          `${show(approval.id)} has no facts reader to read ${show(fact)} from; give it one with approvalFacts, or use a fixed bound`,
        );
      } else if (reader.fields !== undefined && !reader.fields.includes(fact)) {
        add(
          at,
          `${show(fact)} is not a fact the ${show(approval.id)} reader declares (it declares ${reader.fields.map(show).join(", ")})`,
        );
      }
    }
    const takes = parameters.get(approval.tool);
    if (takes !== undefined && !takes.includes(APPROVED_VALUE_ARG)) {
      add(
        `approvals[${index}].value`,
        `${show(approval.tool)} does not declare ${show(APPROVED_VALUE_ARG)}; add it with approvedValueParameter() and read the value with approvedValue(args, ${show(value.name)})`,
      );
    }
  });
}

/** Each tool's parameter names, for the tools whose parameters are an object schema. */
function toolParameters(bundle: RoleBundle): Map<string, readonly string[]> {
  const parameters = new Map<string, readonly string[]>();
  for (const extension of bundle.extensions) {
    for (const tool of extension.tools ?? []) {
      const properties = (tool.parameters as { properties?: unknown }).properties;
      // A tool whose parameters are not an object schema names nothing to check against.
      if (typeof properties === "object" && properties !== null) {
        parameters.set(tool.name, Object.keys(properties));
      }
    }
  }
  return parameters;
}

/**
 * Completion evidence runs a tool with the arguments the manifest names. An argument the tool does
 * not take is refused by its schema or ignored, so the check could never pass or would not test what
 * it says; only the code knows a tool's parameters, which is why this is not in `validateManifest`.
 */
function evidenceArgumentIssues(
  bundle: RoleBundle,
  manifest: AgentManifest,
  add: (path: string, message: string) => void,
): void {
  const parameters = toolParameters(bundle);
  manifest.accepts.forEach((accept, index) => {
    accept.done?.forEach((entry, doneIndex) => {
      if (!("tool" in entry) || entry.args === undefined) return;
      const takes = parameters.get(entry.tool);
      if (takes === undefined) return;
      for (const name of Object.keys(entry.args)) {
        if (takes.includes(name)) continue;
        add(
          `accepts[${index}].done[${doneIndex}].args.${name}`,
          `${show(entry.tool)} takes no ${show(name)} (it takes ${takes.length === 0 ? "no arguments" : takes.map(show).join(", ")}), so this evidence could never pass; pass an argument the tool declares`,
        );
      }
    });
  });
}

function checkAgentSettings(
  agent: AgentChange,
  manifest: AgentManifest,
  toolSkills: ReadonlySet<string>,
  add: (path: string, message: string) => void,
) {
  const { provider, modelId, thinkingLevel } = manifest.defaultModel;
  if (agent.model?.provider !== provider || agent.model.modelId !== modelId) {
    add(
      "agent.model",
      `must be the manifest's defaultModel ${show({ provider, modelId })} (got ${show(agent.model ?? null)})`,
    );
  }
  if (thinkingLevel !== undefined && agent.thinkingLevel !== thinkingLevel) {
    add(
      "agent.thinkingLevel",
      `must be ${show(thinkingLevel)} as in officehum.json (got ${show(agent.thinkingLevel ?? null)})`,
    );
  }

  if (!Array.isArray(agent.extensions)) {
    add(
      "agent.extensions",
      "must list the extensions to select: the role, then its skills enabled by default",
    );
    return;
  }
  const selected = new Set(
    (agent.extensions as readonly Extension[]).map((extension) => extension.name),
  );
  if (!selected.has(manifest.id))
    add("agent.extensions", `must select the role extension ${show(manifest.id)}`);
  for (const skill of manifest.skills) {
    if (!toolSkills.has(skill.id)) continue;
    const name = skillExtensionName(manifest.id, skill.id);
    if (skill.enabledByDefault && !selected.has(name)) {
      add("agent.extensions", `must select ${show(name)}, which officehum.json enables by default`);
    }
    if (!skill.enabledByDefault && selected.has(name)) {
      add(
        "agent.extensions",
        `must not select ${show(name)}, which officehum.json leaves off by default`,
      );
    }
  }
}

/**
 * Measures the role's stable prompt — its own sections, without any host extension's — as characters
 * ÷ 4, and reports it when it is over the role's budget. A warning, or an error under `strict`.
 */
async function promptBudgetIssues(
  bundle: RoleBundle,
  manifest: AgentManifest,
  strict: boolean,
  issues: Issue[],
): Promise<void> {
  const [role] = bundle.extensions;
  if (role?.sections === undefined) return;
  const texts: string[] = [];
  for (const promptSection of role.sections) {
    const rendered = await promptSection.render({} as never, {} as never);
    if (typeof rendered === "string" && rendered.trim() !== "") texts.push(rendered);
  }
  const characters = texts.join("\n").length;
  const tokens = Math.ceil(characters / 4);
  const budget = manifest.contextPlan?.promptBudgetTokens ?? DEFAULT_PROMPT_BUDGET_TOKENS;
  if (tokens <= budget) return;
  issues.push({
    source: SOURCE,
    path: "prompt",
    severity: strict ? "error" : "warning",
    message: `is about ${tokens} tokens (${characters} characters ÷ 4); keep the role's stable prompt under its contextPlan.promptBudgetTokens of ${budget}, moving detail into a skill or one of its reference files`,
  });
}
