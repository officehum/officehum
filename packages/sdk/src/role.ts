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

import { Type } from "@earendil-works/pi-ai";
import {
  type AnyTask,
  defineExtension,
  defineTool,
  type Extension,
  type HookRegistration,
  section,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { type RoleBundle, skillExtensionName } from "./agent.js";
import { type Approver, approvalGate, type ToolArguments } from "./approvals.js";
import { type Engine, engineTools } from "./engine.js";
import { formatIssue, type Issue } from "./issues.js";
import { validateManifest } from "./manifest.js";
import { type ResolvedRole, resolveRoleFiles } from "./resources.js";
import { readSkillFile } from "./skills.js";

/** The section keys a role's prompt renders under, in order. */
export const ROLE_SECTION_KEYS = ["agents_md", "skills", "append_system"] as const;

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
  /** Tools that come with a skill, keyed by skill id. */
  readonly skillTools?: Readonly<Record<string, readonly ToolRegistration[]>>;
  /** Decides gated actions. Omitted: they are blocked. */
  readonly approve?: Approver | undefined;
  /** When each approval applies, keyed by approval id. */
  readonly when?: Readonly<Record<string, (args: ToolArguments) => boolean>>;
  /** More hooks for the role extension, after the approval gate. */
  readonly hooks?: readonly HookRegistration[];
  /** Durable tasks the role's tools start. */
  readonly tasks?: readonly AnyTask[];
}

/** A role bundle that can re-read its files when an overlay changes. */
export interface DefinedRole extends RoleBundle {
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
    });

  const first = resolve();
  if (!first.ok) throw new RoleFilesError(first.issues);
  let current = first.value;

  // Engine tools are built from the manifest, then placed like hand-written ones: in the role's
  // extension, or in their skill's.
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
  const built = options.engine === undefined ? [] : engineTools(manifest, options.engine);
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
    parameters: Type.Object({
      name: Type.String({ description: "The skill's name, from the skills list" }),
      file: Type.Optional(
        Type.String({
          description:
            "A file inside the skill, e.g. references/policy.md. Omit for the instructions.",
        }),
      ),
    }),
    replay: "safe",
    execute: async (args) => {
      const skill = current.skills.find(
        (candidate) => candidate.name === args.name && candidate.enabled,
      );
      if (skill === undefined) {
        return {
          isError: true,
          content: [{ type: "text", text: `There is no skill called "${args.name}".` }],
        };
      }
      if (args.file === undefined) return { content: [{ type: "text", text: skill.instructions }] };
      try {
        return { content: [{ type: "text", text: readSkillFile(skill, args.file) }] };
      } catch {
        return {
          isError: true,
          content: [{ type: "text", text: `The ${skill.name} skill has no file "${args.file}".` }],
        };
      }
    },
  });

  const role = defineExtension({
    name: manifest.id,
    sections: [
      section("agents_md", () => current.agents.map((part) => part.text).join("\n\n")),
      section("skills", () => skillIndex(current)),
      section("append_system", () => current.appendSystem?.text),
    ],
    tools: [...roleTools, readSkill],
    hooks: [
      approvalGate({
        approvals: manifest.approvals,
        approve: options.approve,
        ...(options.when ? { when: options.when } : {}),
      }),
      ...(options.hooks ?? []),
    ],
    ...(options.tasks === undefined ? {} : { tasks: options.tasks }),
  });

  // Skills that bring tools get their own extension, selected only while the skill is on.
  const skillExtensions = [...toolsBySkill].map(([skill, tools]) =>
    defineExtension({ name: skillExtensionName(manifest.id, skill), tools }),
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
