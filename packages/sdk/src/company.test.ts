/** The company helpers every role shares: loading the generated facts and finding people in them. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  findPeople,
  loadCompanyFacts,
  personLabel,
  senderPerson,
  type VerifiedSender,
} from "./company.js";

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

  it("matches an alias as a whole word, ignoring case", () => {
    const aliased = {
      people: company.people.map((p) => (p.id === "dana" ? { ...p, aliases: ["DR"] } : p)),
    };
    expect(findPeople(aliased, "complaint about DR").map((p) => p.id)).toEqual(["dana"]);
    expect(findPeople(aliased, "it was dr on the phone").map((p) => p.id)).toEqual(["dana"]);
    expect(findPeople(aliased, "the DRY cleaning")).toEqual([]);
  });

  it('matches a first initial and surname ("D. Reyes")', () => {
    expect(findPeople(company, "D. Reyes said so").map((p) => p.id)).toEqual(["dana"]);
    expect(findPeople(company, "D Reyes").map((p) => p.id)).toEqual(["dana"]);
  });

  it("leaves every existing title, name and HR-word match unchanged when aliases exist", () => {
    const aliased = {
      people: company.people.map((p) => ({ ...p, aliases: [`${p.id.toUpperCase()}X`] })),
    };
    for (const words of [
      "my complaint is about HR",
      "the people manager",
      "human resources",
      "ask dana",
      "Mr Park",
      "the crew lead",
      "the managing director",
      "Danacorp",
      "nobody here",
    ]) {
      expect(
        findPeople(aliased, words).map((p) => p.id),
        words,
      ).toEqual(findPeople(company, words).map((p) => p.id));
    }
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

describe("senderPerson", () => {
  const staff = {
    people: [
      { id: "dana", name: "Dana Reyes", title: "Managing Director", email: "dana@example.test" },
      { id: "lee", name: "Lee Park", title: "Crew Lead", phone: "+1 503 555 0143" },
    ],
  };
  const from = (origin: VerifiedSender["origin"], contact: string): VerifiedSender => ({
    origin,
    channel: "chat",
    contact,
  });

  it("senderPerson matches an internal sender by person id", () => {
    expect(senderPerson(staff, from("internal", "Dana"))?.id).toBe("dana");
    // An id is an office-internal name: an outside contact that happens to spell one is nobody.
    expect(senderPerson(staff, from("external", "dana"))).toBeUndefined();
  });

  it("matches an external sender by email ignoring case", () => {
    expect(senderPerson(staff, from("external", "DANA@Example.test"))?.id).toBe("dana");
    expect(senderPerson(staff, from("external", "+1 503 555 0143"))?.id).toBe("lee");
  });

  it("matches an E.164 phone against a formatted one on the record", () => {
    // The SMS gateway records `+15035550143`; the company record writes `+1 503 555 0143`.
    expect(senderPerson(staff, from("external", "+15035550143"))?.id).toBe("lee");
    expect(senderPerson(staff, from("external", "+1 (503) 555-0143"))?.id).toBe("lee");
  });

  it("does not match a phone that differs in a digit or is only a prefix", () => {
    expect(senderPerson(staff, from("external", "+15035550144"))).toBeUndefined();
    expect(senderPerson(staff, from("external", "+1503555014"))).toBeUndefined();
    expect(senderPerson(staff, from("external", "15035550143"))).toBeUndefined();
  });

  it("is undefined for an unknown contact", () => {
    expect(senderPerson(staff, from("external", "someone@else.test"))).toBeUndefined();
    // Exact, not partial: a contact that only contains an address is not that address.
    expect(senderPerson(staff, from("external", "x-dana@example.test"))).toBeUndefined();
    expect(senderPerson(staff, undefined)).toBeUndefined();
  });
});
