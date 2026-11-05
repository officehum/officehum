/**
 * The drift test: the company package is one source, and every copy of it under `agents/` is
 * generated. This regenerates the whole catalogue in memory, compares it byte for byte with what is
 * on disk, and fails with the command that fixes it. A copy edited by hand — or a price changed in
 * `company.json` and not synced — cannot survive `npm test`.
 *
 * It also holds the company package to its own promises: the figures in the prose against the
 * figures in the record, and the people an escalation points at.
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  COMPANY_DIRECTORY,
  companyIssues,
  drift,
  moneyAmounts,
  readSource,
  renderAll,
  renderFacts,
  roleDirectories,
  syncCompany,
  unexpectedFiles,
} from "./company.ts";

const temps: string[] = [];
afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** A temporary copy of the company package, so a test can break it without touching the real one. */
function copyCompany(): string {
  const directory = mkdtempSync(join(tmpdir(), "officehum-company-"));
  temps.push(directory);
  cpSync(join(root, COMPANY_DIRECTORY), join(directory, COMPANY_DIRECTORY), { recursive: true });
  return directory;
}

/**
 * A temporary catalogue: the company, and one role that declares the generated skill. Written here
 * rather than copied from `agents/` so the company's tests do not depend on any particular role.
 */
function catalogue(): string {
  const directory = copyCompany();
  const role = join(directory, "agents", "sales");
  mkdirSync(role, { recursive: true });
  writeFileSync(
    join(role, "officehum.json"),
    JSON.stringify({ skills: [{ id: "company-handbook", enabledByDefault: true }] }),
  );
  return directory;
}

/** Writes a modified copy of one company file, and returns the directory. */
function withFile(file: string, edit: (body: string) => string): string {
  const directory = copyCompany();
  const path = join(directory, COMPANY_DIRECTORY, file);
  writeFileSync(path, edit(readFileSync(path, "utf8")));
  return directory;
}

describe("the generated company copies", () => {
  it("renders the handbook into every role package under agents/", () => {
    const roles = roleDirectories(root);
    expect(roles.length).toBeGreaterThan(0);
    const files = renderAll(root);
    expect(files).toHaveLength(roles.length * 4);
    for (const role of roles) {
      const paths = files
        .map((file) => file.path)
        .filter((path) => path.includes(`agents/${role}/`));
      expect(paths).toEqual([
        `agents/${role}/skills/company-handbook/SKILL.md`,
        `agents/${role}/skills/company-handbook/references/pricing.md`,
        `agents/${role}/skills/company-handbook/references/policies.md`,
        `agents/${role}/skills/company-handbook/references/facts.json`,
      ]);
    }
  });

  it("matches every copy on disk byte for byte", () => {
    for (const file of renderAll(root)) {
      const onDisk = readFileSync(join(root, file.path), "utf8");
      expect(
        onDisk,
        `${file.path} has drifted from company/default/. Run \`npm run sync-company\` and commit the result; do not edit a generated copy.`,
      ).toBe(file.content);
    }
    expect(drift(root), "run `npm run sync-company` and commit the result").toEqual([]);
    expect(
      unexpectedFiles(root),
      "the handbook folder holds only generated files: delete these, and put the facts in company/default/",
    ).toEqual([]);
  });

  it("says a generated file is generated, and how to regenerate it", () => {
    for (const file of renderAll(root)) {
      expect(file.content).toContain("scripts/sync-company.ts");
      expect(file.content).toContain("npm run sync-company");
    }
  });

  it("carries the price book into the facts a role's code reads", () => {
    const facts = JSON.parse(renderFacts(readSource(root))) as {
      priceBook: { id: string; unitPriceCents: number }[];
      people: { id: string }[];
      approvalLimits: { quoteOverCents: number };
    };
    expect(facts.priceBook.length).toBeGreaterThan(10);
    expect(facts.priceBook.every((item) => Number.isSafeInteger(item.unitPriceCents))).toBe(true);
    expect(facts.people.map((person) => person.id)).toContain("marcus-oyelaran");
    expect(facts.approvalLimits.quoteOverCents).toBe(500000);
  });
});

describe("the company package's own consistency", () => {
  it("agrees with itself: people, prices, services, escalation and headcount", () => {
    expect(companyIssues(readSource(root))).toEqual([]);
  });

  it("refuses a price in the prose that the record does not hold", () => {
    const directory = withFile("pricing.md", (body) => `${body}\nA deep clean costs $999.99.\n`);
    const issues = companyIssues(readSource(directory));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("pricing.md");
    expect(issues[0]).toContain("$999.99");
    expect(issues[0]).toContain("company.json does not record");
  });

  it("refuses prose that leaves a price in the book unstated", () => {
    const directory = withFile("pricing.md", (body) => body.replace("$185.00", "a flat rate"));
    const issues = companyIssues(readSource(directory));
    expect(issues.some((issue) => issue.includes("18500 cents"))).toBe(true);
  });

  it("refuses an escalation to someone who does not work here", () => {
    const directory = withFile("company.json", (body) => {
      const company = JSON.parse(body) as { escalation: { toPersonId: string }[] };
      const first = company.escalation[0];
      if (first !== undefined) first.toPersonId = "nobody";
      return JSON.stringify(company, null, 2);
    });
    const issues = companyIssues(readSource(directory));
    expect(issues.some((issue) => issue.includes("escalation[0] goes to nobody"))).toBe(true);
  });

  it("refuses a headcount that the field structure does not add up to", () => {
    const directory = withFile("company.json", (body) => {
      const company = JSON.parse(body) as { profile: { headcount: number } };
      company.profile.headcount = 30;
      return JSON.stringify(company, null, 2);
    });
    expect(companyIssues(readSource(directory)).join("\n")).toContain(
      "the field structure adds up to 24",
    );
  });

  it("reads a figure as cents whether or not it carries a decimal point", () => {
    expect(moneyAmounts("$185.00 and $0.07 and $5,000")).toEqual([
      { text: "$185.00", cents: 18500 },
      { text: "$0.07", cents: 7 },
      { text: "$5,000", cents: 500000 },
    ]);
  });
});

describe("a hand-edited copy", () => {
  it("is reported as drift, and syncing puts the generated words back", () => {
    const directory = catalogue();
    expect(syncCompany(directory).written).toHaveLength(4);
    const path = "agents/sales/skills/company-handbook/SKILL.md";
    writeFileSync(join(directory, path), "We charge whatever feels right.\n");

    expect(drift(directory).map((file) => file.path)).toEqual([path]);

    const synced = syncCompany(directory);
    expect(synced.written).toEqual([path]);
    expect(drift(directory)).toEqual([]);
    expect(readFileSync(join(directory, path), "utf8")).toContain("Northwind Facilities");
  });

  it("reports a file added by hand beside the generated ones, which syncing would never remove", () => {
    const directory = catalogue();
    syncCompany(directory);
    expect(unexpectedFiles(directory)).toEqual([]);
    const extra = "agents/sales/skills/company-handbook/references/discounts.md";
    writeFileSync(join(directory, extra), "Partners get 30% off.\n");
    const nested = "agents/sales/skills/company-handbook/notes/extra.md";
    mkdirSync(join(directory, dirname(nested)), { recursive: true });
    writeFileSync(join(directory, nested), "More.\n");

    // Every generated copy is still byte for byte, so only this check sees the extra files.
    expect(drift(directory)).toEqual([]);
    expect(unexpectedFiles(directory)).toEqual([nested, extra]);
  });

  it("refuses a role that does not declare the skill it is about to be given", () => {
    const directory = catalogue();
    writeFileSync(join(directory, "agents", "sales", "officehum.json"), '{"skills": []}');
    expect(() => renderAll(directory)).toThrow(/does not declare the company-handbook skill/);
  });
});
