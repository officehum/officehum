/**
 * Role files and overlays. A role package ships Pi's familiar files (AGENTS.md, APPEND_SYSTEM.md,
 * skills/); overlay directories with the same layout sit on top of it, the way Pi's project `.pi/`
 * sits on its agent directory. A host may keep each customer's overlay and edit it for them;
 * anyone else writes overlay files by hand. See "Role files and overlays" in docs/design/agent-package.md.
 */

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type Static, Type } from "typebox";
import { type Issue, joinPath, schemaIssues, show, type Validation } from "./issues.js";
import {
  type AgentManifest,
  type ApprovalDeclaration,
  comparedDirection,
  type LimitDirection,
  limitDirection,
  THINKING_LEVELS,
} from "./manifest.js";
import { outsideApprovals, SEND_FLOOR_REASON } from "./send-tools.js";
import { readSkill, type Skill, skillFolders } from "./skills.js";

/** The files a role package and its overlays may hold. */
export const ROLE_FILES = {
  /** The role's working context. Package and overlays combine, package first. */
  agents: "AGENTS.md",
  /** Overlay only: replaces the AGENTS.md text of every layer below it. */
  agentsOverride: "AGENTS.override.md",
  /** Appended to the end of the system prompt. The top-most layer that has one wins. */
  appendSystem: "APPEND_SYSTEM.md",
  /** Overlay only: model, skills, tools and approvals switched on or off, and named limits. */
  settings: "settings.json",
  /** Skill folders, merged by name; a higher layer's skill replaces a lower one's. */
  skills: "skills",
  /**
   * Overlay only: document templates, `<name>.typ` with its data's JSON Schema in
   * `<name>.schema.json`, merged by name; a higher layer's template replaces a lower one's.
   */
  templates: "templates",
} as const;

const TEMPLATE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TEMPLATE_SOURCE = ".typ";
const TEMPLATE_SCHEMA = ".schema.json";

const SkillEdit = Type.String({
  pattern: "^[+-][a-z0-9]+(-[a-z0-9]+)*$",
  "x-hint": '"+name" or "-name"',
});
const ToolEdit = Type.String({
  pattern: "^[+-][a-z][a-z0-9]*(_[a-z0-9]+)*$",
  "x-hint": '"+name" or "-name"',
});

/** An overlay's `settings.json`, using Pi's setting names where they exist. */
export const OverlaySettingsSchema = Type.Object(
  {
    $schema: Type.Optional(Type.String()),
    defaultProvider: Type.Optional(Type.String({ minLength: 1 })),
    defaultModel: Type.Optional(Type.String({ minLength: 1 })),
    defaultThinkingLevel: Type.Optional(Type.Enum([...THINKING_LEVELS])),
    /** Edits to the selected skills: "+name" switches one on, "-name" off. */
    skills: Type.Optional(Type.Array(SkillEdit)),
    /** Edits to the role's tools: "-name" switches one off, "+name" back on. Tools cannot be added here. */
    tools: Type.Optional(Type.Array(ToolEdit)),
    /**
     * Edits to the role's approvals: "-id" switches one off, so its tool runs without asking a person,
     * "+id" back on. Approvals cannot be added here. Switching one off lowers a safeguard, which an
     * office applies only with the owner's acknowledgement (docs/design/overlay-rules.md).
     */
    approvals: Type.Optional(Type.Array(ToolEdit)),
    /**
     * The business's values for the role's named limits, e.g. `{ "large_invoice": 2500 }`. A limit may
     * be changed, never removed: a `null` value is refused, because an approval comparing with a
     * missing limit asks every time; switching the approval off is the named way to stop asking.
     */
    limits: Type.Optional(Type.Record(Type.String(), Type.Union([Type.Number(), Type.Null()]))),
  },
  { additionalProperties: false },
);
export type OverlaySettings = Static<typeof OverlaySettingsSchema>;

/** A piece of text and the file it came from, e.g. `overlay acme/AGENTS.md`. */
export interface SourcedText {
  readonly text: string;
  readonly source: string;
}

export interface ResolvedSkill extends Skill {
  readonly enabled: boolean;
  /** The layer the winning copy came from, e.g. `package` or `overlay acme`. */
  readonly layer: string;
}

/**
 * A business's document template from an overlay: Typst source and the JSON Schema of its data.
 * Whether it compiles is the document generation pack's check, which a host adds (see
 * `@officehum/tools-docgen`); this is only its shape.
 */
export interface ResolvedTemplate {
  readonly name: string;
  /** The Typst source, `templates/<name>.typ`. */
  readonly source: string;
  /** The parsed `templates/<name>.schema.json`. */
  readonly schema: Readonly<Record<string, unknown>>;
  /** The layer the winning copy came from, e.g. `overlay acme`. */
  readonly layer: string;
  /** The source file, named as problems name it, e.g. `overlay acme/templates/quote.typ`. */
  readonly file: string;
}

/** What the agent sees once every layer is applied. */
export interface ResolvedRole {
  /** AGENTS.md texts, in prompt order. */
  readonly agents: readonly SourcedText[];
  readonly appendSystem: SourcedText | undefined;
  /** Every known skill, sorted by name, with whether it is switched on. */
  readonly skills: readonly ResolvedSkill[];
  readonly model: {
    readonly provider: string;
    readonly modelId: string;
    readonly thinkingLevel?: (typeof THINKING_LEVELS)[number];
  };
  /** Declared tools switched off by an overlay. */
  readonly disabledTools: readonly string[];
  /** The approvals in effect: the manifest's, in its order, less those an overlay switched off. */
  readonly approvals: readonly ApprovalDeclaration[];
  /** Declared approvals switched off by an overlay, sorted. */
  readonly disabledApprovals: readonly string[];
  /**
   * Named limits, resolved: every limit the manifest declares, with the business's overlay values
   * applied. An overlay changes a value; it can neither add a limit nor remove one.
   */
  readonly limits: Readonly<Record<string, number>>;
  /** The overlays' document templates, sorted by name, the highest layer's copy of each. */
  readonly templates: readonly ResolvedTemplate[];
}

export interface ResolveRoleOptions {
  /** The role package's root: where officehum.json, AGENTS.md and skills/ are. */
  readonly packageDir: string;
  readonly manifest: AgentManifest;
  /** Overlay directories, lowest first. */
  readonly overlays?: readonly string[];
  /** Overlay skills may hold only instructions and reference files, never scripts. Default true. */
  readonly instructionsOnly?: boolean;
  /**
   * Skill folders an extension the role runs with ships, e.g. `@officehum/memory`'s
   * `memory-hygiene`. They join the package's skills, on, and overlays treat them like package
   * skills. A name the package or another folder here already uses is an error naming both paths.
   */
  readonly extraSkills?: readonly string[];
}

/** Reads the role's package files and overlays, validates them, and applies the layers in order. */
export function resolveRoleFiles(options: ResolveRoleOptions): Validation<ResolvedRole> {
  const { packageDir, manifest } = options;
  const issues: Issue[] = [];
  const add = (source: string, path: string, message: string) =>
    issues.push({ source, path, message });

  // The package layer.
  let agents: SourcedText[] = [];
  const packageAgents = readText(join(packageDir, ROLE_FILES.agents));
  if (packageAgents === undefined || packageAgents.trim() === "") {
    add(ROLE_FILES.agents, "", "is required: it tells the agent who it is and how it works");
  } else {
    agents.push({ text: packageAgents.trim(), source: ROLE_FILES.agents });
  }
  for (const overlayOnly of [ROLE_FILES.agentsOverride, ROLE_FILES.settings]) {
    if (existsSync(join(packageDir, overlayOnly))) {
      add(
        overlayOnly,
        "",
        "belongs in an overlay, not in the role package; package defaults go in officehum.json",
      );
    }
  }
  let appendSystem = sourced(
    readText(join(packageDir, ROLE_FILES.appendSystem)),
    ROLE_FILES.appendSystem,
  );

  const skills = new Map<string, ResolvedSkill>();
  const declared = new Map(manifest.skills.map((skill) => [skill.id, skill]));
  const folders = skillFolders(join(packageDir, ROLE_FILES.skills));
  for (const folder of folders) {
    const source = `${ROLE_FILES.skills}/${folder}`;
    const result = readSkill(join(packageDir, ROLE_FILES.skills, folder), source);
    if (!result.ok) {
      issues.push(...result.issues);
      continue;
    }
    const declaration = declared.get(folder);
    if (declaration === undefined) {
      add(
        "officehum.json",
        "skills",
        `must declare the bundled skill ${show(folder)} (with enabledByDefault)`,
      );
      continue;
    }
    skills.set(folder, {
      ...result.value,
      enabled: declaration.enabledByDefault,
      layer: "package",
    });
  }
  // Where each skill so far came from, so a clash names both paths.
  const skillPaths = new Map(
    folders.map((folder) => [folder, join(packageDir, ROLE_FILES.skills, folder)]),
  );
  for (const dir of options.extraSkills ?? []) {
    const result = readSkill(dir, dir);
    if (!result.ok) {
      issues.push(...result.issues);
      continue;
    }
    const name = result.value.name;
    const other = skillPaths.get(name);
    if (other !== undefined) {
      add(dir, "", `skill ${show(name)} is also ${other}; rename one of them`);
      continue;
    }
    skillPaths.set(name, dir);
    skills.set(name, { ...result.value, enabled: true, layer: `extension ${dir}` });
  }
  for (const skill of manifest.skills) {
    if (!folders.includes(skill.id))
      add(
        "officehum.json",
        "skills",
        `declares ${show(skill.id)}, but skills/${skill.id}/SKILL.md does not exist`,
      );
  }

  let model: ResolvedRole["model"] = { ...manifest.defaultModel };
  const disabledTools = new Set<string>();
  const tools = new Set(manifest.tools.map((tool) => tool.name));
  const disabledApprovals = new Set<string>();
  const approvalsById = new Map(manifest.approvals.map((approval) => [approval.id, approval]));
  // The outside floor: approvals on a tool that reaches people outside the business, and the limits
  // they compare with, which no overlay may lower yet (see send-tools.ts).
  const sendApprovals = outsideApprovals(manifest);
  // Every declared limit starts at the manifest's default; an overlay changes values, never removes.
  const declaredLimits = manifest.limits ?? {};
  const limits: Record<string, number> = Object.fromEntries(
    Object.entries(declaredLimits).map(([name, declaration]) => [name, declaration.default]),
  );

  const templates = new Map<string, ResolvedTemplate>();

  // Overlay layers, lowest first.
  for (const dir of options.overlays ?? []) {
    const layer = `overlay ${basename(dir)}`;
    const file = (name: string) => `${layer}/${name}`;
    if (!existsSync(dir)) {
      add(layer, "", "directory does not exist");
      continue;
    }
    // A link would let an overlay read a file outside itself, past every check of what it holds.
    const links = overlayLinks(dir);
    if (links.length > 0) {
      for (const link of links) {
        add(
          file(link),
          "",
          "is a symbolic link; an overlay holds only ordinary files and folders, so copy the file in instead",
        );
      }
      continue;
    }

    const known = new Set<string>(Object.values(ROLE_FILES));
    for (const entry of readdirSync(dir)) {
      if (!known.has(entry) && !entry.startsWith(".")) {
        add(
          file(entry),
          "",
          `is not an overlay file (expected ${Object.values(ROLE_FILES).join(", ")})`,
        );
      }
    }

    const override = readText(join(dir, ROLE_FILES.agentsOverride));
    const additions = readText(join(dir, ROLE_FILES.agents));
    if (override !== undefined) {
      // As in Pi, the override wins over the AGENTS.md beside it; here it also replaces the layers below.
      agents = [{ text: override.trim(), source: file(ROLE_FILES.agentsOverride) }];
    } else if (additions !== undefined && additions.trim() !== "") {
      agents.push({ text: additions.trim(), source: file(ROLE_FILES.agents) });
    }
    appendSystem =
      sourced(readText(join(dir, ROLE_FILES.appendSystem)), file(ROLE_FILES.appendSystem)) ??
      appendSystem;

    for (const folder of skillFolders(join(dir, ROLE_FILES.skills))) {
      const result = readSkill(
        join(dir, ROLE_FILES.skills, folder),
        file(`${ROLE_FILES.skills}/${folder}`),
        {
          instructionsOnly: options.instructionsOnly ?? true,
        },
      );
      if (!result.ok) {
        issues.push(...result.issues);
        continue;
      }
      // A replaced skill keeps its on/off state; a new skill starts on.
      skills.set(folder, { ...result.value, enabled: skills.get(folder)?.enabled ?? true, layer });
    }

    for (const template of readTemplates(join(dir, ROLE_FILES.templates), layer, issues)) {
      templates.set(template.name, template);
    }

    const settingsText = readText(join(dir, ROLE_FILES.settings));
    if (settingsText === undefined) continue;
    let settingsJson: unknown;
    try {
      settingsJson = JSON.parse(settingsText);
    } catch (error) {
      add(
        file(ROLE_FILES.settings),
        "",
        `is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    const settingsIssues = schemaIssues(
      OverlaySettingsSchema,
      settingsJson,
      file(ROLE_FILES.settings),
    );
    if (settingsIssues.length > 0) {
      issues.push(...settingsIssues);
      continue;
    }
    const settings = settingsJson as OverlaySettings;
    model = {
      ...model,
      ...(settings.defaultProvider === undefined ? {} : { provider: settings.defaultProvider }),
      ...(settings.defaultModel === undefined ? {} : { modelId: settings.defaultModel }),
      ...(settings.defaultThinkingLevel === undefined
        ? {}
        : { thinkingLevel: settings.defaultThinkingLevel }),
    };
    settings.skills?.forEach((edit, index) => {
      const name = edit.slice(1);
      const skill = skills.get(name);
      if (skill === undefined) {
        add(
          file(ROLE_FILES.settings),
          joinPath(joinPath("skills", index), ""),
          `${show(name)} is not a skill of this role or its overlays`,
        );
      } else {
        skills.set(name, { ...skill, enabled: edit.startsWith("+") });
      }
    });
    settings.tools?.forEach((edit, index) => {
      const name = edit.slice(1);
      if (!tools.has(name)) {
        add(
          file(ROLE_FILES.settings),
          `tools[${index}]`,
          `${show(name)} is not a tool of this role; an overlay switches a role's tools on or off, and new tools arrive in a role or tool pack release`,
        );
      } else if (edit.startsWith("-")) {
        disabledTools.add(name);
      } else {
        disabledTools.delete(name);
      }
    });
    settings.approvals?.forEach((edit, index) => {
      const id = edit.slice(1);
      const approval = approvalsById.get(id);
      const path = `approvals[${index}]`;
      if (approval === undefined) {
        add(
          file(ROLE_FILES.settings),
          path,
          `${show(id)} is not an approval of this role; an overlay switches a role's approvals off or back on, and new approvals arrive in a role release`,
        );
      } else if (edit.startsWith("+")) {
        disabledApprovals.delete(id);
      } else if (sendApprovals.includes(approval)) {
        add(
          file(ROLE_FILES.settings),
          path,
          `${show(id)} asks a person before ${show(approval.tool)} sends or publishes to someone outside the business, and ${SEND_FLOOR_REASON}, so this approval stays on`,
        );
      } else {
        disabledApprovals.add(id);
      }
    });
    settings.limits &&
      Object.entries(settings.limits).forEach(([name, value]) => {
        const path = joinPath("limits", name);
        if (!(name in declaredLimits)) {
          add(
            file(ROLE_FILES.settings),
            path,
            `${show(name)} is not a limit of this role; a limit is declared in officehum.json`,
          );
        } else if (value === null) {
          add(
            file(ROLE_FILES.settings),
            path,
            `${show(name)} cannot be removed; set a number to change it (to stop asking a person, switch the approval off in "approvals")`,
          );
        } else {
          const send = comparedDirection(sendApprovals, name);
          const declared = declaredLimits[name];
          const shipped = declared?.default ?? value;
          // A limit marked outside decides on its own whether something goes out with no person.
          const marked = declared?.outside === true ? limitDirection(manifest, name) : undefined;
          if (send !== undefined && loosens(send, value, shipped)) {
            const sendTools = [...new Set(sendApprovals.map((approval) => show(approval.tool)))];
            add(
              file(ROLE_FILES.settings),
              path,
              `${show(name)} decides when a person sees what ${sendTools.join(" and ")} sends or publishes outside the business, and ${SEND_FLOOR_REASON}, so it may be tightened but not loosened past ${shipped}`,
            );
          } else if (marked !== undefined && loosens(marked, value, shipped)) {
            add(
              file(ROLE_FILES.settings),
              path,
              `${show(name)} decides when something goes outside the business without a person, and ${SEND_FLOOR_REASON}, so it may be tightened but not loosened past ${shipped}`,
            );
          } else {
            limits[name] = value;
          }
        }
      });
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    issues: [],
    value: {
      agents,
      appendSystem,
      skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)),
      model,
      disabledTools: [...disabledTools].sort(),
      approvals: manifest.approvals.filter((approval) => !disabledApprovals.has(approval.id)),
      disabledApprovals: [...disabledApprovals].sort(),
      limits,
      templates: [...templates.values()].sort((a, b) => a.name.localeCompare(b.name)),
    },
  };
}

/** Whether `value` lets more through than `from`, for a limit guarding in `direction`. */
export function loosens(direction: LimitDirection, value: number, from: number): boolean {
  switch (direction) {
    case "ceiling":
      return value > from;
    case "floor":
      return value < from;
    case "both":
      return value !== from;
    case "none":
      return false;
  }
}

/**
 * One overlay's `templates/` folder: each `<name>.typ` with its `<name>.schema.json`, and nothing
 * else. Problems are reported per file, sorted by file, so every one shows at once.
 */
function readTemplates(dir: string, layer: string, issues: Issue[]): ResolvedTemplate[] {
  if (!existsSync(dir)) return [];
  const file = (name: string) => `${layer}/${ROLE_FILES.templates}/${name}`;
  const found: Issue[] = [];
  const add = (name: string, message: string) =>
    found.push({ source: file(name), path: "", message });
  const entries = readdirSync(dir, { withFileTypes: true }).filter(
    (entry) => !entry.name.startsWith("."),
  );
  const names = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const templates: ResolvedTemplate[] = [];
  for (const entry of entries) {
    const isSource = entry.name.endsWith(TEMPLATE_SOURCE);
    const isSchema = entry.name.endsWith(TEMPLATE_SCHEMA);
    if (!entry.isFile() || (!isSource && !isSchema)) {
      add(entry.name, "is not a template file (expected <name>.typ and <name>.schema.json)");
      continue;
    }
    const name = entry.name.slice(0, -(isSchema ? TEMPLATE_SCHEMA.length : TEMPLATE_SOURCE.length));
    if (!TEMPLATE_NAME.test(name)) {
      if (isSource) {
        add(
          entry.name,
          "is not a template name: use lowercase words joined by hyphens, like customer-statement",
        );
      }
      continue;
    }
    if (isSchema) {
      if (!names.has(`${name}${TEMPLATE_SOURCE}`)) {
        add(entry.name, `has no template ${name}${TEMPLATE_SOURCE} beside it`);
      }
      continue;
    }
    const schemaName = `${name}${TEMPLATE_SCHEMA}`;
    if (!names.has(schemaName)) {
      add(entry.name, `needs a JSON Schema for its data in ${schemaName}`);
      continue;
    }
    let schema: unknown;
    try {
      schema = JSON.parse(readFileSync(join(dir, schemaName), "utf8"));
    } catch (error) {
      add(
        schemaName,
        `is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
      add(schemaName, "must be a JSON Schema object");
      continue;
    }
    templates.push({
      name,
      source: readFileSync(join(dir, entry.name), "utf8"),
      schema: schema as Record<string, unknown>,
      layer,
      file: file(entry.name),
    });
  }
  issues.push(...found.sort((a, b) => a.source.localeCompare(b.source)));
  return templates;
}

/**
 * Every symbolic link (or other entry that is neither a file nor a folder) under an overlay
 * directory, as paths relative to it. Top-level dot entries are the operator's and are never read.
 */
export function overlayLinks(dir: string, prefix = ""): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
    if (prefix === "" && entry.name.startsWith(".")) return [];
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const stats = lstatSync(join(dir, path));
    if (stats.isDirectory()) return overlayLinks(dir, path);
    return stats.isFile() ? [] : [path];
  });
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function sourced(text: string | undefined, source: string): SourcedText | undefined {
  return text === undefined || text.trim() === "" ? undefined : { text: text.trim(), source };
}
