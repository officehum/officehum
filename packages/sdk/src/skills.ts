/**
 * Skills in the Agent Skills format (https://agentskills.io/specification), as Pi uses them: a
 * folder holding `SKILL.md` (YAML frontmatter plus instructions) and optional reference files.
 * The name and description are always in the prompt; the instructions load when the agent asks.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { type Issue, show, type Validation } from "./issues.js";

export const SKILL_FILE = "SKILL.md";

/** Agent Skills name rule: lowercase letters, digits and single hyphens, not at either end. */
const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** File types a skill may hold when only instructions are allowed (hosted Office Hum overlays). */
export const INSTRUCTION_FILE_TYPES = [".md", ".txt", ".csv", ".json"] as const;

/** A skill read from disk. */
export interface Skill {
  readonly name: string;
  readonly description: string;
  /** The instructions: SKILL.md after its frontmatter. */
  readonly instructions: string;
  /** Pi's flag: the skill is used only when a person asks for it by name, never chosen by the model. */
  readonly disableModelInvocation: boolean;
  readonly dir: string;
}

export interface ReadSkillOptions {
  /** Report files other than instruction types (scripts, binaries). Default false. */
  readonly instructionsOnly?: boolean;
}

/** Reads and validates one skill folder. `source` names it in issues, e.g. `skills/collections`. */
export function readSkill(
  dir: string,
  source: string,
  options: ReadSkillOptions = {},
): Validation<Skill> {
  const issues: Issue[] = [];
  const add = (path: string, message: string) => issues.push({ source, path, message });
  const folder = dir.split(sep).at(-1) ?? "";

  let text: string;
  try {
    text = readFileSync(join(dir, SKILL_FILE), "utf8");
  } catch {
    return { ok: false, issues: [{ source, path: "", message: `has no ${SKILL_FILE}` }] };
  }

  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (match === null) {
    return {
      ok: false,
      issues: [
        {
          source: `${source}/${SKILL_FILE}`,
          path: "",
          message: "must start with YAML frontmatter between --- lines",
        },
      ],
    };
  }
  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(match[1] ?? "");
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return {
      ok: false,
      issues: [
        {
          source: `${source}/${SKILL_FILE}`,
          path: "",
          message: `frontmatter is not valid YAML: ${message}`,
        },
      ],
    };
  }
  if (frontmatter === null || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    return {
      ok: false,
      issues: [
        { source: `${source}/${SKILL_FILE}`, path: "", message: "frontmatter must be a mapping" },
      ],
    };
  }

  const fields = frontmatter as Record<string, unknown>;
  const file = `${source}/${SKILL_FILE}`;
  const name = fields.name;
  const description = fields.description;
  if (typeof name !== "string") {
    issues.push({ source: file, path: "name", message: "is required" });
  } else {
    if (name.length > 64 || !SKILL_NAME.test(name)) {
      issues.push({
        source: file,
        path: "name",
        message: `must be 1-64 lowercase letters, digits and single hyphens, not at either end (got ${show(name)})`,
      });
    }
    if (name !== folder) {
      issues.push({
        source: file,
        path: "name",
        message: `must match its folder name ${show(folder)} (got ${show(name)})`,
      });
    }
  }
  if (typeof description !== "string" || description.trim() === "") {
    issues.push({
      source: file,
      path: "description",
      message: "is required: say what the skill does and when to use it",
    });
  } else if (description.length > 1024) {
    issues.push({
      source: file,
      path: "description",
      message: `must be at most 1024 characters (got ${description.length})`,
    });
  }
  if (
    fields.compatibility !== undefined &&
    (typeof fields.compatibility !== "string" || fields.compatibility.length > 500)
  ) {
    issues.push({
      source: file,
      path: "compatibility",
      message: "must be text of at most 500 characters",
    });
  }
  if (fields.metadata !== undefined) {
    const metadata = fields.metadata;
    const valid =
      metadata !== null &&
      typeof metadata === "object" &&
      !Array.isArray(metadata) &&
      Object.values(metadata).every((value) => typeof value === "string");
    if (!valid)
      issues.push({ source: file, path: "metadata", message: "must map names to text values" });
  }
  const disable = fields["disable-model-invocation"];
  if (disable !== undefined && typeof disable !== "boolean") {
    issues.push({
      source: file,
      path: "disable-model-invocation",
      message: `must be true or false (got ${show(disable)})`,
    });
  }

  if (options.instructionsOnly) {
    for (const path of listFiles(dir)) {
      if (!(INSTRUCTION_FILE_TYPES as readonly string[]).includes(extname(path).toLowerCase())) {
        add(
          path,
          `is not allowed here: skills may hold only instructions and reference files (${INSTRUCTION_FILE_TYPES.join(", ")}), not scripts or other code`,
        );
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    issues: [],
    value: {
      name: name as string,
      description: (description as string).trim(),
      instructions: (match[2] ?? "").trim(),
      disableModelInvocation: disable === true,
      dir,
    },
  };
}

/** Lists a directory's skill folders: every subfolder holding a SKILL.md. */
export function skillFolders(skillsDir: string): string[] {
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsDir, entry.name, SKILL_FILE)))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Reads a file inside a skill, e.g. `references/policy.md`. Refuses paths that leave the skill's
 * folder, including through symbolic links.
 */
export function readSkillFile(skill: Skill, path: string): string {
  const root = realpathSync(skill.dir);
  const target = realpathSync(join(skill.dir, path));
  const inside = relative(root, target);
  if (inside === "" || inside.startsWith("..") || inside.startsWith(sep)) {
    throw new Error(`${show(path)} is not a file in the ${skill.name} skill`);
  }
  if (!statSync(target).isFile())
    throw new Error(`${show(path)} is not a file in the ${skill.name} skill`);
  return readFileSync(target, "utf8");
}

/** Every file under a directory, as paths relative to it. */
function listFiles(dir: string, prefix = ""): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    return entry.isDirectory() ? listFiles(dir, path) : [path];
  });
}
