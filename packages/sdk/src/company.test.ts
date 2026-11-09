/** The company helpers every role shares: loading the generated facts and finding people in them. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { findPeople, loadCompanyFacts, personLabel } from "./company.js";

function fileWith(content: string): URL {
  const path = join(mkdtempSync(join(tmpdir(), "company-")), "facts.json");
  writeFileSync(path, content);
  return pathToFileURL(path);
}

const company = {
  people: [
    { id: "dana", name: "Dana Reyes", title: "Managing Director" },
    { id: "sam", name: "Sam Okoro", title: "People Manager" },
    { id: "lee", name: "Lee Park", title: "Crew Lead" },
  ],
};

describe("loadCompanyFacts", () => {
  it("reads a JSON object", () => {
    expect(loadCompanyFacts<{ a: number }>(fileWith('{"a":1}'))).toEqual({ a: 1 });
  });

  it("throws a sync-company hint for a missing file", () => {
    const missing = pathToFileURL(join(tmpdir(), "no-such-dir-officehum", "facts.json"));
    expect(() => loadCompanyFacts(missing)).toThrow(/npm run sync-company/);
  });

  it("throws a sync-company hint for a file that is not JSON", () => {
    expect(() => loadCompanyFacts(fileWith("nope"))).toThrow(/npm run sync-company/);
  });

  it("throws for a JSON array", () => {
    expect(() => loadCompanyFacts(fileWith("[]"))).toThrow(/must hold a JSON object/);
  });
});

describe("findPeople", () => {
  it('matches "HR" to whoever holds a People title', () => {
    expect(findPeople(company, "my complaint is about HR").map((p) => p.id)).toEqual(["sam"]);
  });

  it("matches a first name, a surname and a title as whole words", () => {
    expect(findPeople(company, "ask dana").map((p) => p.id)).toEqual(["dana"]);
    expect(findPeople(company, "Mr Park").map((p) => p.id)).toEqual(["lee"]);
    expect(findPeople(company, "the crew lead").map((p) => p.id)).toEqual(["lee"]);
  });

  it("ignores a word that only contains a name", () => {
    expect(findPeople(company, "Danacorp")).toEqual([]);
  });

  it("is empty for an empty string", () => {
    expect(findPeople(company, "   ")).toEqual([]);
  });
});

describe("personLabel", () => {
  it('prints "Name, Title"', () => {
    expect(personLabel(company.people[0])).toBe("Dana Reyes, Managing Director");
  });

  it("uses the fallback for undefined", () => {
    expect(personLabel(undefined)).toBe("a person");
    expect(personLabel(undefined, "the person who owns finance")).toBe(
      "the person who owns finance",
    );
  });
});
