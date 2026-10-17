/**
 * The role bundle a role package's factory returns, and `checkAgent`, which confirms it matches the
 * package's `officehum.json`. A role bundle is plain Pi Durable objects: it installs into any harness.
 */

import type { AgentChange, Extension } from "@earendil-works/pi-durable";
import { isApprovalGate } from "./approvals.js";
import { type Issue, show, type Validation } from "./issues.js";
import { type AgentManifest, DEFAULT_PROMPT_BUDGET_TOKENS, SDK_TOOL_NAMES } from "./manifest.js";

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
}

/**
 * Checks a role bundle, as its factory returns it with no overlays, against its manifest: extension
 * names, each extension's tools and their `replay` policy, the approval gate, reserved section keys,
 * the recommended agent settings, its declared sub-agents' references, and the size of its stable
 * prompt.
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
  // Only skills that bring tools need an extension; instruction-only skills are files.
  const toolSkills = new Set(
    manifest.tools.flatMap((tool) => (tool.skill === undefined ? [] : [tool.skill])),
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
  for (const tool of manifest.tools) {
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

  checkAgentSettings(bundle.agent, manifest, toolSkills, add);
  subagentIssues(manifest, add);
  await promptBudgetIssues(bundle, manifest, options.strict ?? false, issues);

  // A warning leaves the role valid, as in the four-layer check; anything else refuses it.
  const errors = issues.filter((issue) => issue.severity !== "warning");
  return errors.length > 0 ? { ok: false, issues } : { ok: true, value: bundle, issues };
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
 * A sub-agent's declared references must resolve: it runs only the role's declared **safe** tools,
 * and only the role's declared skills.
 */
function subagentIssues(
  manifest: AgentManifest,
  add: (path: string, message: string) => void,
): void {
  const tools = new Map(manifest.tools.map((tool) => [tool.name, tool]));
  const skills = new Set(manifest.skills.map((skill) => skill.id));
  (manifest.contextPlan?.subagents ?? []).forEach((subagent, index) => {
    const at = `contextPlan.subagents[${index}]`;
    subagent.tools.forEach((name, toolIndex) => {
      const tool = tools.get(name);
      if (tool === undefined) {
        add(
          `${at}.tools[${toolIndex}]`,
          `${show(name)} is not a declared tool; a sub-agent runs only the role's declared safe tools`,
        );
      } else if (tool.replay !== "safe") {
        add(
          `${at}.tools[${toolIndex}]`,
          `${show(name)} is unsafe; a sub-agent runs only the role's safe tools, never one that changes something`,
        );
      }
    });
    subagent.skills?.forEach((id, skillIndex) => {
      if (!skills.has(id)) {
        add(`${at}.skills[${skillIndex}]`, `${show(id)} is not a declared skill`);
      }
    });
  });
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
