/** The invented-testimonial check, on examples both ways. */

import { describe, expect, it } from "vitest";
import { loadCompanyFacts } from "./company.js";
import { findUnrecordedTestimonials, ownNames } from "./testimonials.js";

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
    const OWN = {
      company: ["Northwind Facilities", "Northwind Facilities Ltd."],
      offerings: ["Day porter", "Window cleaning"],
    };
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
      expect(
        findUnrecordedTestimonials(text, RECORD, { company: ["Northwind Facilities"] }),
      ).toHaveLength(1);
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
      expect(
        findUnrecordedTestimonials(text, RECORD, { company: ["Northwind Facilities"] }),
      ).toEqual([]);
    });
  });

  describe("probe tables from the re-reviews, with the company's own names as the desk passes them", () => {
    const OWN = ownNames(loadCompanyFacts());
    const S = '"Clean offices make for happy teams every single day"';
    const I = '"We switched to Northwind last spring and have not looked back since."';
    const refused = (text: string) => findUnrecordedTestimonials(text, RECORD, OWN);
    // Re-review 3's probes: S2 is a slogan, Q an invented customer quote.
    const S2 = '"Clean offices, happy teams, every single night of the week"';
    const Q = '"Northwind is the only vendor we never have to chase, honestly."';
    const Qc = Q.replace('."', ',"');

    it.each([
      // Re-review 1: the company, greetings, lists, places, headings.
      `${S}\nNorthwind Facilities`,
      `${S}\nNorthwind Facility Services`,
      `${S} — Northwind Facility Services`,
      `${S} — Northwind`,
      `${S}\nDear Office Managers,`,
      `${S}\nHello Team,`,
      `${S}\nHi Dana,\nWinter is here.`,
      `${S}\nDay Porter. Window Cleaning. Floor Care.`,
      `${S}\nSeattle, WA`,
      `${S}\nWinter Specials, now on.`,
      `New Year Promise: ${S}`,
      'Try our "Recurring janitorial" and "Day porter" plans.',
      'Our motto: "Clean offices, happy teams."',
      `Our motto is ${S} — and we mean it.`,
      `We call it ${S} - ask us.`,
      'Book our "Floor care and carpet refresh" service today.',
      `${S}. That is our promise.`,
      'Our new 12" mats trap grit. Try "our free walkthrough for any office this month" today.',
      "Our clients' offices get the 'same crew, same time, every single night' treatment, and we don't cut corners.",
      // Re-review 2: signatures, sign-offs, lists, calls to action, headings, salutations.
      `${S}\n\nNorthwind Facilities\n1420 SE Water Avenue, Suite 210\n+1 503 555 0142`,
      `${S}\nDana Whitfield | Northwind Facilities | +1 503 555 0142`,
      `${S}\n\nDana Whitfield\nNorthwind Facilities\n+1 503 555 0142`,
      `${S}\n\nDana Whitfield, Marketing Lead\n+1 503 555 0142`,
      `${S}\n--\nDana Whitfield\n+1 503 555 0142`,
      `${S}\nPhone: +1 503 555 0142`,
      `${S}\nCall +1 503 555 0142`,
      `${S}\nThanks,\nThe team`,
      `${S}\nThanks,\nThe Northwind team`,
      `${S}\n\nThanks, The team`,
      `${S}\nThe Northwind Team`,
      `${S} — The Northwind Team`,
      `${S}\nYour Northwind Crew`,
      `${S}\nTeam Northwind`,
      `${S}\n- Free walkthrough\n- Fixed monthly price`,
      `${S}\n- Day porter\n- Window cleaning`,
      `${S}\n* Fixed Monthly Pricing\n* Insured Crews`,
      `${S}\n• Fixed Monthly Pricing\n• Insured Crews`,
      `${S}\n- Fixed Monthly Pricing\n- Insured Crews`,
      `${S}\n- Same Crew\n- Every Visit`,
      `${S}\nLearn More`,
      `${S}\nFree Walkthrough`,
      `${S}\n\nWhat We Do\nNightly cleaning for offices.`,
      `${S} Learn More.`,
      `${S} Spring Special`,
      `${S}\nProperty Managers,\nwe have news.`,
      `${S}\n**Book A Walkthrough**`,
      `${S} Book Today`,
      `${S}\n#Portland #CleanOffices`,
      `${S}\nPortland`,
      `${S}\n\nTestimonials`,
      // Re-review 3, honest probes.
      'One rule on every shift: "leave every room better than we found it." Proud of this crew.\n\n#Portland #FacilityServices',
      `${S2}\n\nWarm regards,\nPriya Raman\nAccount Manager, Northwind Facilities\n+1 503 555 0142`,
      `${S2}\n\nHow It Works\n1. Free walkthrough\n2. Fixed quote`,
      `${S2}\n\nSchedule Yours Today`,
      `${S2}\nFixed Monthly Pricing. No Surprises.`,
      'Subject: "Your office, spotless by Monday morning, every week"\n\nHi Facilities Team,\nQuick note from Northwind.',
      'Our motto has always been "if it is not clean, it is not done, full stop."\nCommercial Cleaning Since 2009',
      '"Spotless floors, fresh restrooms, and zero missed visits" — that is the standard we hold.',
      '"Your lobby is the first thing every visitor sees each day."\nCascade Dental Group trusts us with theirs.',
      'Crew Motto: "we leave it better than we found it, every night."',
      '"We treat every building like it is our own, every visit." — Dana Whitfield, Managing Director',
      `${S2}\n\nDay Porter Service\nWindow Cleaning\nFloor Care`,
      `${S2}\nWhy Northwind?\nInsured crews, fixed prices.`,
      'Three words we live by:\n"On time, every time, no matter the weather."\nNorthwind Facilities Ltd.',
      `${S2}\nPortland Metro Area`,
      `${S2}\nGet In Touch`,
      // R1: a dash line made only of heading words and the company's own name.
      `${S2} — Team Northwind`,
      // R3: a staff member signing in full is still the company.
      `${S2} — Rosa Martinez, Northwind Facilities`,
      // R5: "put it" by the company itself, and "notes" as a noun, are not a speaker.
      `We put it simply: ${S2}`,
      `Read our notes: ${S2}`,
    ])("leaves %j alone", (text) => {
      expect(refused(text)).toEqual([]);
    });

    it.each([
      // Re-review 1.
      `${I} — Morgan Ellis, Harbor Dental`,
      `${I}\nMorgan Ellis, Harbor Dental`,
      `${I}\n\n— Morgan Ellis, Harbor Dental`,
      `${I} (Morgan Ellis, Harbor Dental)`,
      `Morgan Ellis, Harbor Dental: ${I}`,
      `Morgan Ellis: ${I}`,
      `${I.replace('."', ',"')} she said.`,
      `${I.replace('."', ',"')} the practice manager told us.`,
      "'We switched to Northwind last spring and have not looked back since,' says Morgan Ellis.",
      "‘We switched to Northwind last spring and have not looked back since,’ says Morgan Ellis.",
      `${I} - a client`,
      `${I} — M. Ellis`,
      `${I} ~Morgan E.`,
      "«We switched to Northwind last spring and have not looked back since.» — Morgan Ellis",
      `Our 12" mats are new. Morgan Ellis says ${I}`,
      `${I}\n**Morgan Ellis**, Harbor Dental`,
      `From a client: ${I}`,
      `${I} Morgan Ellis, Harbor Dental`,
      // Re-review 2.
      `${I} — Morgan`,
      `${I} — _Morgan Ellis_`,
      `One of our clients: ${I}`,
      `A practice manager: ${I}`,
      `Dr. Ellis wrote: ${I}`,
      `${I} — Morgan Ellis, a customer since 2019`,
      `${I}\nMorgan Ellis\n+1 503 555 0199`,
      // N5: client titles that share a first word with a service or price book line.
      `${I} — Office Manager, Harbor Dental`,
      `${I}\nOffice Manager, Harbor Dental`,
      `${I} (Office Manager, Harbor Dental)`,
      `Office Manager, Harbor Dental: ${I}`,
      `${I} — Building Manager, Lloyd Tower`,
      `${I} — Maintenance Director, Lloyd Tower`,
      // N6: a name line ending in a full stop, and a longer tail ending in a name.
      `${I}\nMorgan Ellis, office manager, Harbor Dental.`,
      `${I}\nMorgan Ellis, office manager at Harbor Dental in Portland`,
      // N8.
      `Here's what Morgan Ellis had to say: ${I}`,
      `Morgan from Harbor Dental: ${I}`,
      `Client Morgan Ellis: ${I}`,
      `${I} — a Pearl District client`,
      // Re-review 3, invented probes.
      `${Q} — Facilities Director, Pearl Lofts`,
      `${Q} — Property Manager, Lloyd Tower`,
      `${Q} — Office Manager at Harbor Dental`,
      `${Q} — Property Manager at Lloyd Tower`,
      `${Q} — Team Lead at Harbor Dental`,
      `${Q}\nOffice Manager at Harbor Dental`,
      `As Jordan Pike, GM at Lloyd Tower, put it: ${Q}`,
      `${Q} That's from Jordan Pike at Lloyd Tower.`,
      `Jordan Pike (Lloyd Tower): ${Q}`,
      `One customer put it best: ${Q}`,
      `${Qc} notes Jordan Pike, GM of Lloyd Tower.`,
      `${Qc} shares Jordan Pike.`,
      `⭐⭐⭐⭐⭐ ${Q} – Google review`,
      `${Q} — J.P., Lloyd Tower`,
      `${Q} — Sam, office manager at a Pearl District clinic`,
      `${Q} — Rosa M., Lloyd Tower`,
      `${Q} — Tenants, Lloyd Tower`,
      `${Q} — Office Managers, Harbor Dental`,
      `${Q} — our client at Harbor Dental`,
      `Hear it from Jordan at Lloyd Tower: ${Q}`,
      `Client spotlight, Harbor Dental: ${Q}`,
      `${Q}\n\n**Jordan Pike**\nGM, Lloyd Tower`,
      `${Q} (GM, Lloyd Tower)`,
      `${Q} — GM, Lloyd Tower`,
      // R1: client titles after a dash, whatever words they share with headings.
      `${Q} — Office Manager of Harbor Dental`,
      `${Q} — Office Manager from Harbor Dental`,
      `${Q} — Building Manager from Lloyd Tower`,
      // R2: plural groups after a dash.
      `${Q} — Clients, Pearl District`,
      `${Q} — Property Managers across Portland`,
      `${Q} — Building Owners, Pearl Lofts`,
      // R5: review sites, after a dash or in brackets.
      `${Q} — Yelp review`,
      `${Q} — 5-star Facebook review`,
      `${Q} (Google review)`,
    ])("refuses %j", (text) => {
      expect(refused(text)).toHaveLength(1);
    });

    it("accepts the recorded quote with its attribution", () => {
      expect(
        refused(`"${RECORD[0]?.quote}" — Leah Brandt, office manager, Cascade Dental Group`),
      ).toEqual([]);
    });
  });

  it("refuses every quote when the company records none", () => {
    expect(findUnrecordedTestimonials(`"${RECORD[0]?.quote}" — Leah`, [])).toHaveLength(1);
  });
});
