import { readFileSync } from "node:fs";
import { formatIssue, validateManifest } from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { manifestFromRoleSpec, parseRoleSpec, type RoleSpec } from "../spec.js";
import { type ContextProfile, recommendContext } from "./advisor.js";
import type { ContextPlanEntry } from "./plan.js";

const NOTES = readFileSync(
  new URL("../../fixtures/sample-notes/ROLE_SPEC.md", import.meta.url),
  "utf8",
);
const NOTES_MANIFEST = JSON.parse(
  readFileSync(new URL("../../fixtures/sample-notes/officehum.json", import.meta.url), "utf8"),
);

const PROFILE: ContextProfile = {
  speed: "back_office",
  reference_size: "large",
  reference_changes: "often",
  figures: true,
  task_length: "hours",
  tool_calls: 30,
  large_results: true,
  fan_out: 25,
  document_pages: 0,
  extracted_fields: false,
  strict_format: false,
  recurring_contacts: true,
  hand_offs: 1,
};

/** The advisor's plan for the profile, with the given rules accepted. */
function planFor(profile: ContextProfile, accept: readonly string[]): ContextPlanEntry[] {
  return recommendContext(profile, { tools: 3 }).map((recommendation) => ({
    rule: recommendation.rule,
    technique: recommendation.technique,
    reason: recommendation.reason,
    accepted: accept.includes(recommendation.rule),
    ...(recommendation.config === undefined ? {} : { config: recommendation.config }),
  }));
}

/** The Sample Notes spec with its frontmatter changed by `edit`. */
function notesWith(edit: (frontmatter: Record<string, unknown>) => void): string {
  const [, yaml = "", body = ""] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(NOTES) ?? [];
  const frontmatter = parse(yaml) as Record<string, unknown>;
  edit(frontmatter);
  return `---\n${stringify(frontmatter, { lineWidth: 0 })}---\n${body}`;
}

/** Stubs `context_recall` in every scenario: evals stub every tool the manifest declares. */
function stubRecall(frontmatter: Record<string, unknown>): void {
  for (const scenario of frontmatter.evals as { stubs: Record<string, unknown> }[]) {
    scenario.stubs.context_recall = { text: "context_recall: ran in this evaluation" };
  }
}

function parsed(text: string): RoleSpec {
  const result = parseRoleSpec(text);
  if (!result.ok) throw new Error(result.issues.map(formatIssue).join("\n"));
  return result.value;
}

function refused(text: string): string[] {
  const result = parseRoleSpec(text);
  expect(result.ok).toBe(false);
  return result.issues.map(formatIssue);
}

describe("context_plan in ROLE_SPEC.md", () => {
  it("writes the accepted built techniques into contextPlan, and context_recall with the filter", () => {
    const spec = parsed(
      notesWith((frontmatter) => {
        frontmatter.context_profile = PROFILE;
        frontmatter.context_plan = planFor(PROFILE, ["C1", "C6"]);
        stubRecall(frontmatter);
      }),
    );
    const manifest = manifestFromRoleSpec(spec);
    expect(manifest.contextPlan).toEqual({
      promptBudgetTokens: 4000,
      historyFilter: { keepRecentRounds: 2, keepCitedIds: true, maxToolResultTokens: 200 },
    });
    // C5 (masking) was declined, and retrieval, sub-agents and memory are shown but not built.
    expect(manifest.contextPlan).not.toHaveProperty("maskAmounts");
    expect(manifest.tools.at(-1)).toEqual({ name: "context_recall", replay: "safe" });
    const validated = validateManifest(manifest);
    expect(validated.issues.map(formatIssue)).toEqual([]);

    // Everything else is the manifest the spec merged to before it had a plan.
    const { contextPlan: _plan, tools, ...rest } = manifest;
    const { $schema: _schema, tools: notesTools, ...notesRest } = NOTES_MANIFEST;
    expect(rest).toEqual(notesRest);
    expect(tools.slice(0, -1)).toEqual(notesTools);
  });

  it("writes masking alone, with no context_recall, when only it is accepted", () => {
    const manifest = manifestFromRoleSpec(
      parsed(
        notesWith((frontmatter) => {
          frontmatter.context_plan = planFor(PROFILE, ["C5"]);
        }),
      ),
    );
    expect(manifest.contextPlan).toEqual({ maskAmounts: true });
    expect(manifest.tools.map((tool) => tool.name)).not.toContain("context_recall");
    expect(validateManifest(manifest).ok).toBe(true);
  });

  it("asks the spec's own scenarios to stub the context_recall the filter brings", () => {
    const lines = refused(
      notesWith((frontmatter) => {
        frontmatter.context_plan = planFor(PROFILE, ["C6"]);
      }),
    );
    expect(lines[0]).toBe(
      'ROLE_SPEC.md › evals[0].stubs: must stub "context_recall" here or in the file\'s top-level stubs; evals never call real tools',
    );
  });

  it("merges a spec with no plan, or with every recommendation declined, exactly as before", () => {
    const { $schema: _schema, ...NOTES_MERGED } = NOTES_MANIFEST;
    expect(manifestFromRoleSpec(parsed(NOTES))).toEqual(NOTES_MERGED);
    const declined = parsed(
      notesWith((frontmatter) => {
        frontmatter.context_profile = PROFILE;
        frontmatter.context_plan = planFor(PROFILE, []);
      }),
    );
    expect(manifestFromRoleSpec(declined)).toEqual(NOTES_MERGED);
  });

  it("refuses an accepted technique that is not built, saying what it waits on", () => {
    const plan = planFor(PROFILE, ["C1"]).map((entry) =>
      entry.rule === "C7" || entry.rule === "C3" ? { ...entry, accepted: true } : entry,
    );
    const lines = refused(
      notesWith((frontmatter) => {
        frontmatter.context_plan = plan;
      }),
    );
    const at = (rule: string) => plan.findIndex((entry) => entry.rule === rule);
    expect(lines).toEqual([
      `ROLE_SPEC.md › context_plan[${at("C3")}].accepted: "retrieval" cannot be switched on: not available yet; set accepted to false`,
      `ROLE_SPEC.md › context_plan[${at("C7")}].accepted: "subagents" cannot be switched on: not available yet; set accepted to false`,
    ]);
  });

  it("refuses config the SDK's schema refuses, config where none belongs, and none where it must be", () => {
    const plan: unknown[] = [
      {
        rule: "C6",
        technique: "historyFilter",
        reason: "Long tasks.",
        accepted: true,
        config: { keepRecentRounds: -1, keepCitedIds: true, maxToolResultTokens: 200 },
      },
      {
        rule: "C10",
        technique: "memorySubjects",
        reason: "Same people.",
        accepted: false,
        config: ["customer"],
      },
      { rule: "C1", technique: "promptBudgetTokens", reason: "Small prompt.", accepted: true },
    ];
    const lines = refused(
      notesWith((frontmatter) => {
        frontmatter.context_plan = plan;
        stubRecall(frontmatter);
      }),
    );
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^ROLE_SPEC\.md › context_plan\[0\]\.config\.keepRecentRounds: /);
    expect(lines[1]).toBe(
      'ROLE_SPEC.md › context_plan[1].config: "memorySubjects" has nothing to configure: not available yet',
    );
    expect(lines[2]).toBe(
      'ROLE_SPEC.md › context_plan[2]: "promptBudgetTokens" needs its config: the value contextPlan.promptBudgetTokens is given',
    );
  });

  it("refuses an unknown rule, a technique that is not its rule's, and one accepted twice", () => {
    const plan = [
      { rule: "C99", technique: "maskAmounts", reason: "Figures.", accepted: false, config: true },
      {
        rule: "C5",
        technique: "historyFilter",
        reason: "Figures.",
        accepted: false,
        config: { keepRecentRounds: 2, keepCitedIds: true, maxToolResultTokens: 200 },
      },
      { rule: "C5", technique: "maskAmounts", reason: "Figures.", accepted: true, config: true },
      {
        rule: "C5",
        technique: "maskAmounts",
        reason: "Figures again.",
        accepted: true,
        config: true,
      },
    ];
    expect(
      refused(
        notesWith((frontmatter) => {
          frontmatter.context_plan = plan;
        }),
      ),
    ).toEqual([
      'ROLE_SPEC.md › context_plan[0].rule: "C99" is not a rule of the context advisor',
      'ROLE_SPEC.md › context_plan[1].technique: rule C5 recommends "maskAmounts", not "historyFilter"',
      'ROLE_SPEC.md › context_plan[3].accepted: "maskAmounts" is already accepted at context_plan[2]; accept it once',
    ]);
  });

  it("refuses a context_recall declared by hand without the filter, through the SDK's own rule", () => {
    const lines = refused(
      notesWith((frontmatter) => {
        const role = frontmatter.role as { tools: unknown[] };
        role.tools.push({ name: "context_recall", replay: "safe" });
        frontmatter.context_plan = planFor(PROFILE, ["C1"]);
      }),
    );
    expect(lines).toContain(
      'ROLE_SPEC.md › role.tools[3]: "context_recall" comes with contextPlan.historyFilter; declare a historyFilter or remove the tool',
    );
    // Declared by hand with the filter accepted, it is the one the generator would have written.
    const spec = parsed(
      notesWith((frontmatter) => {
        const role = frontmatter.role as { tools: unknown[] };
        role.tools.push({ name: "context_recall", replay: "safe" });
        frontmatter.context_plan = planFor(PROFILE, ["C6"]);
        stubRecall(frontmatter);
      }),
    );
    const tools = manifestFromRoleSpec(spec).tools.map((tool) => tool.name);
    expect(tools.filter((name) => name === "context_recall")).toHaveLength(1);
  });

  it("refuses a reason left blank and a profile with an unknown answer", () => {
    const lines = refused(
      notesWith((frontmatter) => {
        frontmatter.context_profile = { ...PROFILE, speed: "sometimes" };
        frontmatter.context_plan = [
          { rule: "C5", technique: "maskAmounts", reason: "", accepted: true, config: true },
        ];
      }),
    );
    expect(lines.some((line) => line.startsWith("ROLE_SPEC.md › context_profile.speed"))).toBe(
      true,
    );
    expect(lines.some((line) => line.startsWith("ROLE_SPEC.md › context_plan[0].reason"))).toBe(
      true,
    );
  });
});
