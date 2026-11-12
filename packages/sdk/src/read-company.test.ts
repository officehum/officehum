/** `read_company` and the shared section texts, on a small company of their own. */
import { Type } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  companyEscalationText,
  companyGlossaryText,
  companyHoursText,
  companyPeopleText,
  companyPoliciesText,
  companyProfileText,
  companyToneText,
  readCompanyTool,
} from "./read-company.js";

/** As a role types it: only the parts of the record it reads, so less than the whole `CompanyRecord`. */
const company = {
  profile: {
    legalName: "Example Works Ltd.",
    tradingName: "Example Works",
    tagline: "Things, kept working.",
    address: {
      street: "1 Mill Lane",
      city: "Portland",
      region: "Oregon",
      postalCode: "97214",
      country: "United States",
    },
    phone: "+1 503 555 0100",
    email: "hello@example.test",
    serviceArea: "The city and its suburbs.",
    clients: "Offices and clinics.",
  },
  hours: {
    timezone: "America/Los_Angeles",
    office: "Monday to Friday, 07:00 to 17:00",
    crews: "05:00 to 23:00, seven days",
    emergencyLine: "Answered 24 hours",
    closedOn: "New Year's Day",
    note: "A holiday shifts a visit.",
  },
  people: [
    {
      id: "dana",
      name: "Dana Reyes",
      title: "Managing Director",
      department: "office",
      email: "dana@example.test",
      phone: "+1 503 555 0101",
      decides: ["contracts", "refunds"],
    },
    {
      id: "sam",
      name: "Sam Okoro",
      title: "Operations Manager",
      department: "office",
      email: "sam@example.test",
      decides: ["the schedule"],
    },
  ],
  policies: { safety: ["Lock up."], commitments: ["A start date."] },
  tone: { summary: "Plain and kind.", always: ["Say who decides."], never: ["Guess."] },
  escalation: [
    { topic: "start-date", toPersonId: "sam", when: "Any change to the schedule." },
    { topic: "press", toPersonId: "nobody-here", when: "A journalist calls." },
  ],
  glossary: [{ term: "Re-clean", meaning: "A return visit at no charge." }],
};

describe("the shared company section texts", () => {
  it("profile: who the company is, where, and whom it serves", () => {
    expect(companyProfileText(company)).toBe(
      [
        "Example Works Ltd. — trading as Example Works. Things, kept working.",
        "1 Mill Lane, Portland, Oregon 97214. Phone +1 503 555 0100. Email hello@example.test.",
        "Service area: The city and its suburbs.",
        "Clients: Offices and clinics.",
      ].join("\n"),
    );
  });

  it("hours: the office, the crews, the emergency line, closures and the note", () => {
    expect(companyHoursText(company)).toBe(
      [
        "Office: Monday to Friday, 07:00 to 17:00 (America/Los_Angeles).",
        "Crews: 05:00 to 23:00, seven days.",
        "Emergency line: Answered 24 hours.",
        "Closed: New Year's Day.",
        "A holiday shifts a visit.",
      ].join("\n"),
    );
  });

  it("people: with an email, or with no contact detail at all when the role asks for none", () => {
    expect(companyPeopleText(company, "email")).toBe(
      [
        "Dana Reyes — Managing Director — dana@example.test — decides: contracts; refunds",
        "Sam Okoro — Operations Manager — sam@example.test — decides: the schedule",
      ].join("\n"),
    );
    const without = companyPeopleText(company, "none");
    expect(without).toBe(
      [
        "Dana Reyes — Managing Director — decides: contracts; refunds",
        "Sam Okoro — Operations Manager — decides: the schedule",
      ].join("\n"),
    );
    expect(without).not.toMatch(/@|\+1/);
  });

  it("policies, tone and glossary", () => {
    expect(companyPoliciesText(company)).toBe(
      "Safety:\n- Lock up.\nNever promised:\n- A start date.",
    );
    expect(companyToneText(company)).toBe(
      "Plain and kind.\nAlways:\n- Say who decides.\nNever:\n- Guess.",
    );
    expect(companyGlossaryText(company)).toBe("Re-clean: A return visit at no charge.");
  });

  it("escalation: the topic, who decides it by name and title, and when; an unknown id stays an id", () => {
    expect(companyEscalationText(company)).toBe(
      [
        "start-date — Sam Okoro, Operations Manager — Any change to the schedule.",
        "press — nobody-here — A journalist calls.",
      ].join("\n"),
    );
  });
});

describe("readCompanyTool", () => {
  const tool = readCompanyTool({
    company,
    description: "Read one section of the company record: the hours, the tone or the crews.",
    sections: {
      hours: companyHoursText,
      tone: companyToneText,
      crews: () => "No crews on this record.",
    },
  });

  it("is the safe read_company tool, with one literal per section in the order given", () => {
    expect(tool.name).toBe("read_company");
    expect(tool.replay).toBe("safe");
    expect(tool.description).toBe(
      "Read one section of the company record: the hours, the tone or the crews.",
    );
    expect(tool.parameters).toEqual(
      Type.Object(
        {
          section: Type.Union(
            [Type.Literal("hours"), Type.Literal("tone"), Type.Literal("crews")],
            { description: "Which part of the record to read" },
          ),
        },
        { additionalProperties: false },
      ),
    );
  });

  it("answers with the section's text and names the section in the details", async () => {
    const execute = tool.execute as unknown as (args: unknown) => Promise<unknown>;
    expect(await execute({ section: "hours" })).toEqual({
      output: [{ type: "text", text: companyHoursText(company) }],
      details: { section: "hours" },
    });
    expect(await execute({ section: "crews" })).toEqual({
      output: [{ type: "text", text: "No crews on this record." }],
      details: { section: "crews" },
    });
  });
});
