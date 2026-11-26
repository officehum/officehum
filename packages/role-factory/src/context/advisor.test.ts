import { DEFAULT_PROMPT_BUDGET_TOKENS, ManifestSchema, schemaIssues } from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import {
  BUILT_TECHNIQUES,
  CONTEXT_RULES,
  type ContextProfile,
  ContextProfileSchema,
  RECOMMENDED_HISTORY_FILTER,
  type RoleFacts,
  recommendContext,
} from "./advisor.js";

/** A short back-office role with nothing special about its context: only C1 fires. */
const QUIET: ContextProfile = {
  speed: "back_office",
  reference_size: "none",
  figures: false,
  task_length: "minutes",
  tool_calls: 5,
  large_results: false,
  fan_out: 0,
  document_pages: 0,
  extracted_fields: false,
  strict_format: false,
  recurring_contacts: false,
  hand_offs: 0,
};
const FEW_TOOLS: RoleFacts = { tools: 3 };

const fired = (profile: ContextProfile, role: RoleFacts = FEW_TOOLS) =>
  recommendContext(profile, role).map((recommendation) => recommendation.rule);

/**
 * For each rule: profiles that trigger it, and profiles beside them that must not. Each differs from
 * the quiet profile only in what the rule reads, so a rule that fires on the wrong condition, or at the
 * wrong threshold, fails here. (C2 and C3 split the same answers between them, so a profile quiet for
 * one may fire the other.)
 */
const CASES: Record<
  string,
  {
    readonly fires: readonly [Partial<ContextProfile>, RoleFacts?][];
    readonly quiet: readonly [Partial<ContextProfile>, RoleFacts?][];
  }
> = {
  C2: {
    fires: [[{ reference_size: "small", reference_changes: "rarely" }]],
    quiet: [
      [{ reference_size: "small", reference_changes: "often" }],
      [{ reference_size: "large", reference_changes: "rarely" }],
      [{ reference_size: "none", reference_changes: "rarely" }],
      [{ reference_size: "small", reference_changes: "rarely", reference_business_specific: true }],
    ],
  },
  C3: {
    fires: [
      [{ reference_size: "large", reference_changes: "rarely" }],
      [{ reference_size: "small", reference_changes: "often" }],
      [{ reference_size: "small", reference_changes: "rarely", reference_business_specific: true }],
    ],
    quiet: [
      [
        {
          reference_size: "small",
          reference_changes: "rarely",
          reference_business_specific: false,
        },
      ],
      // Answers about material the role does not have are not read.
      [{ reference_size: "none", reference_changes: "often", reference_business_specific: true }],
    ],
  },
  C4: {
    fires: [[{ reference_size: "small", reference_tables: true }]],
    quiet: [
      [{ reference_size: "small", reference_tables: false }],
      [{ reference_size: "none", reference_tables: true }],
    ],
  },
  C5: { fires: [[{ figures: true }]], quiet: [[{ figures: false }]] },
  C6: {
    fires: [[{ tool_calls: 21 }], [{ task_length: "days" }], [{ large_results: true }]],
    quiet: [[{ tool_calls: 20 }], [{ task_length: "hours" }]],
  },
  C7: {
    fires: [[{ fan_out: 20 }], [{ document_pages: 31 }]],
    quiet: [[{ fan_out: 19 }], [{ document_pages: 30 }]],
  },
  C8: { fires: [[{ extracted_fields: true }]], quiet: [[{ extracted_fields: false }]] },
  C9: { fires: [[{ speed: "real_time" }]], quiet: [[{ speed: "back_office" }]] },
  C10: { fires: [[{ recurring_contacts: true }]], quiet: [[{ recurring_contacts: false }]] },
  C11: { fires: [[{}, { tools: 16 }]], quiet: [[{}, { tools: 15 }]] },
  C12: { fires: [[{ hand_offs: 3 }]], quiet: [[{ hand_offs: 2 }]] },
  C13: { fires: [[{ strict_format: true }]], quiet: [[{ strict_format: false }]] },
};

describe("recommendContext", () => {
  it("has a case for every rule but C1, which always fires", () => {
    expect(Object.keys(CASES)).toEqual(CONTEXT_RULES.slice(1).map((rule) => rule.id));
  });

  it("recommends only the prompt budget for a role with nothing special about its context", () => {
    expect(fired(QUIET)).toEqual(["C1"]);
  });

  for (const [id, cases] of Object.entries(CASES)) {
    it(`fires ${id} on the profiles that call for it, and not on the ones beside them`, () => {
      for (const [change, role] of cases.fires) {
        expect(fired({ ...QUIET, ...change }, role), JSON.stringify(change)).toContain(id);
      }
      for (const [change, role] of cases.quiet) {
        expect(fired({ ...QUIET, ...change }, role), JSON.stringify(change)).not.toContain(id);
      }
    });
  }

  it("sets the prompt budget lower for a role that answers customers in real time", () => {
    const [back] = recommendContext(QUIET, FEW_TOOLS);
    const [real] = recommendContext({ ...QUIET, speed: "real_time" }, FEW_TOOLS);
    expect(back?.config).toBe(DEFAULT_PROMPT_BUDGET_TOKENS);
    expect(real?.config).toBe(3000);
    expect(back?.reason).toContain("4,000 tokens");
    expect(real?.reason).toContain("3,000 tokens");
    expect(real?.reason).toContain("real time");
  });

  it("gives every built technique a config the SDK's own schema accepts, and no other a config", () => {
    const everything: ContextProfile = {
      speed: "real_time",
      reference_size: "large",
      reference_changes: "often",
      reference_business_specific: true,
      reference_tables: true,
      figures: true,
      task_length: "days",
      tool_calls: 40,
      large_results: true,
      fan_out: 50,
      document_pages: 80,
      extracted_fields: true,
      strict_format: true,
      recurring_contacts: true,
      hand_offs: 4,
    };
    expect(schemaIssues(ContextProfileSchema, everything, "profile")).toEqual([]);
    const all = recommendContext(everything, { tools: 20 });
    // Every rule but C2, which wants small material, fires on this profile.
    expect(all.map((recommendation) => recommendation.rule)).toEqual(
      CONTEXT_RULES.filter((rule) => rule.id !== "C2").map((rule) => rule.id),
    );
    const fields = ManifestSchema.properties.contextPlan.properties;
    for (const recommendation of all) {
      const built = (BUILT_TECHNIQUES as readonly string[]).includes(recommendation.technique);
      expect(recommendation.reason).toMatch(/^[A-Z].+\.$/);
      if (built) {
        expect(recommendation.unavailable).toBeUndefined();
        const schema = fields[recommendation.technique as keyof typeof fields];
        expect(schemaIssues(schema, recommendation.config, "plan")).toEqual([]);
      } else {
        expect(recommendation.config).toBeUndefined();
        expect(recommendation.unavailable).toMatch(/not available yet|nothing to/);
      }
    }
    expect(all.find((recommendation) => recommendation.rule === "C6")?.config).toEqual(
      RECOMMENDED_HISTORY_FILTER,
    );
  });

  it("quotes the profile in its reasons", () => {
    const [, filter] = recommendContext({ ...QUIET, tool_calls: 35 }, FEW_TOOLS);
    expect(filter?.reason).toBe(
      "A task takes about 35 tool calls, so older long results are shortened to a line it can recall, and the ids it cites are kept.",
    );
    const [, fanOut] = recommendContext({ ...QUIET, fan_out: 40, document_pages: 60 }, FEW_TOOLS);
    expect(fanOut?.reason).toContain("up to 40 similar items and it reads documents of up to 60");
    const [, tools] = recommendContext(QUIET, { tools: 18 });
    expect(tools?.reason).toContain("18 tools");
  });

  it("marks sub-agents, retrieval and memory as not available yet", () => {
    const shown = recommendContext(
      { ...QUIET, fan_out: 25, reference_size: "large", recurring_contacts: true },
      FEW_TOOLS,
    );
    expect(
      shown.map((recommendation) => [recommendation.rule, recommendation.unavailable]),
    ).toEqual([
      ["C1", undefined],
      ["C3", "not available yet"],
      ["C7", "not available yet"],
      ["C10", "not available yet"],
    ]);
  });
});
