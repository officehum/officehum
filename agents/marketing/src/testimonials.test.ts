/** The invented-testimonial check, on examples both ways. */

import { describe, expect, it } from "vitest";
import { findUnrecordedTestimonials } from "./testimonials.js";

const RECORD = [{ quote: "The crew is always on time and our lobby looks great every morning." }];

describe("findUnrecordedTestimonials", () => {
  it.each([
    ['"We could not be happier with the crew and the lobby." — Dana Reyes'],
    ["“We could not be happier with the crew and the lobby.” - a client"],
    ['"We could not be happier with the crew and the lobby," says Dana Reyes.'],
    ['"We could not be happier with the crew and the lobby," Dana Reyes said.'],
    ['Dana Reyes said: "We could not be happier with the crew and the lobby."'],
    ['According to Dana, "we could not be happier with the crew and the lobby."'],
  ])("refuses %s", (text) => {
    expect(findUnrecordedTestimonials(text, RECORD)).toEqual([
      expect.stringMatching(/We could not be happier|we could not be happier/),
    ]);
  });

  it.each([
    ['Our crews are "always on time" for every visit.'],
    ['"Same crew, same time, every night" — our promise to you, and we keep it.'.replace("—", "")],
    ['We call it "the Northwind way of looking after a building" and we mean it.'],
    ['"Short quote here" — Dana Reyes'],
    ["No quotes at all, and a dash — Dana is not a quote."],
  ])("leaves %s alone", (text) => {
    expect(findUnrecordedTestimonials(text, RECORD)).toEqual([]);
  });

  it("accepts a quote on record, ignoring case, spacing, quote style and closing punctuation", () => {
    const quote = RECORD[0]?.quote ?? "";
    expect(findUnrecordedTestimonials(`"${quote}" — Priya`, RECORD)).toEqual([]);
    expect(
      findUnrecordedTestimonials(`“${quote.toUpperCase().replace(".", "")}”  — Priya`, RECORD),
    ).toEqual([]);
    expect(findUnrecordedTestimonials(`"${quote}"\n— Priya`, RECORD)).toEqual([]);
  });

  it("refuses a recorded quote that was shortened, extended or reworded", () => {
    expect(
      findUnrecordedTestimonials(
        '"The crew is always on time and our lobby looks great." — Priya',
        RECORD,
      ),
    ).toHaveLength(1);
    expect(
      findUnrecordedTestimonials(`"${RECORD[0]?.quote} Highly recommended." — Priya`, RECORD),
    ).toHaveLength(1);
  });

  it("refuses every quote when the company records none", () => {
    expect(findUnrecordedTestimonials(`"${RECORD[0]?.quote}" — Priya`, [])).toHaveLength(1);
  });
});
