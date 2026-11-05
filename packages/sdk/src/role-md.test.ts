import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatIssue } from "./issues.js";
import { checkRoleMd, ROLE_MD_SECTIONS, type RoleSources, verifyRoleOnline } from "./role-md.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/role-md/${name}`, import.meta.url), "utf8");
const validMd = fixture("valid/role.md");
const sources = (): RoleSources => JSON.parse(fixture("valid/role.sources.json")) as RoleSources;
const lines = (issues: readonly { source: string; path: string; message: string }[]) =>
  issues.map(formatIssue);

describe("checkRoleMd", () => {
  it("the valid fixture has no issues", () => {
    expect(checkRoleMd(validMd, sources())).toEqual([]);
    expect(ROLE_MD_SECTIONS).toHaveLength(9);
  });

  it("an uncited list item is reported", () => {
    const issues = checkRoleMd(fixture("uncited-item.md"), sources());
    expect(issues).toHaveLength(1);
    expect(issues[0]?.source).toBe("role.md");
    expect(issues[0]?.path).toBe("Responsibilities and actions › line 9");
    expect(issues[0]?.message).toContain("claim marker");
  });

  it("a marker for a missing claim is reported", () => {
    const issues = checkRoleMd(fixture("missing-claim.md"), sources());
    expect(lines(issues)).toEqual([
      expect.stringContaining('C9" is not a claim in role.sources.json'),
    ]);
  });

  it("a listed but uncited source is reported", () => {
    const edited = sources();
    edited.claims = edited.claims.map((claim) => ({
      ...claim,
      sources: claim.sources.filter((entry) => entry.source !== "S2"),
    }));
    edited.claims = edited.claims.filter((claim) => claim.sources.length > 0);
    const markdown = validMd.replace("[C3, C4]", "[C4]").replace("[C1, C3]", "[C1]");
    const issues = checkRoleMd(markdown, edited);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.source).toBe("role.sources.json");
    expect(issues[0]?.path).toBe("sources[1]");
    expect(issues[0]?.message).toContain("S2");
  });

  it("a passage over 400 characters is reported", () => {
    const edited = sources();
    edited.claims[0]!.sources[0]!.passage = "x".repeat(401);
    const issues = checkRoleMd(validMd, edited);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.source).toBe("role.sources.json");
    expect(issues[0]?.path).toBe("claims[0].sources[0].passage");
    expect(issues[0]?.message).toContain("401");
  });

  it("an empty passage and an unknown source id are reported", () => {
    const edited = sources();
    edited.claims[0]!.sources[0]!.passage = "";
    edited.claims[1]!.sources[0]!.source = "S9";
    const text = lines(checkRoleMd(validMd, edited)).join("\n");
    expect(text).toContain("passage must be 1 to 400 characters");
    expect(text).toContain('"S9" is not a source');
  });

  it("a claim with no source is reported", () => {
    const edited = sources();
    edited.claims[0]!.sources = [];
    const text = lines(checkRoleMd(validMd, edited)).join("\n");
    expect(text).toContain("claims[0].sources");
  });

  it("a missing section is reported", () => {
    const issues = checkRoleMd(fixture("missing-section.md"), sources());
    expect(lines(issues)).toEqual([
      expect.stringContaining('role.md: section "Terminology" is missing'),
    ]);
  });

  it("an out-of-order section is reported", () => {
    const issues = checkRoleMd(fixture("out-of-order.md"), sources());
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((issue) => issue.message.includes("order"))).toBe(true);
  });

  it("every problem is reported, not just the first", () => {
    const issues = checkRoleMd(fixture("three-faults.md"), sources());
    expect(issues).toHaveLength(3);
  });
});

describe("verifyRoleOnline", () => {
  const pages: Record<string, string> = {
    "https://example.com/selling":
      "Selling   turns interest INTO agreed deals. A lead is qualified once need, budget, authority and timing are known. Do not overpromise.",
    "https://example.com/quoting":
      "A quote states price, scope and validity. Discounts need sign-off.",
  };

  it("passes when every passage is on its page, ignoring whitespace and case", async () => {
    expect(await verifyRoleOnline(sources(), async (url) => pages[url] ?? "")).toEqual([]);
  });

  it("reports only the claim whose passage is gone", async () => {
    const issues = await verifyRoleOnline(sources(), async (url) =>
      (pages[url] ?? "").replace("Discounts need sign-off.", ""),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("C4");
    expect(issues[0]?.message).toContain("https://example.com/quoting");
  });

  it("reports a page that cannot be fetched once per claim passage", async () => {
    const issues = await verifyRoleOnline(sources(), async (url) => {
      if (url.endsWith("quoting")) throw new Error("HTTP 404");
      return pages[url] ?? "";
    });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((issue) => issue.message.includes("HTTP 404"))).toBe(true);
  });
});
