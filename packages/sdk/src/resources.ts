/**
 * Role files and overlays. A role package ships Pi's familiar files (AGENTS.md, APPEND_SYSTEM.md,
 * skills/); overlay directories with the same layout sit on top of it, the way Pi's project `.pi/`
 * sits on its agent directory. Office Hum keeps each customer's overlay and edits it from Studio;
 * anyone else writes overlay files by hand. See "Role files and overlays" in docs/design/agent-package.md.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type Static, Type } from "typebox";
import { type Issue, joinPath, schemaIssues, show, type Validation } from "./issues.js";
import { type AgentManifest, THINKING_LEVELS } from "./manifest.js";
import { readSkill, type Skill, skillFolders } from "./skills.js";

/** The files a role package and its overlays may hold. */
export const ROLE_FILES = {
  /** The role's working context. Package and overlays combine, package first. */
  agents: "AGENTS.md",
  /** Overlay only: replaces the AGENTS.md text of every layer below it. */
  agentsOverride: "AGENTS.override.md",
  /** Appended to the end of the system prompt. The top-most layer that has one wins. */
  appendSystem: "APPEND_SYSTEM.md",
  /** Overlay only: model, and skills and tools switched on or off. */
  settings: "settings.json",
  /** Skill folders, merged by name; a higher layer's skill replaces a lower one's. */
  skills: "skills",
} as const;

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
}

export interface ResolveRoleOptions {
  /** The role package's root: where officehum.json, AGENTS.md and skills/ are. */
  readonly packageDir: string;
  readonly manifest: AgentManifest;
  /** Overlay directories, lowest first. */
  readonly overlays?: readonly string[];
  /** Overlay skills may hold only instructions and reference files, never scripts. Default true. */
  readonly instructionsOnly?: boolean;
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

  // Overlay layers, lowest first.
  for (const dir of options.overlays ?? []) {
    const layer = `overlay ${basename(dir)}`;
    const file = (name: string) => `${layer}/${name}`;
    if (!existsSync(dir)) {
      add(layer, "", "directory does not exist");
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
          `${show(name)} is not a tool of this role; overlays can switch tools off, not add them`,
        );
      } else if (edit.startsWith("-")) {
        disabledTools.add(name);
      } else {
        disabledTools.delete(name);
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
    },
  };
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
