/**
 * The result-claim detector, on examples both ways. A false positive (an offer or a price refused) is
 * as much a defect as a false negative (a result let through), so each list is tested in full and
 * every refusal must name the phrase that tripped it.
 */

import { describe, expect, it } from "vitest";
import { findResultClaims } from "./claims.js";

/** Each text and the phrase the refusal must name. */
const REFUSED: readonly (readonly [string, string])[] = [
  // Percentages and numeric results.
  ["Our nightly clean cuts sick days 30%.", "30%"],
  ["Clients see 40 percent fewer complaints.", "40 percent"],
  ["Restroom complaints drop by 25 per cent.", "25 per cent"],
  ["Kills 99.9% of germs on contact.", "99.9%"],
  ["Our floors are 2x cleaner than before.", "2x cleaner"],
  ["Floors stay 3 times cleaner between visits.", "3 times cleaner"],
  ["Twice as clean, half the hassle.", "Twice as clean"],
  ["Our day porter cuts lobby complaints by 50.", "cuts lobby complaints by 50"],
  ["Regular filter changes saves you $400 a year on energy.", "saves you $400"],
  ["We reduced callbacks to 3 a month.", "reduced callbacks to 3"],
  // Proof phrases.
  ["Tests prove our disinfectant works.", "Tests prove"],
  ["Studies show a clean office lifts morale.", "Studies show"],
  ["A proven way to a healthier office.", "proven"],
  ["Our process is proven to stop the spread of flu.", "proven"],
  ["Clinically tested products in every restroom.", "Clinically"],
  ["Scientifically better floor care.", "Scientifically"],
  ["Lab-tested cleaning for clinics.", "Lab-tested"],
  // Broad environmental terms.
  ["Eco-friendly cleaning for your office.", "Eco-friendly"],
  ["We only use non-toxic products.", "non-toxic"],
  ["Green cleaning, every night.", "Green"],
  ["Our cleaning is environmentally friendly.", "environmentally friendly"],
  ["Sustainable floor care that lasts.", "Sustainable"],
  ["Chemical-free restroom care.", "Chemical-free"],
  // Percentages and halves written in words.
  ["Cuts sick days by thirty percent.", "thirty percent"],
  ["Kills ninety-nine percent of germs.", "ninety-nine percent"],
  ["Cuts sick days by thirty-percent.", "thirty-percent"],
  ["Cuts sick days by 30-percent.", "30-percent"],
  ["Twenty percent fewer complaints.", "Twenty percent"],
  ["A hundred percent spotless, every night.", "A hundred percent"],
  ["Half of our clients report fewer sick days.", "Half of"],
  ["Restroom complaints cut in half.", "in half"],
  // A result dressed as an offer: "off" that is not followed by a price.
  ["Takes 30% off your sick days.", "30%"],
  ["Up to 30% off sick days.", "30%"],
  // Other spellings, verb forms, a longer gap, and a dollar amount that looks like a year.
  ["Restroom complaints fell 40 per-cent.", "40 per-cent"],
  ["30pc fewer complaints.", "30pc"],
  ["Complaints dropped by 30 in a month.", "dropped by 30"],
  ["Cuts the number of sick days by 30.", "Cuts the number of sick days by 30"],
  ["Saves you $2000 a year.", "Saves you $2000"],
  // A testimonial that states a result is a result claim.
  ['"Since Northwind took over, our sick days fell 20%." — a client', "20%"],
];

/** Offers, prices, ordinary facts and near misses: none of these is a result claim. */
const ALLOWED: readonly string[] = [
  "20% off your first clean.",
  "Book a deep clean this month and get 15 percent off.",
  "A 10% discount for a second site.",
  "Office cleaning from $185 a visit.",
  "$99 for a restroom sanitise add-on.",
  "Get $50 off your first window clean.",
  "Day porters at $42.00 an hour.",
  "We have cleaned buildings since 2011.",
  "We look after about 90 buildings on recurring contracts.",
  "Crews of 2 cleaners, 6 crews in all.",
  "Open Monday to Friday, 07:00 to 17:00.",
  "Call 503 555 0142 for a walkthrough.",
  "Carpet extraction is two passes with a pre-spray.",
  "We test every smoke alarm on a maintenance visit.",
  "Our crews show up at the same time each week.",
  "Approved by the building manager before we start.",
  "The lower 2 floors are cleaned nightly.",
  "Cleaning 3 times a week, or every night.",
  "Our evergreen hedges and the greenhouse lobby both get attention.",
  "A clean entrance makes a good first impression.",
  "Interior glass on a quarterly schedule.",
  "Strip and re-wax includes four coats.",
  "We reduced our holiday hours for 2026.",
  // Offers on a price, written in digits or words.
  "Twenty percent off your first clean.",
  "Get ten percent off.",
  "20% off a deep clean this month.",
  "15% off window cleaning in March.",
  "10% discount on your next visit, this month only.",
  // Number words that are not results.
  "Two crews on every site.",
  "One free clean for every referral.",
  "Three visits a week, or five.",
  "A half-day porter shift is available.",
];

describe("findResultClaims", () => {
  it.each(REFUSED)("refuses %j, naming %j", (text, phrase) => {
    const claims = findResultClaims(text, []);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.phrase).toBe(phrase);
    // The claim is the whole sentence it sits in, so a person approves something they can read.
    expect(claims[0]?.claim).toBe(text);
  });

  it.each(ALLOWED)("allows %j", (text) => {
    expect(findResultClaims(text, [])).toEqual([]);
  });

  it("reads fullwidth digits and signs as the digits they are", () => {
    expect(findResultClaims("３０％ fewer sick days.", [])).toEqual([
      { claim: "３０％ fewer sick days.", phrase: "30%" },
    ]);
  });

  it("masks an offer on a service the company names, and only then", () => {
    const text = "25% off Day porter cover this month.";
    expect(findResultClaims(text, [])).toHaveLength(1);
    expect(findResultClaims(text, [], ["Day porter"])).toEqual([]);
  });

  it("names each claim in a longer text once, by its sentence, in order", () => {
    const text =
      "Winter is hard on lobbies. Our floor care is 2x cleaner and eco-friendly.\nBook now: 20% off your first clean. Tests prove it works!";
    expect(findResultClaims(text, [])).toEqual([
      { claim: "Our floor care is 2x cleaner and eco-friendly.", phrase: "2x cleaner" },
      { claim: "Tests prove it works!", phrase: "Tests prove" },
    ]);
  });

  it("lets through a claim only when the exact claim is approved, ignoring case and spacing", () => {
    const approved = ["Our nightly clean cut restroom complaints 40% in 2025."];
    expect(
      findResultClaims("Our nightly clean cut  restroom complaints 40% in 2025.", approved),
    ).toEqual([]);
    expect(
      findResultClaims("our nightly clean cut restroom complaints 40% in 2025", approved),
    ).toEqual([]);
    // A different figure, or the approved sentence with more added to it, is a different claim.
    expect(
      findResultClaims("Our nightly clean cut restroom complaints 45% in 2025.", approved),
    ).toHaveLength(1);
    expect(
      findResultClaims(
        "Our nightly clean cut restroom complaints 40% in 2025 and sick days 30%.",
        approved,
      ),
    ).toHaveLength(1);
  });

  it("catches a result phrased as an offer", () => {
    const claims = findResultClaims("30% off your hours of lost work", []);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.phrase).toBe("30%");
  });

  it("still masks a real offer", () => {
    expect(findResultClaims("20% off your first clean", [])).toEqual([]);
    expect(findResultClaims("20% off your first clean, and no contract to sign", [])).toEqual([]);
  });

  it.each([
    "25% off your hours of overtime",
    "30% off staff sickness hours",
    "40% off your hours of absenteeism",
    "30% off hours of cleanup",
    "20% off the hours lost to injury",
    "20% off workplace injuries",
    "15% off slip accidents in the lobby",
    "15% off the accident count",
    "50% off the germs on every desk",
    "50% off every germ in the lunch room",
    "Sick days, 30% off.",
    "30% off the months you lose to flu season",
    "20% off the days you are losing to sickness",
    "25% off the weeks your team loses to colds",
    "Complaints: 30% off.",
  ])("catches a result read by its stem, or named before the offer: %j", (text) => {
    expect(findResultClaims(text, [])).toHaveLength(1);
  });

  it.each([
    "20% off your first clean",
    "10% off your first month",
    "$50 off a deep clean",
    "20% off your first 10 hours",
    "10% off day porter hours.",
    "10% off the hours of a day porter",
  ])("still masks a real offer: %j", (text) => {
    expect(findResultClaims(text, [], ["Day porter", "Deep clean and floor care"])).toEqual([]);
  });

  it("catches a claim split from its number by a line break", () => {
    expect(findResultClaims("Cuts sick days by\n30%.", [])).toEqual([
      { claim: "Cuts sick days by 30%.", phrase: "30%" },
    ]);
    expect(findResultClaims("Cuts sick days\nby\r\n 30%.\nAsk us.", [])).toHaveLength(1);
  });

  it("ends a sentence at a blank line, not at a single line break", () => {
    expect(findResultClaims("Cuts complaints by\n\n30 visits a month.", [])).toEqual([]);
  });

  it("finds nothing in an empty text", () => {
    expect(findResultClaims("", [])).toEqual([]);
    expect(findResultClaims("   \n  ", [])).toEqual([]);
  });
});
