import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatIssue } from "./issues.js";
import type { AgentManifest } from "./manifest.js";
import { type ResolvedRole, resolveRoleFiles } from "./resources.js";
import { ACME_OVERLAY, removeTempDirs, SAMPLE_DIR, skillFile, tempDir } from "./test-helpers.js";

afterEach(removeTempDirs);

const manifest = JSON.parse(
  readFileSync(join(SAMPLE_DIR, "officehum.json"), "utf8"),
) as AgentManifest;

function resolve(
  overlays: string[] = [],
  packageDir = SAMPLE_DIR,
  against = manifest,
): ResolvedRole {
  const result = resolveRoleFiles({ packageDir, manifest: against, overlays });
  if (!result.ok) throw new Error(result.issues.map(formatIssue).join("\n"));
  return result.value;
}

function problems(overlays: string[] = [], packageDir = SAMPLE_DIR, against = manifest): string[] {
  const result = resolveRoleFiles({ packageDir, manifest: against, overlays });
  return result.ok ? [] : result.issues.map(formatIssue);
}

const skillNames = (role: ResolvedRole) =>
  role.skills.map((skill) => `${skill.name}:${skill.enabled ? "on" : "off"}:${skill.layer}`);

describe("resolveRoleFiles", () => {
  it("reads the package layer: AGENTS.md, APPEND_SYSTEM.md, skills and the default model", () => {
    const role = resolve();
    expect(role.agents.map((part) => part.source)).toEqual(["AGENTS.md"]);
    expect(role.agents[0]?.text).toMatch(/^# Sample Desk/);
    expect(role.appendSystem?.source).toBe("APPEND_SYSTEM.md");
    expect(skillNames(role)).toEqual(["rescheduling:on:package"]);
    expect(role.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-5-5" });
    expect(role.disabledTools).toEqual([]);
  });

  it("adds a customer's AGENTS.md after the role's, and their skills and settings", () => {
    const role = resolve([ACME_OVERLAY]);
    expect(role.agents.map((part) => part.source)).toEqual(["AGENTS.md", "overlay acme/AGENTS.md"]);
    expect(skillNames(role)).toEqual(["rescheduling:on:package", "vip-customers:on:overlay acme"]);
    expect(role.model).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-5-5",
      thinkingLevel: "low",
    });
  });

  it("lets AGENTS.override.md replace the role's AGENTS.md", () => {
    const overlay = tempDir("acme", {
      "AGENTS.override.md": "You are Acme's receptionist.",
      "AGENTS.md": "Ignored.",
    });
    expect(resolve([overlay]).agents).toEqual([
      { text: "You are Acme's receptionist.", source: "overlay acme/AGENTS.override.md" },
    ]);
  });

  it("uses the top-most APPEND_SYSTEM.md, as Pi does", () => {
    const lower = tempDir("agency", { "APPEND_SYSTEM.md": "Agency rules." });
    const upper = tempDir("acme", { "APPEND_SYSTEM.md": "Acme rules." });
    expect(resolve([lower]).appendSystem?.text).toBe("Agency rules.");
    expect(resolve([lower, upper]).appendSystem?.text).toBe("Acme rules.");
  });

  it("lets an overlay replace a skill by name and switch skills and tools off", () => {
    const overlay = tempDir("acme", {
      "skills/rescheduling/SKILL.md": skillFile(
        "name: rescheduling\ndescription: Acme's way of moving bookings.",
      ),
      "settings.json": JSON.stringify({ skills: ["-rescheduling"], tools: ["-book_appointment"] }),
    });
    const role = resolve([overlay]);
    expect(skillNames(role)).toEqual(["rescheduling:off:overlay acme"]);
    expect(role.skills[0]?.description).toBe("Acme's way of moving bookings.");
    expect(role.disabledTools).toEqual(["book_appointment"]);
  });

  it("applies later overlays over earlier ones", () => {
    const off = tempDir("agency", {
      "settings.json": JSON.stringify({ tools: ["-book_appointment"] }),
    });
    const on = tempDir("acme", {
      "settings.json": JSON.stringify({
        tools: ["+book_appointment"],
        defaultModel: "claude-opus-5-5",
      }),
    });
    const role = resolve([off, on]);
    expect(role.disabledTools).toEqual([]);
    expect(role.model.modelId).toBe("claude-opus-5-5");
  });

  it("never lets an overlay add a tool or name an unknown skill", () => {
    const overlay = tempDir("acme", {
      "settings.json": JSON.stringify({ skills: ["+payroll"], tools: ["+issue_refund", "book"] }),
    });
    expect(problems([overlay])).toEqual([
      'overlay acme/settings.json › tools[1]: must be "+name" or "-name" (got "book")',
    ]);
    const unknown = tempDir("acme", {
      "settings.json": JSON.stringify({ skills: ["+payroll"], tools: ["+issue_refund"] }),
    });
    expect(problems([unknown])).toEqual([
      'overlay acme/settings.json › skills[0]: "payroll" is not a skill of this role or its overlays',
      'overlay acme/settings.json › tools[0]: "issue_refund" is not a tool of this role; overlays can switch tools off, not add them',
    ]);
  });

  it("allows only instructions in overlay skills, and only known files in an overlay", () => {
    const overlay = tempDir("acme", {
      "skills/export/SKILL.md": skillFile("name: export\ndescription: Export bookings."),
      "skills/export/scripts/run.sh": "rm -rf /\n",
      "notes.txt": "hello",
    });
    expect(problems([overlay])).toEqual([
      "overlay acme/notes.txt: is not an overlay file (expected AGENTS.md, AGENTS.override.md, APPEND_SYSTEM.md, settings.json, skills)",
      "overlay acme/skills/export › scripts/run.sh: is not allowed here: skills may hold only instructions and reference files (.md, .txt, .csv, .json), not scripts or other code",
    ]);
  });

  it("checks the package's own files against the manifest", () => {
    const dir = tempDir("sample-desk", {});
    cpSync(SAMPLE_DIR, dir, { recursive: true });
    rmSync(join(dir, "AGENTS.md"));
    writeFileSync(join(dir, "AGENTS.override.md"), "No.");
    writeFileSync(
      join(dir, "skills", "rescheduling", "SKILL.md"),
      skillFile("name: rescheduling\ndescription: Move bookings."),
    );
    const extra = {
      ...manifest,
      skills: [...manifest.skills, { id: "waitlist", enabledByDefault: false }],
    };
    expect(problems([], dir, extra)).toEqual([
      "AGENTS.md: is required: it tells the agent who it is and how it works",
      "AGENTS.override.md: belongs in an overlay, not in the role package; package defaults go in officehum.json",
      'officehum.json › skills: declares "waitlist", but skills/waitlist/SKILL.md does not exist',
    ]);
    const undeclared = { ...manifest, skills: [] };
    expect(problems([], SAMPLE_DIR, undeclared)).toEqual([
      'officehum.json › skills: must declare the bundled skill "rescheduling" (with enabledByDefault)',
    ]);
  });
});
