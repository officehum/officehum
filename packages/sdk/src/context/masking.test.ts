import type { PromptSection, ToolRegistration } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import sampleManifest from "../../fixtures/sample-desk/officehum.json" with { type: "json" };
import { defineRole } from "../role.js";
import { removeTempDirs, SAMPLE_DIR, skillFile, tempDir } from "../test-helpers.js";
import { MASKED_AMOUNT, maskAmounts } from "./masking.js";

afterEach(removeTempDirs);

const M = MASKED_AMOUNT;

describe("maskAmounts", () => {
  it("masks currency amounts and numbers next to currency words", () => {
    expect(maskAmounts("Invoices over $2,500 need a second look.")).toBe(
      `Invoices over ${M} need a second look.`,
    );
    expect(maskAmounts("A fee of €12.50, or USD 1,200, or 300 dollars, or 45 cents.")).toBe(
      `A fee of ${M}, or ${M}, or ${M}, or ${M}.`,
    );
    expect(maskAmounts("Budget: 2,500 GBP; deposit £40k.")).toBe(`Budget: ${M}; deposit ${M}.`);
  });

  it("leaves counts, dates and codes alone", () => {
    const text = "Offer at most 2 slots on 2026-11-23 for SKU BOLT-10, ticket 42.";
    expect(maskAmounts(text)).toBe(text);
  });

  it("leaves a code block marked no-mask exactly as written, and masks other blocks", () => {
    const text = [
      "Example:",
      "```json no-mask",
      '{ "amount": "$2,500" }',
      "```",
      "```",
      "total $99",
      "```",
    ].join("\n");
    expect(maskAmounts(text)).toBe(
      [
        "Example:",
        "```json no-mask",
        '{ "amount": "$2,500" }',
        "```",
        "```",
        `total ${M}`,
        "```",
      ].join("\n"),
    );
  });
});

/** The sample desk with an overlay skill whose instructions and reference carry sample amounts. */
function deskWith(maskAmountsFlag: boolean | undefined) {
  const overlay = tempDir("acme", {
    "skills/late-fees/SKILL.md": skillFile(
      "name: late-fees\ndescription: Charge a late fee. Use when a payment is past due by $50 or more.",
      "Charge $2,500 for a late cancellation. See references/table.md.",
    ),
    "skills/late-fees/references/table.md": "| Days late | Fee |\n| 30 | 300 dollars |\n",
  });
  const contextPlan = {
    ...sampleManifest.contextPlan,
    ...(maskAmountsFlag === undefined ? {} : { maskAmounts: maskAmountsFlag }),
  };
  return defineRole({
    packageDir: SAMPLE_DIR,
    manifest: { ...sampleManifest, contextPlan },
    overlays: [overlay],
    tools: [],
  });
}

async function call(tools: readonly ToolRegistration[] | undefined, args: object) {
  const tool = tools?.find((candidate) => candidate.name === "read_skill");
  if (tool === undefined) throw new Error("no read_skill");
  const result = await tool.execute(args as never, {} as never, {} as never);
  const [first] = result.output ?? [];
  return first?.type === "text" ? first.text : "";
}

async function skillsSection(sections: readonly PromptSection[] | undefined) {
  const skills = sections?.find((candidate) => candidate.key === "skills");
  return await skills?.render({} as never, {} as never);
}

describe("amount masking in read_skill", () => {
  it("masks a skill's instructions and references when maskAmounts is true; the index is unchanged", async () => {
    const masked = deskWith(true).extensions[0];
    const plain = deskWith(undefined).extensions[0];
    expect(await call(masked?.tools, { name: "late-fees" })).toBe(
      `Charge ${M} for a late cancellation. See references/table.md.`,
    );
    expect(await call(masked?.tools, { name: "late-fees", file: "references/table.md" })).toBe(
      `| Days late | Fee |\n| 30 | ${M} |\n`,
    );
    const index = await skillsSection(masked?.sections);
    expect(index).toContain("past due by $50 or more");
    expect(index).toBe(await skillsSection(plain?.sections));
  });

  it("masks nothing when maskAmounts is false or not declared", async () => {
    for (const flag of [false, undefined]) {
      const tools = deskWith(flag).extensions[0]?.tools;
      expect(await call(tools, { name: "late-fees" })).toBe(
        "Charge $2,500 for a late cancellation. See references/table.md.",
      );
    }
  });
});
