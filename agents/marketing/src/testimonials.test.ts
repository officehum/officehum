/** The invented-testimonial check, on examples both ways. */

import { describe, expect, it } from "vitest";
import { findUnrecordedTestimonials } from "./testimonials.js";

const RECORD = [{ quote: "The crew is always on time and our lobby looks great every morning." }];

describe("findUnrecordedTestimonials", () => {
  it.each([
    ['"We could not be happier with the crew and the lobby." — Morgan Ellis'],
    ["“We could not be happier with the crew and the lobby.” - a client"],
    ['"We could not be happier with the crew and the lobby," says Morgan Ellis.'],
    ['"We could not be happier with the crew and the lobby," Morgan Ellis said.'],
    ['Morgan Ellis said: "We could not be happier with the crew and the lobby."'],
    ['According to Morgan, "we could not be happier with the crew and the lobby."'],
  ])("refuses %s", (text) => {
    expect(findUnrecordedTestimonials(text, RECORD)).toEqual([
      expect.stringMatching(/We could not be happier|we could not be happier/),
    ]);
  });

  it.each([
    ['Our crews are "always on time" for every visit.'],
    ['"Same crew, same time, every night" — our promise to you, and we keep it.'.replace("—", "")],
    ['We call it "the Northwind way of looking after a building" and we mean it.'],
    ['"Short quote here" — Morgan Ellis'],
    ["No quotes at all, and a dash — Dana is not a quote."],
  ])("leaves %s alone", (text) => {
    expect(findUnrecordedTestimonials(text, RECORD)).toEqual([]);
  });

  it("accepts a quote on record, ignoring case, spacing, quote style and closing punctuation", () => {
    const quote = RECORD[0]?.quote ?? "";
    expect(findUnrecordedTestimonials(`"${quote}" — Leah`, RECORD)).toEqual([]);
    expect(
      findUnrecordedTestimonials(`“${quote.toUpperCase().replace(".", "")}”  — Leah`, RECORD),
    ).toEqual([]);
    expect(findUnrecordedTestimonials(`"${quote}"\n— Leah`, RECORD)).toEqual([]);
  });

  it("refuses a recorded quote that was shortened, extended or reworded", () => {
    expect(
      findUnrecordedTestimonials(
        '"The crew is always on time and our lobby looks great." — Leah',
        RECORD,
      ),
    ).toHaveLength(1);
    expect(
      findUnrecordedTestimonials(`"${RECORD[0]?.quote} Highly recommended." — Leah`, RECORD),
    ).toHaveLength(1);
  });

  const SAID = "We could not be happier with the crew and the lobby.";

  it.each([
    [`"${SAID}"\nMorgan Ellis, Harbor Dental`],
    [`"${SAID}"\n\nMorgan Ellis`],
    [`"${SAID}"\n— Morgan Ellis, Harbor Dental`],
    [`"${SAID}" — Morgan of Harbor Dental`],
    [`"${SAID}" — Morgan Ellis Our floors are next.`],
    [`"${SAID}" (Morgan Ellis, Harbor Dental)`],
    [`"${SAID}" [Morgan Ellis]`],
    [`Morgan Ellis, Harbor Dental: "${SAID}"`],
    [`Morgan Ellis: "${SAID}"`],
    [`Morgan Ellis, office manager at Harbor Dental, put it plainly:\n\n"${SAID}"`],
    [
      `A long opening sentence that runs past the window the check reads before a quote. Morgan Ellis, Harbor Dental: "${SAID}"`,
    ],
    [`"${SAID.replace(".", ",")}" she said.`],
    [`"${SAID.replace(".", ",")}" the practice manager told us.`],
    [`'${SAID.replace(".", ",")}' says Morgan Ellis.`],
    [`‘${SAID}’ — Morgan Ellis`],
    [`'We don't miss a night and the lobby always shines.' — Morgan Ellis`],
    [`Our 12" mats are new. Morgan Ellis says "${SAID}"`],
    [`According to Dr. Ellis, "${SAID}"`],
  ])("refuses an attributed form: %j", (text) => {
    expect(findUnrecordedTestimonials(text, RECORD)).toHaveLength(1);
  });

  it.each([
    ['Our motto is "clean offices make for happy teams every day" — and we mean it.'],
    ['We call it "the seven-day fresh start for your office" - ask us.'],
    ['"Clean offices make for happy teams every day" — Ask us how.'],
    ['"Clean offices make for happy teams every day"\nBook a walkthrough today.'],
    ['"Clean offices make for happy teams every day"\nThe Northwind team'],
    ['Ask about our "Recurring janitorial" plan.'],
    ['Our team says thanks. Our promise: "we will be there every single night, rain or shine."'],
    ["It is our 'clean every night, whatever the weather' promise."],
    ["Our clients' offices get the 'same crew, same time, every single night' treatment."],
    ['Our 12" mats and 24" mats are both on the price list, every single one of them.'],
    ['"Clean offices make for happy teams every day" (see our site)'],
    ['"Clean offices make for happy teams every day" — Monday to Friday.'],
  ])("leaves an unattributed passage alone: %j", (text) => {
    expect(findUnrecordedTestimonials(text, RECORD)).toEqual([]);
  });

  describe("the company's own names, greetings, places and headings are not speakers", () => {
    const OWN = [
      "Northwind Facilities",
      "Northwind Facilities Ltd.",
      "Day porter",
      "Window cleaning",
    ];
    const SLOGAN = '"Clean offices make for happy teams every single day"';

    it.each([
      [`${SLOGAN}\nNorthwind Facilities`],
      [`${SLOGAN}\nNorthwind Facility Services`],
      [`${SLOGAN} — Northwind Facility Services`],
      [`${SLOGAN} — Northwind`],
      [`${SLOGAN}\nDear Office Managers,`],
      [`${SLOGAN}\nHello Team,`],
      [`${SLOGAN}\nHi Dana,\nWinter is here.`],
      [`${SLOGAN}\nDay Porter. Window Cleaning. Floor Care.`],
      [`${SLOGAN}\nSeattle, WA`],
      [`${SLOGAN}\nPortland, Oregon`],
      [`${SLOGAN}\nWinter Specials, now on.`],
      [`${SLOGAN}\nOur Services Include Floor Care And Day Porters For Every Building Downtown`],
      [`New Year Promise: ${SLOGAN}`],
      [`${SLOGAN}\nGood Morning Portland, here is our winter news.`],
    ])("leaves %j alone", (text) => {
      expect(findUnrecordedTestimonials(text, RECORD, OWN)).toEqual([]);
    });

    it("still catches a person's name on the next line, and a name after a dash", () => {
      const said = '"We could not be happier with the crew and the lobby."';
      expect(
        findUnrecordedTestimonials(`${said}\nMorgan Ellis, Harbor Dental`, RECORD, OWN),
      ).toHaveLength(1);
      expect(findUnrecordedTestimonials(`${said}\nMorgan Ellis`, RECORD, OWN)).toHaveLength(1);
      expect(findUnrecordedTestimonials(`${said} — Morgan Ellis`, RECORD, OWN)).toHaveLength(1);
      expect(
        findUnrecordedTestimonials(
          `${said}\nMorgan Ellis, office manager, Harbor Dental`,
          RECORD,
          OWN,
        ),
      ).toHaveLength(1);
    });

    it("does not read a running line of prose after the quote as a name line", () => {
      const said = '"We could not be happier with the crew and the lobby."';
      expect(
        findUnrecordedTestimonials(
          `${said}\nMorgan Ellis And The Whole Harbor Dental Front Desk Team Agree With Us`,
          RECORD,
          OWN,
        ),
      ).toEqual([]);
    });
  });

  describe("markdown names, a lead-in from a client, and a name on the same line", () => {
    const said = '"We could not be happier with the crew and the lobby."';
    it.each([
      [`${said}\n**Morgan Ellis**, Harbor Dental`],
      [`${said}\n— **Morgan Ellis**, Harbor Dental`],
      [`${said}\n_Morgan Ellis_`],
      [`From a client: ${said}`],
      [`From one of our clients:\n\n${said}`],
      [`A practice manager: ${said}`],
      [`${said} Morgan Ellis, Harbor Dental`],
      [`${said} Morgan Ellis`],
    ])("refuses %j", (text) => {
      expect(findUnrecordedTestimonials(text, RECORD, ["Northwind Facilities"])).toHaveLength(1);
    });

    it.each([
      ['The rule: "we leave every room better than we found it, every night."'],
      ['The promise:\n"we leave every room better than we found it, every night."'],
      ['"We leave every room better than we found it, every night." Book Now'],
      ['"We leave every room better than we found it, every night." Northwind Facilities'],
      ['"We leave every room better than we found it, every night." Winter Specials, now on.'],
      [
        '"We leave every room better than we found it, every night." That Is Our Promise To You And We Keep It',
      ],
      ['"We leave every room better than we found it, every night."\n**Book A Walkthrough**'],
    ])("leaves %j alone", (text) => {
      expect(findUnrecordedTestimonials(text, RECORD, ["Northwind Facilities"])).toEqual([]);
    });
  });

  it("refuses every quote when the company records none", () => {
    expect(findUnrecordedTestimonials(`"${RECORD[0]?.quote}" — Leah`, [])).toHaveLength(1);
  });
});
