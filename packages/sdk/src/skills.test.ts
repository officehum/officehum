import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatIssue } from "./issues.js";
import { readSkill, readSkillFile } from "./skills.js";
import { removeTempDirs, SAMPLE_DIR, skillFile, tempDir } from "./test-helpers.js";

afterEach(removeTempDirs);

const messages = (dir: string, instructionsOnly = false) => {
  const result = readSkill(dir, "skills/test", { instructionsOnly });
  return result.ok ? [] : result.issues.map(formatIssue);
};

describe("readSkill", () => {
  it("reads a skill in the Agent Skills format", () => {
    const result = readSkill(join(SAMPLE_DIR, "skills/rescheduling"), "skills/rescheduling");
    expect(result.issues).toEqual([]);
    if (!result.ok) return;
    expect(result.value.name).toBe("rescheduling");
    expect(result.value.description).toMatch(/^Move an existing appointment/);
    expect(result.value.instructions).toMatch(/^1\. Ask for the booking reference/);
    expect(result.value.disableModelInvocation).toBe(false);
  });

  it("applies the Agent Skills name rules, including matching the folder", () => {
    const dir = tempDir("billing", {
      "SKILL.md": skillFile("name: Billing--Help\ndescription: Help."),
    });
    expect(messages(dir)).toEqual([
      'skills/test/SKILL.md › name: must be 1-64 lowercase letters, digits and single hyphens, not at either end (got "Billing--Help")',
      'skills/test/SKILL.md › name: must match its folder name "billing" (got "Billing--Help")',
    ]);
  });

  it("requires a description", () => {
    const dir = tempDir("billing", { "SKILL.md": skillFile("name: billing") });
    expect(messages(dir)).toEqual([
      "skills/test/SKILL.md › description: is required: say what the skill does and when to use it",
    ]);
  });

  it("explains missing or broken frontmatter", () => {
    expect(messages(tempDir("billing", { "SKILL.md": "# Billing\n" }))).toEqual([
      "skills/test/SKILL.md: must start with YAML frontmatter between --- lines",
    ]);
    expect(messages(tempDir("billing", { "SKILL.md": skillFile("name: [billing") }))[0]).toMatch(
      /^skills\/test\/SKILL\.md: frontmatter is not valid YAML/,
    );
    expect(messages(tempDir("billing", {}))).toEqual(["skills/test: has no SKILL.md"]);
  });

  it("checks the optional fields' shapes", () => {
    const dir = tempDir("billing", {
      "SKILL.md": skillFile(
        "name: billing\ndescription: Billing help.\nmetadata:\n  version: 2\ndisable-model-invocation: maybe",
      ),
    });
    expect(messages(dir)).toEqual([
      "skills/test/SKILL.md › metadata: must map names to text values",
      'skills/test/SKILL.md › disable-model-invocation: must be true or false (got "maybe")',
    ]);
  });

  it("allows only instructions and reference files when asked", () => {
    const dir = tempDir("billing", {
      "SKILL.md": skillFile("name: billing\ndescription: Billing help."),
      "references/rates.csv": "plan,price\n",
      "scripts/export.py": "print('hi')\n",
    });
    expect(messages(dir)).toEqual([]);
    expect(messages(dir, true)).toEqual([
      "skills/test › scripts/export.py: is not allowed here: skills may hold only instructions and reference files (.md, .txt, .csv, .json), not scripts or other code",
    ]);
  });
});

describe("readSkillFile", () => {
  const skill = () => {
    const result = readSkill(join(SAMPLE_DIR, "skills/rescheduling"), "skills/rescheduling");
    if (!result.ok) throw new Error("sample skill is invalid");
    return result.value;
  };

  it("reads a reference file inside the skill", () => {
    expect(readSkillFile(skill(), "references/policy.md")).toMatch(/^# Rescheduling policy/);
  });

  it("refuses paths outside the skill", () => {
    expect(() => readSkillFile(skill(), "../../AGENTS.md")).toThrow(
      /is not a file in the rescheduling skill/,
    );
    expect(() => readSkillFile(skill(), "references")).toThrow(
      /is not a file in the rescheduling skill/,
    );
  });
});
