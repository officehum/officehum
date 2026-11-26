import { describe, expect, it } from "vitest";
import { companyHead } from "./company.js";
import { validateManifest } from "./manifest.js";
import {
  holder,
  RESPONSIBILITIES,
  RESPONSIBILITY_IDS,
  responsibilityWords,
  responsible,
} from "./responsibilities.js";

const person = (id: string, title: string, department = "office") => ({
  id,
  name: id,
  title,
  department,
});

/** A small company written the way the default company's record is: no responsibilities map. */
const RECORD = {
  people: [
    person("finn", "Finance Director"),
    person("ada", "Managing Director"),
    person("bea", "Bookkeeping and Finance"),
    person("cal", "Sales Manager"),
    person("dee", "Operations Manager"),
    person("eve", "Buyer", "purchasing"),
    person("gil", "People Lead"),
  ],
  escalation: [
    { topic: "contract-terms", toPersonId: "ada" },
    { topic: "money-back", toPersonId: "ada" },
    { topic: "discount-request", toPersonId: "cal" },
    { topic: "complaint-about-a-visit", toPersonId: "dee" },
    { topic: "start-date", toPersonId: "dee" },
    { topic: "safety-incident", toPersonId: "dee" },
    { topic: "hiring-and-onboarding", toPersonId: "gil" },
    { topic: "data-and-security", toPersonId: "ada" },
  ],
  staffPolicies: {
    payQuestionsTo: "gil",
    disciplineTo: "dee",
    protectedLeaveTo: "gil",
    employeeRelationsTo: "gil",
  },
  payroll: { approverId: "bea" },
  inventory: { writeOffApproverId: "bea" },
  quality: { ownerId: "dee" },
  safety: { officerId: "dee" },
  it: { approverId: "ada" },
  marketing: { approverId: "ada" },
  budget: { approverId: "ada" },
  policies: { discounts: { approver: "cal" }, refunds: { refundNeeds: "ada" } },
};

describe("the responsibility vocabulary", () => {
  it("is a fixed list of kebab-case ids, each with plain words", () => {
    expect(RESPONSIBILITY_IDS).toEqual(RESPONSIBILITIES.map((entry) => entry.id));
    expect(new Set(RESPONSIBILITY_IDS).size).toBe(RESPONSIBILITY_IDS.length);
    for (const entry of RESPONSIBILITIES) {
      expect(entry.id).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(entry.words.length).toBeGreaterThan(0);
    }
    expect(responsibilityWords("billing")).toBe("billing");
    expect(responsibilityWords("discounts")).toBe("discounts and quotes above the limit");
  });
});

describe("responsible, on a record with no responsibilities map", () => {
  it("finds the head by a head title before any director, wherever they sit", () => {
    expect(responsible(RECORD, "head")?.id).toBe("ada");
    expect(companyHead(RECORD)?.id).toBe("ada");
    const directorsOnly = { people: [person("x", "Sales"), person("finn", "Finance Director")] };
    expect(responsible(directorsOnly, "head")?.id).toBe("finn");
    expect(responsible({ people: [person("x", "Sales")] }, "head")).toBeUndefined();
  });

  it("finds billing by a title with finance in it, first in record order", () => {
    expect(responsible(RECORD, "billing")?.id).toBe("finn");
    expect(responsible({ people: [person("x", "Sales")] }, "billing")).toBeUndefined();
  });

  it("finds purchasing by the purchasing department", () => {
    expect(responsible(RECORD, "purchasing")?.id).toBe("eve");
  });

  it("reads every other responsibility from the field the roles read it from", () => {
    const expected: Record<string, string> = {
      "contract-terms": "ada",
      "money-back": "ada",
      discounts: "cal",
      complaints: "dee",
      "pay-runs": "bea",
      "pay-questions": "gil",
      scheduling: "dee",
      safety: "dee",
      quality: "dee",
      "stock-write-offs": "bea",
      hiring: "gil",
      "people-matters": "gil",
      discipline: "dee",
      "it-access": "ada",
      "data-and-security": "ada",
      marketing: "ada",
      budget: "ada",
    };
    for (const [id, who] of Object.entries(expected)) {
      expect(responsible(RECORD, id as never)?.id, id).toBe(who);
    }
  });

  it("finds nobody for a section the record does not have, or an id nobody on it holds", () => {
    const bare = { people: RECORD.people };
    for (const id of RESPONSIBILITY_IDS) {
      if (id === "head" || id === "billing" || id === "purchasing") continue;
      expect(responsible(bare, id), id).toBeUndefined();
    }
    expect(responsible({ ...RECORD, budget: { approverId: "nobody" } }, "budget")).toBeUndefined();
  });
});

describe("responsible, on a record with a responsibilities map", () => {
  it("reads the map alone: a responsibility it leaves out has nobody, whatever the titles say", () => {
    const record = { ...RECORD, responsibilities: { billing: "bea", budget: "gone" } };
    expect(responsible(record, "billing")?.id).toBe("bea");
    expect(responsible(record, "budget")).toBeUndefined();
    expect(responsible(record, "head")).toBeUndefined();
    expect(responsible(record, "purchasing")).toBeUndefined();
    expect(companyHead(record)).toBeUndefined();
  });
});

describe("holder", () => {
  it("reads exactly the recorded id on a record without a map, and the map on one with it", () => {
    expect(holder(RECORD, "budget", "bea")?.id).toBe("bea");
    expect(holder(RECORD, "budget", undefined)).toBeUndefined();
    expect(holder(RECORD, "budget", "nobody")).toBeUndefined();
    const office = { people: RECORD.people, responsibilities: { budget: "gil" } };
    expect(holder(office, "budget", "bea")?.id).toBe("gil");
    expect(holder(office, "pay-runs", "bea")).toBeUndefined();
  });
});

describe("company.responsibilities in officehum.json", () => {
  const manifest = (company: unknown) => ({
    schemaVersion: 1,
    id: "sample",
    name: "Sample",
    department: "finance",
    role: "Keeps the sample books",
    defaultModel: { provider: "paper", modelId: "ultramarine-1-flash" },
    tools: [],
    connectors: [],
    approvals: [],
    channels: [],
    accepts: [],
    skills: [],
    evals: "evals",
    ...(company === undefined ? {} : { company }),
  });

  it("is optional, and takes ids from the vocabulary", () => {
    expect(validateManifest(manifest(undefined)).ok).toBe(true);
    expect(validateManifest(manifest({ responsibilities: ["billing", "purchasing"] })).ok).toBe(
      true,
    );
  });

  it("refuses an unknown id, an empty list, an unknown key and a repeat, with each path", () => {
    const unknown = validateManifest(manifest({ responsibilities: ["billing", "bookkeeping"] }));
    expect(unknown.ok).toBe(false);
    expect(unknown.issues.map((issue) => issue.path).join(" ")).toContain(
      "company.responsibilities",
    );
    expect(validateManifest(manifest({ responsibilities: [] })).ok).toBe(false);
    expect(validateManifest(manifest({ responsibilities: ["billing"], extra: 1 })).ok).toBe(false);
    const twice = validateManifest(manifest({ responsibilities: ["billing", "billing"] }));
    expect(twice.ok).toBe(false);
    expect(twice.issues).toEqual([
      expect.objectContaining({
        path: "company.responsibilities[1]",
        message: 'responsibility "billing" is declared more than once',
      }),
    ]);
  });
});
