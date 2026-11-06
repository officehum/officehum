import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatIssue } from "./issues.js";
import {
  checkRoleMd,
  htmlToText,
  ROLE_MD_SECTIONS,
  type RoleSources,
  verifyRoleOnline,
} from "./role-md.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/role-md/${name}`, import.meta.url), "utf8");
const validMd = fixture("valid/role.md");
const sources = (): RoleSources => JSON.parse(fixture("valid/role.sources.json")) as RoleSources;
const pages: Record<string, string> = {
  "https://example.com/selling":
    "Selling   turns interest INTO agreed deals. A lead is qualified once need, budget, authority and timing are known. Do not overpromise.",
  "https://example.com/quoting":
    "A quote states price, scope and validity. Discounts need sign-off.",
};
// biome-ignore lint/suspicious/noExplicitAny: tests poke at deliberately malformed JSON
type Loose = any;
const loose = (): Loose => sources();
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

  it("a stray line under Sources is reported", () => {
    const issues = checkRoleMd(fixture("junk-under-sources.md"), sources());
    expect(issues).toHaveLength(1);
    expect(issues[0]?.source).toBe("role.md");
    expect(issues[0]?.path).toMatch(/^Sources › line \d+$/);
    expect(issues[0]?.message).toContain("Source licences");
  });

  it("a Source licences note after the entries is allowed", () => {
    expect(checkRoleMd(fixture("licence-note.md"), sources())).toEqual([]);
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
    const edited = loose();
    edited.claims[0].sources[0].passage = "x".repeat(401);
    const issues = checkRoleMd(validMd, edited);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.source).toBe("role.sources.json");
    expect(issues[0]?.path).toBe("claims[0].sources[0].passage");
    expect(issues[0]?.message).toContain("401");
  });

  it("an empty passage and an unknown source id are reported", () => {
    const edited = loose();
    edited.claims[0].sources[0].passage = "";
    edited.claims[1].sources[0].source = "S9";
    const text = lines(checkRoleMd(validMd, edited)).join("\n");
    expect(text).toContain("passage must be 1 to 400 characters");
    expect(text).toContain('"S9" is not a source');
  });

  it("a claim with no source is reported", () => {
    const edited = loose();
    edited.claims[0].sources = [];
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

describe("malformed role.sources.json", () => {
  const check = (mutate: (json: Loose) => void) => {
    const edited = loose();
    mutate(edited);
    return lines(checkRoleMd(validMd, edited as RoleSources));
  };

  it("reports a claim with no sources array instead of throwing", () => {
    expect(check((j) => delete j.claims[0].sources)).toEqual([
      expect.stringContaining("claims[0].sources: must be an array"),
    ]);
  });
  it("reports a missing or non-string passage instead of throwing", () => {
    expect(check((j) => delete j.claims[0].sources[0].passage)).toEqual([
      expect.stringContaining("claims[0].sources[0].passage: must be a string"),
    ]);
    expect(check((j) => (j.claims[0].sources[0].passage = 5))).toHaveLength(1);
  });
  it("reports a null element instead of throwing", () => {
    expect(check((j) => (j.sources[0] = null))).toEqual([
      expect.stringContaining("sources[0]: must be an object"),
    ]);
    expect(check((j) => (j.claims[1] = null))).toEqual([
      expect.stringContaining("claims[1]: must be an object"),
    ]);
    expect(check((j) => (j.claims[0].sources[0] = null))).toHaveLength(1);
  });
  it("reports a bad kind and a non-object file", () => {
    expect(check((j) => (j.sources[0].kind = "blog"))[0]).toContain("sources[0].kind");
    expect(lines(checkRoleMd(validMd, null as unknown as RoleSources))).toHaveLength(1);
  });
  it("verifyRoleOnline reports instead of throwing", async () => {
    const edited = loose();
    edited.claims[0] = null;
    expect(await verifyRoleOnline(edited, async () => "")).toHaveLength(1);
  });
});

describe("duplicates", () => {
  it("reports duplicate source ids, claim ids and sections with paths", () => {
    const edited = loose();
    edited.sources[1].id = "S1";
    edited.claims[1].id = "C1";
    const text = lines(checkRoleMd(`${validMd}\n## Measures\n\n- Again. [C1]\n`, edited));
    expect(text).toContain(
      "role.sources.json › sources[1].id: source id S1 is used twice; ids must be unique",
    );
    expect(text).toContain(
      "role.sources.json › claims[1].id: claim id C1 is used twice; ids must be unique",
    );
    expect(text.some((line) => line.includes('section "Measures" appears twice'))).toBe(true);
  });
});

describe("htmlToText", () => {
  const html = `<html><head><style>p{color:red}</style><script>var a="Discounts";</script></head>
    <body><h1>Quoting</h1><p>A quote states <em>price</em>, scope &amp; validity.</p>
    <p>Discounts&nbsp;need sign&#8209;off &mdash; it&rsquo;s policy &#x41;.</p></body></html>`;

  it("drops code, strips tags, decodes entities and folds punctuation", () => {
    const text = htmlToText(html).replace(/\s+/g, " ");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("var a");
    expect(text).toContain("A quote states price, scope & validity.");
    expect(text).toContain("it's policy A.");
  });

  it("verifyRoleOnline matches a passage across an inline tag and an entity", async () => {
    const edited = loose();
    edited.claims[2].sources[0].passage = "A quote states price, scope & validity.";
    edited.claims[3].sources[0].passage = "Discounts need sign\u2011off \u2014 it\u2019s policy";
    const page = async (url: string) => (url.endsWith("quoting") ? html : (pages[url] ?? ""));
    expect(await verifyRoleOnline(edited, page)).toEqual([]);
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
