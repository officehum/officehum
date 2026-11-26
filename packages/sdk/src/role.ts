/**
 * `defineRole` builds a role bundle from the role's files, its overlays and its tools. Everything it
 * returns is plain Pi Durable: the role extension (prompt sections from AGENTS.md, the skill index
 * and APPEND_SYSTEM.md; the role's tools; `read_skill`; the approval gate), one extension per skill
 * that brings tools, and recommended agent settings. A role's entry point is a few lines:
 *
 * ```ts
 * export default function bookkeeper(options: BookkeeperOptions): RoleBundle {
 *   return defineRole({
 *     packageDir: fileURLToPath(new URL("..", import.meta.url)),
 *     manifest,
 *     overlays: options.overlays,
 *     approve: options.approve,
 *     tools: [readInvoices(options.quickbooks), createInvoice(options.quickbooks)],
 *     skillTools: { collections: [sendReminder(options.quickbooks)] },
 *   });
 * }
 * ```
 */

import {
  type AnyTask,
  defineExtension,
  defineTool,
  type Extension,
  type HookRegistration,
  section,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { type RoleBundle, skillExtensionName } from "./agent.js";
import {
  type ApprovalCondition,
  type ApprovalDeclinedHandler,
  type ApprovalFactsReader,
  type Approver,
  approvalGate,
} from "./approvals.js";
import { cliTools } from "./cli-tools.js";
import { withContextPatterns } from "./context/index.js";
import { type Engine, engineTools } from "./engine.js";
import { formatIssue, type Issue } from "./issues.js";
import { validateManifest } from "./manifest.js";
import { type McpClients, mcpTools } from "./mcp.js";
import { type ResolvedRole, resolveRoleFiles } from "./resources.js";
import { readSkillFile } from "./skills.js";
import { todaySection } from "./today.js";
import { packTools, type ToolPack } from "./tool-packs.js";
import { guardToolResult } from "./tool-result.js";

export interface DefineRoleOptions {
  /** The role package's root, e.g. `fileURLToPath(new URL("..", import.meta.url))`. */
  readonly packageDir: string;
  /** The parsed officehum.json, e.g. `import manifest from "../officehum.json" with { type: "json" }`. Validated here. */
  readonly manifest: unknown;
  /** Overlay directories, lowest first: the customer's AGENTS.md, APPEND_SYSTEM.md, skills, settings. */
  readonly overlays?: readonly string[] | undefined;
  /** Overlay skills may hold only instructions and reference files. Default true. */
  readonly instructionsOnly?: boolean;
  /** The role's own tools: those the manifest declares without a `skill`. */
  readonly tools?: readonly ToolRegistration[];
  /**
   * The role's engine, when its manifest declares one: `engineFromManifest(packageDir, manifest, …)`
   * in production, `stubEngine(…)` in tests. `defineRole` builds the manifest's engine tools with it.
   */
  readonly engine?: Engine | undefined;
  /**
   * Connected MCP clients, keyed by the manifest's `mcpServers` id. `defineRole` builds the
   * manifest's MCP tools with them. A declared server with no client still gets its tools, and each
   * call answers "not connected". The role never starts a server.
   */
  readonly mcp?: McpClients | undefined;
  /**
   * The tool packs the host supplies, which a role factory passes on as it receives them.
   * `defineRole` offers each tool the manifest declares from a given pack (`"pack": "data"`), and only
   * those. A declared tool from a pack that is not given is not offered.
   */
  readonly packs?: readonly ToolPack[] | undefined;
  /**
   * Skill folders that extensions the role runs with ship, e.g. `MEMORY_HYGIENE_SKILL` from
   * `@officehum/memory`. They join the role's skills, on by default; a name clash is an error.
   */
  readonly extraSkills?: readonly string[];
  /** Tools that come with a skill, keyed by skill id. */
  readonly skillTools?: Readonly<Record<string, readonly ToolRegistration[]>>;
  /** Decides gated actions. Omitted: they are blocked. */
  readonly approve?: Approver | undefined;
  /** When each approval applies, keyed by approval id. */
  readonly when?: Readonly<Record<string, ApprovalCondition>>;
  /**
   * What each approval asks a person to approve, read from the role's records, keyed by approval id.
   * The gate asks with the facts and, on a yes, passes them to the tool under `APPROVED_FACTS_ARG`.
   */
  readonly approvalFacts?: Readonly<Record<string, ApprovalFactsReader>>;
  /**
   * What each approval's decline undoes, keyed by approval id: run once when a person declines a
   * call the gate asked about, or the request expires (`ApprovalDeclinedHandler`).
   */
  readonly approvalDeclined?: Readonly<Record<string, ApprovalDeclinedHandler>>;
  /** More hooks for the role extension, after the approval gate. */
  readonly hooks?: readonly HookRegistration[];
  /** Durable tasks the role's tools start. */
  readonly tasks?: readonly AnyTask[];
  /**
   * The host's clock. Set, the prompt gains a `today` section rendered from it at every request:
   * today and the next 14 dates with their weekdays, so the model reads dates rather than working
   * them out. Pass the same clock to the role's desk so the two agree. Omitted: no section.
   */
  readonly now?: (() => Date) | undefined;
  /**
   * The business's IANA time zone (the company record's `hours.timezone`), which decides the day
   * the `today` section names. Pass the same one to `localDate` in the role's desk. Omitted: UTC.
   */
  readonly timeZone?: string | undefined;
}

/** A role bundle that can re-read its files when an overlay changes. */
export interface DefinedRole extends RoleBundle {
  /** The role's approval facts readers, keyed by approval id, so a host's own gate can read them too. */
  readonly approvalFacts: Readonly<Record<string, ApprovalFactsReader>>;
  /** What the agent currently sees. */
  current(): ResolvedRole;
  /**
   * Re-reads the role's files and overlays. Prompt text and skills take effect on the agent's next
   * request; a changed model, or skills or tools switched on or off, apply when the host next
   * configures the conversation with `agent`. On problems the last good files stay in use.
   */
  reload(): readonly Issue[];
}

/** Thrown by `defineRole` when the role's files or overlays have problems. */
export class RoleFilesError extends Error {
  constructor(readonly issues: readonly Issue[]) {
    super(
      `The role's files have problems:\n${issues.map((issue) => `  ${formatIssue(issue)}`).join("\n")}`,
    );
    this.name = "RoleFilesError";
  }
}

export function defineRole(options: DefineRoleOptions): DefinedRole {
  const checked = validateManifest(options.manifest);
  if (!checked.ok) throw new RoleFilesError(checked.issues);
  const manifest = checked.value;
  const resolve = () =>
    resolveRoleFiles({
      packageDir: options.packageDir,
      manifest,
      ...(options.overlays === undefined ? {} : { overlays: options.overlays }),
      ...(options.instructionsOnly === undefined
        ? {}
        : { instructionsOnly: options.instructionsOnly }),
      ...(options.extraSkills === undefined ? {} : { extraSkills: options.extraSkills }),
    });

  const first = resolve();
  if (!first.ok) throw new RoleFilesError(first.issues);
  let current = first.value;

  // Engine, MCP and CLI tools are built from the manifest, then placed like hand-written ones: in the
  // role's extension, or in their skill's. CLI tools need nothing from the caller: the host's
  // environment supplies the variables a CLI names, at call time.
  const declaresEngineTools = manifest.tools.some((tool) => tool.engine !== undefined);
  if (declaresEngineTools && options.engine === undefined) {
    throw new RoleFilesError([
      {
        source: "role",
        path: "engine",
        message: `${manifest.id} declares engine tools; pass an engine, e.g. engineFromManifest(packageDir, manifest)`,
      },
    ]);
  }
  // A client for a server the manifest does not declare is a mistake that would otherwise leave the
  // declared server silently "not connected".
  const undeclaredServers = Object.keys(options.mcp ?? {}).filter(
    (id) => !Object.hasOwn(manifest.mcpServers ?? {}, id),
  );
  if (undeclaredServers.length > 0) {
    throw new RoleFilesError(
      undeclaredServers.map((id) => ({
        source: "role",
        path: `mcp.${id}`,
        message: `${manifest.id} declares no MCP server ${JSON.stringify(id)} in mcpServers`,
      })),
    );
  }
  // Pack tools come from the packs the host gave, placed like the tools built from the manifest.
  const fromPacks = packTools(manifest, options.packs ?? []);
  if (fromPacks.issues.length > 0) throw new RoleFilesError(fromPacks.issues);
  const built = [
    ...(options.engine === undefined ? [] : engineTools(manifest, options.engine)),
    ...mcpTools(manifest, options.mcp ?? {}),
    ...cliTools(manifest, options.packageDir),
    ...fromPacks.tools,
  ];
  const skillOf = new Map(manifest.tools.map((tool) => [tool.name, tool.skill]));
  const roleTools = [
    ...built.filter((tool) => skillOf.get(tool.name) === undefined),
    ...(options.tools ?? []),
  ];
  const toolsBySkill = new Map<string, ToolRegistration[]>();
  for (const tool of built) {
    const skill = skillOf.get(tool.name);
    if (skill !== undefined) toolsBySkill.set(skill, [...(toolsBySkill.get(skill) ?? []), tool]);
  }
  for (const [skill, tools] of Object.entries(options.skillTools ?? {})) {
    toolsBySkill.set(skill, [...(toolsBySkill.get(skill) ?? []), ...tools]);
  }

  const readSkill = defineTool({
    name: "read_skill",
    description:
      "Load a skill's full instructions before doing the kind of work it describes, or one of its reference files.",
    parameters: obj(
      {
        name: str({ description: "The skill's name, from the skills list" }),
        file: opt(
          str({
            description:
              "A file inside the skill, e.g. references/policy.md. Omit for the instructions.",
          }),
        ),
      },
      { open: true },
    ),
    replay: "safe",
    execute: async (args) => {
      const skill = current.skills.find(
        (candidate) => candidate.name === args.name && candidate.enabled,
      );
      if (skill === undefined) {
        return {
          isError: true,
          output: [{ type: "text", text: `There is no skill called "${args.name}".` }],
        };
      }
      if (args.file === undefined) return { output: [{ type: "text", text: skill.instructions }] };
      try {
        return { output: [{ type: "text", text: readSkillFile(skill, args.file) }] };
      } catch {
        return {
          isError: true,
          output: [{ type: "text", text: `The ${skill.name} skill has no file "${args.file}".` }],
        };
      }
    },
  });

  // The context plan's patterns (relevance filter, context_recall, compaction that keeps ids, amount
  // masking) join the role's own extension; a role without a plan gets it back unchanged.
  const role = withContextPatterns(
    defineExtension({
      name: manifest.id,
      sections: [
        section("agents_md", () => current.agents.map((part) => part.text).join("\n\n")),
        section("skills", () => skillIndex(current)),
        section("append_system", () => current.appendSystem?.text),
        // Last, so the stable sections above stay a cacheable prefix when the date changes.
        ...(options.now === undefined ? [] : [todaySection(options.now, options.timeZone)]),
      ],
      tools: [...roleTools, readSkill].map(guardToolResult),
      hooks: [
        approvalGate({
          // Live, like the limits below: an approval an overlay switches off stops being asked on
          // reload, and one switched back on is asked again.
          get approvals() {
            return current.approvals;
          },
          approve: options.approve,
          ...(options.when ? { when: options.when } : {}),
          ...(options.approvalFacts ? { facts: options.approvalFacts } : {}),
          ...(options.approvalDeclined ? { declined: options.approvalDeclined } : {}),
          // Live, so an overlay's limit change takes effect on reload, like the prompt sections.
          get limits() {
            return current.limits;
          },
        }),
        ...(options.hooks ?? []),
      ],
      ...(options.tasks === undefined ? {} : { tasks: options.tasks }),
    }),
    manifest.contextPlan,
    { fallbackModel: () => current.model },
  );

  // Skills that bring tools get their own extension, selected only while the skill is on.
  const skillExtensions = [...toolsBySkill].map(([skill, tools]) =>
    defineExtension({
      name: skillExtensionName(manifest.id, skill),
      tools: tools.map(guardToolResult),
    }),
  );

  const agentSettings = (): RoleBundle["agent"] => {
    const enabled = new Set(
      current.skills.filter((skill) => skill.enabled).map((skill) => skill.name),
    );
    const allTools = [role, ...skillExtensions].flatMap((extension) => extension.tools ?? []);
    const disabled = allTools.filter((tool) => current.disabledTools.includes(tool.name));
    const { provider, modelId, thinkingLevel } = current.model;
    return {
      model: { provider, modelId },
      ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
      extensions: [
        role,
        ...skillExtensions.filter((extension) =>
          enabled.has(extension.name.slice(manifest.id.length + 1)),
        ),
      ],
      ...(disabled.length === 0 ? {} : { tools: { remove: disabled } }),
    };
  };

  const bundle: DefinedRole = {
    approvalFacts: options.approvalFacts ?? {},
    extensions: [role, ...skillExtensions] as readonly Extension[],
    get agent() {
      return agentSettings();
    },
    current: () => current,
    reload: () => {
      const next = resolve();
      if (next.ok) current = next.value;
      return next.issues;
    },
  };
  return bundle;
}

/** The skill index: every enabled skill's name and description, as Pi lists them. */
function skillIndex(role: ResolvedRole): string | undefined {
  const listed = role.skills.filter((skill) => skill.enabled && !skill.disableModelInvocation);
  if (listed.length === 0) return undefined;
  return [
    "Skills hold instructions for specific kinds of work. Before doing work a skill describes, call read_skill with its name and follow what it says.",
    "",
    ...listed.map((skill) => `- ${skill.name}: ${skill.description}`),
  ].join("\n");
}
