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

  it("the handbook makes no promise of contact", () => {
    // A role can say a person has a request only when a tool result says so (RASF-3482), so the
    // handbook it reads must never tell it to promise that someone will reply.
    const promises = [
      "has gone to a person",
      "by when they will come back",
      "will come back to them",
      "come back to you",
      "and when he will answer",
    ];
    for (const file of renderAll(root)) {
      const text = file.content.toLowerCase();
      for (const promise of promises) {
        expect(text.includes(promise), `${file.path} says "${promise}"`).toBe(false);
      }
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

// biome-ignore lint/suspicious/noExplicitAny: the tests edit arbitrary parts of the company JSON
type Loose = Record<string, any>;

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

  it("refuses two people who both hold a head title, with both paths", () => {
    const directory = withFile("company.json", (body) => {
      const company = JSON.parse(body) as { people: { title: string }[] };
      const second = company.people[1];
      if (second !== undefined) second.title = "Owner";
      return JSON.stringify(company, null, 2);
    });
    const issues = companyIssues(readSource(directory));
    expect(issues).toEqual([
      'company/default/company.json: people[1] (marcus-oyelaran) has the head title "Owner", and so does people[0] (dana-whitfield) ("Managing Director"); only one person may head the company (managing director, owner, president or chief executive)',
    ]);
  });

  it("does not count a title that only contains a head's words as a second head", () => {
    // Vice President, Product Owner and Co-owner are not the head of the company.
    for (const title of [
      "Vice President, Sales",
      "Product Owner",
      "Co-owner",
      "Assistant to the Managing Director",
    ]) {
      const directory = withFile("company.json", (body) => {
        const company = JSON.parse(body) as { people: { title: string }[] };
        const second = company.people[1];
        if (second !== undefined) second.title = title;
        return JSON.stringify(company, null, 2);
      });
      const issues = companyIssues(readSource(directory));
      expect(
        issues.filter((issue) => issue.includes("head title")),
        title,
      ).toEqual([]);
    }
  });

  it("refuses an unknown department", () => {
    const directory = withFile("company.json", (body) => {
      const company = JSON.parse(body) as { people: { department: string }[] };
      const first = company.people[0];
      if (first !== undefined) first.department = "warehouse";
      return JSON.stringify(company, null, 2);
    });
    const issues = companyIssues(readSource(directory));
    expect(issues).toEqual([
      'company/default/company.json: people[0] (dana-whitfield) has the department "warehouse"; use one of office, maintenance, purchasing, field',
    ]);
  });

  it("accepts a crew lead on record in the field department", () => {
    const directory = withFile("company.json", (body) => {
      const company = JSON.parse(body) as { people: Record<string, unknown>[] };
      company.people.push({
        id: "tasha-crew-lead",
        name: "Tasha Reyes",
        title: "Crew lead, North",
        department: "field",
        email: "tasha@example.com",
      });
      return JSON.stringify(company, null, 2);
    });
    const issues = companyIssues(readSource(directory));
    expect(issues.filter((issue) => issue.includes("department"))).toEqual([]);
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

  describe("the departments' sections", () => {
    /** Edits the parsed company.json of a temporary copy and returns the issues that result. */
    function issuesAfter(edit: (company: Loose) => void): string {
      const directory = withFile("company.json", (body) => {
        const company = JSON.parse(body) as Loose;
        edit(company);
        return JSON.stringify(company, null, 2);
      });
      return companyIssues(readSource(directory)).join("\n");
    }

    it("carries suppliers, supplies, crews, staff policies and claims into the facts", () => {
      const facts = JSON.parse(renderFacts(readSource(root))) as Loose;
      expect(facts.suppliers).toHaveLength(6);
      expect(facts.suppliers.filter((s: { approved: boolean }) => s.approved)).toHaveLength(5);
      expect(facts.supplyCatalog.length).toBeGreaterThanOrEqual(12);
      expect(facts.crews).toHaveLength(4);
      expect(facts.staffPolicies.overtimeNeedsApproval).toBe(true);
      expect(facts.marketing.approvedClaims.length).toBeGreaterThan(3);
      expect(facts.marketing.approverId).toBe("dana-whitfield");
      expect(facts.approvalLimits.purchaseOrderOverCents).toBe(150000);
      expect(facts.ticketRoutes).toEqual([
        expect.objectContaining({ type: "finance.review", toPersonId: "eileen-hart" }),
      ]);
    });

    it("refuses a catalog item whose supplier is unknown", () => {
      const issues = issuesAfter((c) => {
        c.supplyCatalog[0].supplierId = "sup-ghost";
      });
      expect(issues).toContain("supplyCatalog[0]");
      expect(issues).toContain("sup-ghost");
    });

    it("refuses a repeated supplier id and a supplier with no lead time", () => {
      const issues = issuesAfter((c) => {
        c.suppliers[1].id = c.suppliers[0].id;
        c.suppliers[2].leadTimeDays = 0;
      });
      expect(issues).toContain("suppliers[1] repeats the id");
      expect(issues).toContain("suppliers[2]");
    });

    it("refuses crews that do not add up to the headcount", () => {
      const issues = issuesAfter((c) => {
        c.crews[0].members += 1;
      });
      expect(issues).toContain("crews plus the people add up to 25");
      expect(issues).toContain("profile.headcount is 24");
    });

    it("refuses a crew lead who is not a person", () => {
      const issues = issuesAfter((c) => {
        c.crews[3].leadPersonId = "nobody";
      });
      expect(issues).toContain("crews[3].leadPersonId names nobody");
    });

    it("accepts overtimeNeedsApproval false when the policies say so, and refuses a mismatch", () => {
      const edit = (c: Loose): void => {
        c.staffPolicies.overtimeNeedsApproval = false;
      };
      expect(issuesAfter(edit)).toContain("overtimeNeedsApproval");
      const directory = copyCompany();
      const json = join(directory, COMPANY_DIRECTORY, "company.json");
      const company = JSON.parse(readFileSync(json, "utf8")) as Loose;
      edit(company);
      writeFileSync(json, JSON.stringify(company, null, 2));
      const md = join(directory, COMPANY_DIRECTORY, "policies.md");
      writeFileSync(
        md,
        readFileSync(md, "utf8").replace(
          "Overtime needs a person's approval before it is worked.",
          "Overtime does not need a person's approval before it is worked.",
        ),
      );
      expect(companyIssues(readSource(directory))).toEqual([]);
    });

    it("refuses a duplicate alias", () => {
      const issues = issuesAfter((c) => {
        c.people[1].aliases = ["dw"];
        c.people[2].aliases = ["", 7];
      });
      expect(issues).toContain('people[1] (marcus-oyelaran) repeats the alias "dw"');
      expect(issues).toContain("people[2] (priya-raman) aliases[0] must be a non-empty string");
      expect(issues).toContain("people[2] (priya-raman) aliases[1] must be a non-empty string");
    });

    it("refuses an alias that is another person's name, first name, surname or id", () => {
      const issues = issuesAfter((c) => {
        c.people[0].aliases = ["DW", "Tom", "becker", "eileen-hart", "Priya Raman"];
      });
      expect(issues).toContain(
        'people[0] (dana-whitfield) alias "Tom" is already another person\'s name (tom-becker)',
      );
      expect(issues).toContain(
        'people[0] (dana-whitfield) alias "becker" is already another person\'s name (tom-becker)',
      );
      expect(issues).toContain(
        'people[0] (dana-whitfield) alias "eileen-hart" is already another person\'s name (eileen-hart)',
      );
      expect(issues).toContain(
        'people[0] (dana-whitfield) alias "Priya Raman" is already another person\'s name (priya-raman)',
      );
      expect(issues).not.toContain('alias "DW"');
    });

    it("refuses an alias that is another person's title or a word of it", () => {
      const issues = issuesAfter((c) => {
        c.people[0].aliases = ["DW", "Operations Manager", "lead"];
      });
      expect(issues).toContain(
        'people[0] (dana-whitfield) alias "Operations Manager" is already another person\'s title (priya-raman)',
      );
      expect(issues).toContain(
        'people[0] (dana-whitfield) alias "lead" is already another person\'s title (tom-becker)',
      );
      expect(issues).not.toContain('alias "DW"');
    });

    it("refuses aliases that are not a list", () => {
      const issues = issuesAfter((c) => {
        c.people[3].aliases = "TB";
      });
      expect(issues).toContain("people[3] (tom-becker) aliases must be a list of names");
    });

    it("refuses a non-positive pastAbsenceWindowDays", () => {
      for (const value of [0, -3, 1.5, "31", undefined]) {
        const issues = issuesAfter((c) => {
          c.staffPolicies.pastAbsenceWindowDays = value;
        });
        expect(issues, String(value)).toContain(
          "staffPolicies.pastAbsenceWindowDays must be a positive whole number of days",
        );
      }
    });

    it("refuses a staff-policy contact who is not a person", () => {
      const issues = issuesAfter((c) => {
        c.staffPolicies.payQuestionsTo = "nobody";
        c.staffPolicies.disciplineTo = "ghost";
      });
      expect(issues).toContain("staffPolicies.payQuestionsTo names nobody");
      expect(issues).toContain("staffPolicies.disciplineTo names ghost");
    });

    it("requires the people who take protected leave and workplace complaints, naming each gap", () => {
      const issues = issuesAfter((c) => {
        delete c.staffPolicies.protectedLeaveTo;
        delete c.staffPolicies.employeeRelationsTo;
      });
      expect(issues).toContain("staffPolicies.protectedLeaveTo is missing");
      expect(issues).toContain("staffPolicies.employeeRelationsTo is missing");
    });

    it("records at least one testimonial, with a quote and an attribution", () => {
      const facts = JSON.parse(renderFacts(readSource(root))) as Loose;
      expect(facts.marketing.testimonials.length).toBeGreaterThanOrEqual(1);
      for (const entry of facts.marketing.testimonials) {
        expect(entry.quote).toBeTruthy();
        expect(entry.attribution).toBeTruthy();
      }
    });

    it("refuses a testimonial with an empty quote", () => {
      const issues = issuesAfter((c) => {
        c.marketing.testimonials = [{ quote: "  ", attribution: "A client" }];
      });
      expect(issues).toContain("marketing.testimonials[0].quote is empty");
    });

    it("refuses a testimonial with no attribution, and one that is not a list", () => {
      expect(
        issuesAfter((c) => {
          c.marketing.testimonials = [{ quote: "Always on time, every single night." }];
        }),
      ).toContain("marketing.testimonials[0].attribution is empty");
      expect(
        issuesAfter((c) => {
          c.marketing.testimonials = "none";
        }),
      ).toContain("marketing.testimonials must be a list");
    });

    it("says what is wrong with a testimonial that is not text, and how to fix it", () => {
      const issues = issuesAfter((c) => {
        c.marketing.testimonials = [{ quote: 42, attribution: "A client" }, "a quote"];
      });
      expect(issues).toContain(
        "marketing.testimonials[0].quote must be a non-empty string: write the customer's words exactly as recorded",
      );
      expect(issues).toContain(
        'marketing.testimonials[1] must be an object { "quote": "…", "attribution": "…" }',
      );
    });

    it("allows a company with no testimonials", () => {
      expect(
        issuesAfter((c) => {
          c.marketing.testimonials = [];
        }),
      ).toBe("");
    });

    it("refuses a marketing approver who is not a person", () => {
      expect(
        issuesAfter((c) => {
          c.marketing.approverId = "nobody";
        }),
      ).toContain("marketing.approverId names nobody");
      expect(
        issuesAfter((c) => {
          delete c.marketing.approverId;
        }),
      ).toContain("marketing.approverId names undefined");
    });

    it("refuses an approved claim that the policies do not state", () => {
      const issues = issuesAfter((c) => {
        c.marketing.approvedClaims.push("We are the cheapest cleaner in Oregon.");
      });
      expect(issues).toContain("policies.md");
      expect(issues).toContain("We are the cheapest cleaner in Oregon.");
    });

    it("refuses a handbook that never names a supplier or a crew", () => {
      const directory = withFile("handbook.md", (body) =>
        body.replaceAll("Pacific Janitorial Supply", "the chemical vendor"),
      );
      expect(companyIssues(readSource(directory)).join("\n")).toContain(
        "does not name the supplier Pacific Janitorial Supply",
      );
    });

    it("refuses a ticket route to an unknown person", () => {
      const issues = issuesAfter((c) => {
        c.ticketRoutes[0].toPersonId = "nobody";
      });
      expect(issues).toContain("ticketRoutes[0] goes to nobody, who is not one of the people");
    });

    it("refuses a duplicate ticket route", () => {
      const issues = issuesAfter((c) => {
        c.ticketRoutes.push({ ...c.ticketRoutes[0], toPersonId: "dana-whitfield" });
      });
      expect(issues).toContain("ticketRoutes[1] repeats the type finance.review");
    });

    it("refuses a ticket route whose type is not a ticket type", () => {
      const issues = issuesAfter((c) => {
        c.ticketRoutes[0].type = "Finance Review";
      });
      expect(issues).toContain('ticketRoutes[0] has the type "Finance Review"');
    });

    it("carries the weeks in a month the desk counts recurring visits with", () => {
      const facts = JSON.parse(renderFacts(readSource(root))) as Loose;
      expect(facts.quoting.weeksPerMonth).toBe(4.33);
    });

    it("refuses a weeks-per-month that is missing, zero or not a number, naming the path", () => {
      for (const value of [undefined, 0, -1, "4.33"]) {
        const issues = issuesAfter((c) => {
          c.quoting = value === undefined ? {} : { weeksPerMonth: value };
        });
        expect(issues).toContain("quoting.weeksPerMonth");
        expect(issues).toContain("positive number of weeks");
      }
      expect(
        issuesAfter((c) => {
          delete c.quoting;
        }),
      ).toContain("quoting.weeksPerMonth");
    });

    it("refuses a purchase-order limit the policies do not state", () => {
      const issues = issuesAfter((c) => {
        c.approvalLimits.purchaseOrderOverCents = 175000;
      });
      expect(issues).toContain("policies.md");
      expect(issues).toContain("$1,500.00");
    });
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

  it("skips a role directory that holds only researched role files and no officehum.json", () => {
    // Roles are researched before they are packaged (RASF-3293): such a folder gets no handbook yet.
    const directory = catalogue();
    const researched = join(directory, "agents", "support");
    mkdirSync(researched, { recursive: true });
    writeFileSync(join(researched, "role.md"), "# Customer Support\n");
    writeFileSync(join(researched, "role.sources.json"), "{}");
    expect(roleDirectories(directory)).toEqual(["sales"]);
    expect(renderAll(directory).some((file) => file.path.startsWith("agents/support/"))).toBe(
      false,
    );
    expect(unexpectedFiles(directory)).toEqual([]);
  });

  it("refuses a role that does not declare the skill it is about to be given", () => {
    const directory = catalogue();
    writeFileSync(join(directory, "agents", "sales", "officehum.json"), '{"skills": []}');
    expect(() => renderAll(directory)).toThrow(/does not declare the company-handbook skill/);
  });
});
