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

  it("refuses every quote when the company records none", () => {
    expect(findUnrecordedTestimonials(`"${RECORD[0]?.quote}" — Leah`, [])).toHaveLength(1);
  });
});
