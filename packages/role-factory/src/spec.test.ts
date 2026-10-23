import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  checkFourLayers,
  formatIssue,
  readSkill,
  type Validation,
  validateManifest,
  validateSuite,
} from "@officehum/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  EVALS_DIR,
  manifestFromRoleSpec,
  parseRoleSpec,
  ROLE_SPEC_FILE,
  type RoleSpec,
} from "./index.js";

const FIXTURE = new URL("../fixtures/sample-notes/", import.meta.url);
const fixtureSpec = readFileSync(new URL("ROLE_SPEC.md", FIXTURE), "utf8");
const fixtureManifest = JSON.parse(readFileSync(new URL("officehum.json", FIXTURE), "utf8"));

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Writes files (path → content) into a new temporary directory and returns its path. */
function tempDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "officehum-role-spec-"));
  temps.push(dir);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

/** The spec, parsed; throws when the document is refused, so a fixture that drifts fails loudly. */
function parsed(text: string): RoleSpec {
  const result = parseRoleSpec(text);
  if (!result.ok) throw new Error(result.issues.map(formatIssue).join("\n"));
  return result.value;
}

const lines = (result: Validation<RoleSpec>): string[] => result.issues.map(formatIssue);

/** Checks that one parse reported each fragment, so a test can name the whole list at once. */
function expectReported(result: Validation<RoleSpec>, fragments: readonly string[]): void {
  const reported = lines(result).join("\n");
  for (const fragment of fragments) expect(reported).toContain(fragment);
}

const issueAt = (result: Validation<RoleSpec>, path: string) =>
  result.issues.find((issue) => issue.path === path);

/** The skill files the format writes for a spec: `skills/<id>/SKILL.md`, and each reference below it. */
function skillFiles(spec: RoleSpec): Record<string, string> {
  const files: Record<string, string> = {};
  for (const skill of spec.knowledge?.skills ?? []) {
    const frontmatter = `---\nname: ${skill.id}\ndescription: ${skill.description}\n---\n\n`;
    files[`skills/${skill.id}/SKILL.md`] = `${frontmatter}${skill.instructions}\n`;
    for (const reference of skill.references ?? []) {
      files[`skills/${skill.id}/references/${reference.path}`] = reference.content;
    }
  }
  return files;
}

describe("parseRoleSpec", () => {
  it("parses the four-layer spec fixture into a manifest that is its officehum.json", () => {
    const spec = parsed(fixtureSpec);
    expect(spec.body).toMatch(/^# Sample Notes/);
    expect(spec.wisdom.authority.may_not).toHaveLength(3);

    const manifest = manifestFromRoleSpec(spec);
    expect(manifest).toEqual(fixtureManifest);
    expect(manifest.evals).toBe(EVALS_DIR);
    // Nothing of one business's reaches the package: the limit is the role's default, not its value.
    expect(manifest.limits?.long_note?.default).toBe(1200);
    expect(Object.keys(manifest)).not.toContain("business");
    expect(JSON.stringify(manifest)).not.toContain("Example Co");
  });

  it("carries each prohibition into the manifest, so a generated role keeps it on its card", () => {
    const spec = parsed(fixtureSpec);
    const manifest = manifestFromRoleSpec(spec);

    // The manifest's `mayNot` is `action` and `instead` only — `enforced_by` is how the factory
    // checks the prohibition, not something a host reads — and the entries are the spec's, in order.
    expect(manifest.mayNot).toEqual([
      {
        action: "Add a note longer than the business's limit without asking",
        instead: "Ask the person who wants the note to approve it",
      },
      {
        action: "Archive a note another agent is still working on",
        instead: "Ask the agent's owner, or the person who asked, to decide",
      },
      {
        action: "Rewrite a note's text once it is written",
        instead: "Add a new note that replaces it, and say which one it replaces",
      },
    ]);
    expect(JSON.stringify(manifest.mayNot)).not.toContain("enforced_by");
    // And the SDK accepts it, so this is not a shape the manifest refuses.
    const checked = validateManifest(manifest);
    expect(checked.ok).toBe(true);
  });

  it("merges a manifest the SDK accepts, whose scenarios are the SDK's eval format", () => {
    const spec = parsed(fixtureSpec);
    const manifest = manifestFromRoleSpec(spec);
    const checked = validateManifest(manifest);
    expect(checked.ok ? checked.value.id : checked.issues.map(formatIssue)).toBe("sample-notes");

    const suite = validateSuite({ scenarios: spec.evals }, manifest, ROLE_SPEC_FILE);
    expect(suite.ok ? suite.value.scenarios.map((scenario) => scenario.id) : []).toEqual([
      "adds-a-short-note",
      "long-note-waits-for-a-person",
    ]);
  });

  it("keeps the body, the append-system lines and the skills inside the four layers", () => {
    const spec = parsed(fixtureSpec);
    const dir = tempDir({
      "AGENTS.md": spec.body,
      ...(spec.context?.append_system === undefined
        ? {}
        : { "APPEND_SYSTEM.md": spec.context.append_system }),
      ...skillFiles(spec),
    });
    // The body is under budget and holds no number; the one finding left is the section the generator
    // writes from wisdom.authority, which is not the body's to hold.
    expect(
      checkFourLayers(dir, manifestFromRoleSpec(spec), { strict: true }).map(formatIssue),
    ).toEqual([
      'AGENTS.md: has no "You may not" section; add a heading like "## You may not" saying what this role never does',
    ]);
    for (const skill of spec.knowledge?.skills ?? []) {
      const read = readSkill(join(dir, "skills", skill.id), `skills/${skill.id}`);
      expect(read.ok ? read.value.description : read.issues).toBe(skill.description);
    }
  });

  it("names the path and the layer for the two problems the issue shows", () => {
    const result = parseRoleSpec(
      brokenSpec("  approvals: []\n  authority: { may: [Search], may_not: [] }\n"),
    );
    expectReported(result, [
      'ROLE_SPEC.md › role.tools[1].replay: must be one of "safe", "unsafe" (got "maybe")',
      'ROLE_SPEC.md › context (body): "$2,500" is a money amount; put it in wisdom.approvals[].when, business.settings limits, or a skill reference',
    ]);
    expect(issueAt(result, "role.tools[1].replay")?.layer).toBe("wisdom");
    expect(issueAt(result, "context (body)")?.layer).toBe("context");
  });

  it("reports every problem at once, not one at a time", () => {
    // A document cannot miss `wisdom.authority` and carry a `may_not` entry at the same time — the
    // entry lives inside the block. Each parse below carries every other problem in the document, and
    // reports the whole list rather than the first problem it finds.
    const withoutAuthority = parseRoleSpec(brokenSpec("  approvals: []\n"));
    expectReported(withoutAuthority, [
      "ROLE_SPEC.md › notes: is not a known field",
      'ROLE_SPEC.md › role.tools[1].replay: must be one of "safe", "unsafe" (got "maybe")',
      'ROLE_SPEC.md › knowledge.skills[0].id: must be kebab-case, like "note-keeper" (got "Notes Desk")',
      "ROLE_SPEC.md › wisdom.authority: is required",
      'ROLE_SPEC.md › context (body): "$2,500" is a money amount;',
      'ROLE_SPEC.md › role.tools[2]: "archive_note" is unsafe and states no approval decision;',
      'ROLE_SPEC.md › workflow.accepts[0].done: is required for "note.add":',
      "ROLE_SPEC.md › evals[0].stubs.mystery_tool: is not a declared tool",
    ]);
    expect(issueAt(withoutAuthority, "workflow.accepts[0].done")?.layer).toBe("workflow");
    expect(issueAt(withoutAuthority, "knowledge.skills[0].id")?.layer).toBe("knowledge");
    expect(issueAt(withoutAuthority, "wisdom.authority")?.layer).toBe("wisdom");

    const withEnforcedByProblems = parseRoleSpec(
      brokenSpec(
        `  approvals: []\n  authority:\n    may: [Search the notes]\n    may_not:\n` +
          `      - action: Add a long note\n        instead: Ask the person who wants it\n` +
          `        enforced_by: "approval:no_such"\n` +
          `      - action: Rewrite a note\n        instead: Add a replacement note\n`,
      ),
    );
    expectReported(withEnforcedByProblems, [
      "ROLE_SPEC.md › wisdom.authority.may_not[1].enforced_by: is required",
      "ROLE_SPEC.md › wisdom.authority.may_not[0].enforced_by: names approval:no_such, which is not a declared approval; add it to wisdom.approvals[] or enforce this another way",
      "ROLE_SPEC.md › evals[0].stubs.mystery_tool: is not a declared tool",
      "ROLE_SPEC.md › notes: is not a known field",
    ]);
    expect(issueAt(withEnforcedByProblems, "wisdom.authority.may_not[0].enforced_by")?.layer).toBe(
      "wisdom",
    );
  });

  it("refuses a business block that carries a role concern, and says where it belongs", () => {
    const result = parseRoleSpec(
      `${roleFrontmatter()}\nbusiness:\n  name: Example Co\n  approvals: []\n  tools: []\n---\n\n${fixtureBody()}`,
    );
    expectReported(result, [
      'ROLE_SPEC.md › business.approvals: "approvals" is the role\'s own; declare it at wisdom.approvals[]',
      'ROLE_SPEC.md › business.tools: "tools" is the role\'s own; declare it at role.tools[]',
    ]);
    // The separation message replaces the schema's "is not a known field" for the same key.
    expect(lines(result)).not.toContain("ROLE_SPEC.md › business.tools: is not a known field");
    expect(issueAt(result, "business.tools")?.layer).toBe("wisdom");
  });

  it("refuses a role block that carries one business's specifics", () => {
    const result = parseRoleSpec(
      fixtureSpec.replace(
        "  channels: [email, chat]\n",
        "  channels: [email, chat]\n  settings: { limits: { long_note: 900 } }\n",
      ),
    );
    expectReported(result, [
      'ROLE_SPEC.md › role.settings: "settings" belongs to one business, not to the role; declare it under business.settings',
    ]);
    expect(lines(result)).not.toContain("ROLE_SPEC.md › role.settings: is not a known field");

    const businessInAnEntry = parseRoleSpec(
      fixtureSpec.replace(
        "    - type: note.add\n      description: Add a note to the shared notes\n",
        "    - type: note.add\n      description: Add a note to the shared notes\n      agents_md: Notes are kept in the team's own words.\n",
      ),
    );
    expectReported(businessInAnEntry, [
      'ROLE_SPEC.md › workflow.accepts[0].agents_md: "agents_md" belongs to one business, not to the role; declare it under business.agents_md',
    ]);
    expect(lines(businessInAnEntry)).not.toContain(
      "ROLE_SPEC.md › workflow.accepts[0].agents_md: is not a known field",
    );
    expect(issueAt(businessInAnEntry, "workflow.accepts[0].agents_md")?.layer).toBe("workflow");
  });

  it("refuses a reference path that leaves the skill", () => {
    const result = parseRoleSpec(
      fixtureSpec.replace("        - path: style-table.md", "        - path: ../outside.md"),
    );
    expectReported(result, [
      'ROLE_SPEC.md › knowledge.skills[0].references[0].path: must stay inside the skill (got "../outside.md"); a reference never climbs with ".."',
    ]);
    expect(issueAt(result, "knowledge.skills[0].references[0].path")?.layer).toBe("knowledge");
  });

  it("holds the body to the word budget, with a warning before the limit", () => {
    const over = parseRoleSpec(withBody(words(1001)));
    expectReported(over, [
      "ROLE_SPEC.md › context (body): is 1001 words; keep the body under 1000 words and move the detail into a skill's instructions or one of its reference files",
    ]);
    expect(issueAt(over, "context (body)")?.severity).toBeUndefined();

    const near = parseRoleSpec(withBody(words(850)));
    expect(near.ok).toBe(true);
    expect(issueAt(near, "context (body)")?.severity).toBe("warning");
    expect(issueAt(near, "context (body)")?.layer).toBe("context");

    const empty = parseRoleSpec(withBody(""));
    expectReported(empty, ["ROLE_SPEC.md › context (body): is required:"]);
  });

  it("refuses a document that is not a spec at all", () => {
    expectReported(parseRoleSpec("# Notes\n\nJust a body.\n"), [
      "ROLE_SPEC.md: must start with YAML frontmatter between --- lines",
    ]);
    expectReported(parseRoleSpec("---\nschema: 1\nrole: [unclosed\n---\n\n# Notes\n"), [
      "ROLE_SPEC.md: frontmatter is not valid YAML:",
    ]);
    expectReported(parseRoleSpec("---\n- schema\n- role\n---\n\n# Notes\n"), [
      "ROLE_SPEC.md: frontmatter must be a mapping",
    ]);
    expectReported(parseRoleSpec(fixtureSpec.replace("schema: 1", "schema: 2")), [
      "ROLE_SPEC.md › schema: must be 1 (got 2)",
    ]);
  });

  it("gives a tool's own fields the layer they belong to", () => {
    // What the model reads about a tool is knowledge; what controls a call is wisdom.
    const result = parseRoleSpec(
      fixtureSpec
        .replace(
          "      description: Add a note to the shared notes and return its id.",
          "      description: 7",
        )
        .replace(
          "      replay: unsafe\n      engine: [add]",
          "      replay: maybe\n      engine: [add]",
        ),
    );
    expect(issueAt(result, "role.tools[1].description")?.layer).toBe("knowledge");
    expect(issueAt(result, "role.tools[1].replay")?.layer).toBe("wisdom");
  });

  it("refuses a name declared twice, and a tool the SDK or the Office already provides", () => {
    const twice = parseRoleSpec(
      fixtureSpec.replace("    - name: add_note", "    - name: search_notes"),
    );
    expectReported(twice, [
      'ROLE_SPEC.md › role.tools[1]: tool "search_notes" is declared more than once',
    ]);
    const reserved = parseRoleSpec(
      fixtureSpec.replace("    - name: add_note", "    - name: read_skill"),
    );
    expectReported(reserved, [
      'ROLE_SPEC.md › role.tools[1].name: "read_skill" is provided by the SDK; choose another name',
    ]);
    const generic = parseRoleSpec(fixtureSpec.replace("    - name: add_note", "    - name: bash"));
    expectReported(generic, [
      'ROLE_SPEC.md › role.tools[1].name: "bash" is a generic shell tool; a role registers no shell or file tool',
    ]);
  });

  it("accepts an approval that resolves and a prohibition that no tool can carry out", () => {
    // `no_tool` and `person_only` are claims about the world this parser cannot prove; the fixture
    // declares one of each beside an approval that resolves. The generated evals test them.
    const spec = parsed(fixtureSpec);
    expect(spec.wisdom.authority.may_not.map((entry) => entry.enforced_by)).toEqual([
      "approval:long_note",
      "person_only",
      "no_tool",
    ]);
  });
});

/** The fixture's spec with its body replaced, to test the body's own rules. */
function withBody(body: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n[\s\S]*$/.exec(fixtureSpec);
  if (match === null) throw new Error("the fixture spec must carry frontmatter");
  return `---\n${match[1] ?? ""}\n---\n\n${body}\n`;
}

/** A body of exactly `count` words, with no number anywhere in it. */
function words(count: number): string {
  return Array.from({ length: count }, (_, index) => `word${index}`).join(" ");
}

/** The fixture's frontmatter without its business block: the role's own blocks, for a test to add to. */
function roleFrontmatter(): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n[\s\S]*$/.exec(fixtureSpec);
  if (match === null) throw new Error("the fixture spec must carry frontmatter");
  return `---\n${(match[1] ?? "").replace(/\nbusiness:\n[\s\S]*$/, "")}`;
}

const fixtureBody = (): string =>
  fixtureSpec.slice(fixtureSpec.lastIndexOf("\n---\n") + "\n---\n".length);

/**
 * A document with every problem a spec can carry at once: an unknown top-level key, a bad `replay`, a
 * skill id that is not kebab-case, an unsafe tool with no approval decision, a threshold in the body,
 * an accepted ticket type with no evidence, and an eval that stubs a tool the role does not declare.
 * `wisdom` is swapped in whole, because the `may_not` problems live inside it.
 */
function brokenSpec(wisdom: string): string {
  return `---
schema: 1
role:
  id: sample-notes
  name: Sample Notes
  department: operations
  role: Keeps the team's shared notes
  defaultModel: { provider: paper, modelId: ultramarine-1-flash }
  tools:
    - { name: search_notes, replay: safe }
    - { name: add_note, replay: maybe }
    - { name: archive_note, replay: unsafe }
  connectors: []
  channels: [email]
  limits:
    long_note: { description: A long note, default: 1200 }
knowledge:
  skills:
    - id: Notes Desk
      description: How the notes read
      enabled_by_default: true
      instructions: Write it down.
wisdom:
${wisdom}workflow:
  accepts:
    - type: note.add
      description: Add a note
evals:
  - id: adds-a-note
    description: A person asks for a note
    input: { kind: message, text: Note this down. }
    stubs:
      search_notes: { text: "No matching notes" }
      mystery_tool: { text: "?" }
    expect: {}
notes: 3
---
# Notes

The desk adds a note of up to $2,500.
`;
}
