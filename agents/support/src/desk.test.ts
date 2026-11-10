/**
 * The demonstration desk's limits, each one enforced in code: invoice lines priced from the price book
 * and the credit worked out here, a credit proposed once per case and issued only as a person approved it, the
 * re-clean window and the kinds of case a re-clean puts right, the person a case is escalated to (never
 * the person a complaint is about), and the conditions a case must meet to close. Every write is
 * replayed under the same request id and must happen once.
 */

import { describe, expect, it } from "vitest";
import { companyHead, escalationOwner, findPeople, loadCompanyFacts, person } from "./company.js";
import {
  type Credit,
  creditApprovalFacts,
  DEMO_NOW,
  demoCredits,
  fakeSupportDesk,
  type SupportDesk,
  SupportDeskError,
} from "./desk.js";

const company = loadCompanyFacts();
const refunds = company.policies.refunds;
const RECOVERY = refunds.serviceRecoveryCreditCents;

const desk = (): SupportDesk => fakeSupportDesk({ now: () => new Date(DEMO_NOW) });

async function refusal(promise: Promise<unknown>): Promise<SupportDeskError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SupportDeskError) return error;
    throw error;
  }
  throw new Error("expected the desk to refuse");
}

const priceOf = (id: string) => company.priceBook.find((item) => item.id === id);

/**
 * A credit for C-302 on the first line of its client's October invoice: the desk works out the rest.
 * C-301 and C-304 already have a demonstration credit pending, so a fresh proposal is on C-302.
 */
const CREDIT = { caseId: "C-302", invoiceId: "INV-2042", line: 1 };

const SAFETY = {
  clientId: "CL-102",
  kind: "complaint" as const,
  category: "safety" as const,
  summary: "An unlabelled bottle of bleach was left on a low shelf in the toddler room.",
  reportedBy: "Megan Shaw",
  source: "email from Megan Shaw, Monday 9 November",
};

describe("fakeSupportDesk: clients and invoices", () => {
  it("finds a client by name, contact, contract or email, with its open cases counted", async () => {
    const support = desk();
    for (const query of [
      "hawthorne",
      "Grace Liu",
      "CT-301",
      "grace@hawthornefamilydental.example",
    ]) {
      const found = await support.findClient(query);
      expect(
        found.map((client) => client.id),
        query,
      ).toEqual(["CL-101"]);
    }
    const [gateway] = await support.findClient("Gateway Accounting");
    // C-305 is open; C-300 is closed.
    expect(gateway?.openCases).toBe(1);
    expect(await support.findClient("Nobody Ltd")).toEqual([]);
  });

  it("prices every invoice line from the price book and works out the credit in code", async () => {
    const [october] = await desk().listInvoices("CL-101");
    const visit = priceOf("clean-office-visit");
    const consumables = priceOf("consumables-restroom");
    if (visit === undefined || consumables === undefined) throw new Error("price book changed");
    expect(october?.id).toBe("INV-2041");
    expect(october?.lines[0]).toMatchObject({
      line: 1,
      quantity: 22,
      unitPriceCents: visit.unitPriceCents,
      lineTotalCents: 22 * visit.unitPriceCents,
      // The line is worth more than the usual credit, so the credit is the usual credit.
      creditCents: Math.min(22 * visit.unitPriceCents, RECOVERY),
    });
    expect(october?.lines[1]).toMatchObject({
      line: 2,
      lineTotalCents: 44 * consumables.unitPriceCents,
      // The line is worth less than the usual credit, so the credit is never more than the line.
      creditCents: Math.min(44 * consumables.unitPriceCents, RECOVERY),
    });
    expect(october?.totalCents).toBe(22 * visit.unitPriceCents + 44 * consumables.unitPriceCents);
  });

  it("applies a price book line's minimum", async () => {
    const support = fakeSupportDesk({
      invoices: [
        {
          id: "INV-9",
          clientId: "CL-101",
          period: "October 2026",
          issuedOn: "2026-11-02",
          lines: [{ priceBookId: "floor-carpet-sqft", quantity: 10 }],
        },
      ],
    });
    const [invoice] = await support.listInvoices("CL-101");
    expect(invoice?.lines[0]?.lineTotalCents).toBe(priceOf("floor-carpet-sqft")?.minimumCents);
  });
});

describe("fakeSupportDesk: logging a case", () => {
  it("numbers the case, sets the priority from its kind and category, and logs it once on replay", async () => {
    const support = desk();
    const first = await support.logCase(SAFETY, { requestId: "log-1" });
    const again = await support.logCase(SAFETY, { requestId: "log-1" });
    expect(again).toEqual(first);
    expect(first).toMatchObject({
      id: "C-306",
      clientName: "Little Acorns Childcare",
      status: "open",
      priority: "urgent",
      openedOn: "2026-11-09",
      firstResponseDue: "2026-11-09",
    });
    const question = await support.logCase(
      { ...SAFETY, kind: "question", category: "other", summary: "Do you clean on holidays?" },
      { requestId: "log-2" },
    );
    expect(question).toMatchObject({ id: "C-307", priority: "normal" });
    const complaint = await support.logCase(
      { ...SAFETY, category: "quality", summary: "Bins not emptied." },
      { requestId: "log-3" },
    );
    expect(complaint.priority).toBe("high");
    expect(await support.listCases({ clientId: "CL-102" })).toHaveLength(4);
  });

  it("refuses an unknown client, and a case with no summary, reporter or source", async () => {
    const support = desk();
    expect(
      (await refusal(support.logCase({ ...SAFETY, clientId: "CL-999" }, { requestId: "x1" }))).code,
    ).toBe("not_found");
    for (const field of ["summary", "reportedBy", "source"] as const) {
      const refused = await refusal(
        support.logCase({ ...SAFETY, [field]: "  " }, { requestId: `x-${field}` }),
      );
      expect(refused.code, field).toBe("invalid");
    }
    expect(await support.listCases({ clientId: "CL-102" })).toHaveLength(1);
  });
});

describe("fakeSupportDesk: re-cleans", () => {
  it("books a re-clean inside the window, once on replay", async () => {
    const support = desk();
    const booked = await support.bookReclean(
      { caseId: "C-301", date: "2026-11-11" },
      { requestId: "r1" },
    );
    const again = await support.bookReclean(
      { caseId: "C-301", date: "2026-11-11" },
      { requestId: "r1" },
    );
    expect(again).toEqual(booked);
    expect(booked.reclean).toEqual({ date: "2026-11-11", done: false, bookedOn: "2026-11-09" });
  });

  it("refuses a date before today or after the window, counted in business days from the complaint", async () => {
    // C-301 was opened on Friday 6 November; the window is the company's, in business days.
    expect(refunds.recleanWindowDays).toBe(5);
    const support = desk();
    const past = await refusal(
      support.bookReclean({ caseId: "C-301", date: "2026-11-06" }, { requestId: "r2" }),
    );
    expect(past.code).toBe("outside_window");
    const late = await refusal(
      support.bookReclean({ caseId: "C-301", date: "2026-11-16" }, { requestId: "r3" }),
    );
    expect(late.code).toBe("outside_window");
    expect(late.message).toContain("2026-11-13");
    const last = await support.bookReclean(
      { caseId: "C-301", date: "2026-11-13" },
      { requestId: "r4" },
    );
    expect(last.reclean?.date).toBe("2026-11-13");
  });

  it("refuses a case a re-clean does not put right, a second re-clean, a closed case and a bad date", async () => {
    const support = desk();
    const code = async (caseId: string, date = "2026-11-11") =>
      (await refusal(support.bookReclean({ caseId, date }, { requestId: `r-${caseId}-${date}` })))
        .code;
    expect(await code("C-304")).toBe("not_reclean");
    expect(await code("C-303")).toBe("not_a_complaint");
    expect(await code("C-305")).toBe("already_booked");
    expect(await code("C-300")).toBe("closed");
    expect(await code("C-999")).toBe("not_found");
    expect(await code("C-301", "next Wednesday")).toBe("invalid");
    const safety = await support.logCase(SAFETY, { requestId: "log" });
    expect(await code(safety.id)).toBe("not_reclean");
  });
});

describe("fakeSupportDesk: credits", () => {
  it("proposes the credit the desk works out, issues nothing, and records one proposal on replay", async () => {
    const support = desk();
    const proposal = await support.proposeCredit(CREDIT, { requestId: "p1" });
    const again = await support.proposeCredit(CREDIT, { requestId: "p1" });
    expect(again).toEqual(proposal);
    expect(proposal).toMatchObject({
      id: "CR-402",
      status: "pending",
      caseId: "C-302",
      clientId: "CL-102",
      client: "Little Acorns Childcare",
      invoiceId: "INV-2042",
      line: 1,
      creditCents: RECOVERY,
      creditNoteId: null,
    });
    expect(await support.listCredits({ caseId: "C-302" })).toEqual([proposal]);
    const [proposed] = await support.listCases({ caseId: "C-302" });
    expect(proposed?.credit).toEqual(proposal);
  });

  it("refuses a second credit for the same line", async () => {
    const support = desk();
    await support.proposeCredit(CREDIT, { requestId: "p1" });
    const pending = await refusal(support.proposeCredit(CREDIT, { requestId: "p2" }));
    expect(pending.code).toBe("duplicate_credit");
    const [proposal] = await support.listCredits({ caseId: "C-302" });
    await support.issueCredit(
      { creditId: proposal?.id ?? "", approved: creditApprovalFacts(proposal as Credit) },
      { requestId: "i1" },
    );
    const issued = await refusal(support.proposeCredit(CREDIT, { requestId: "p3" }));
    expect(issued.code).toBe("duplicate_credit");
    // Another line on a case that already has its credit is not a second credit either.
    const other = await refusal(support.proposeCredit({ ...CREDIT, line: 2 }, { requestId: "p4" }));
    expect(other.code).toBe("already_credited");
    expect(await support.listCredits({ caseId: "C-302" })).toHaveLength(1);
  });

  it("refuses another client's invoice, a missing line, a question, a closed case and a case with a credit pending", async () => {
    const support = desk();
    const code = async (input: typeof CREDIT, id: string) =>
      (await refusal(support.proposeCredit(input, { requestId: id }))).code;
    expect(await code({ ...CREDIT, invoiceId: "INV-2041" }, "w1")).toBe("wrong_client");
    expect(await code({ ...CREDIT, line: 3 }, "w2")).toBe("not_found");
    expect(await code({ ...CREDIT, invoiceId: "INV-0001" }, "w3")).toBe("not_found");
    expect(await code({ ...CREDIT, caseId: "C-303" }, "w4")).toBe("not_a_complaint");
    expect(await code({ ...CREDIT, caseId: "C-300" }, "w5")).toBe("closed");
    expect(await code({ ...CREDIT, caseId: "C-304", invoiceId: "INV-2044", line: 2 }, "w6")).toBe(
      "credit_pending",
    );
    expect(await code({ ...CREDIT, caseId: "C-304", invoiceId: "INV-2044", line: 1 }, "w7")).toBe(
      "duplicate_credit",
    );
  });

  it("issues exactly the approved proposal once on replay, and marks it issued", async () => {
    const support = desk();
    const proposal = await support.proposeCredit(CREDIT, { requestId: "p1" });
    const input = { creditId: proposal.id, approved: creditApprovalFacts(proposal) };
    const note = await support.issueCredit(input, { requestId: "i1" });
    expect(await support.issueCredit(input, { requestId: "i1" })).toEqual(note);
    expect(note).toMatchObject({
      id: "CN-501",
      creditId: proposal.id,
      caseId: "C-302",
      invoiceId: "INV-2042",
      line: 1,
      creditCents: RECOVERY,
      issuedOn: "2026-11-09",
    });
    const [issued] = await support.listCredits({ creditId: proposal.id });
    expect(issued).toMatchObject({ status: "issued", creditNoteId: "CN-501" });
    const twice = await refusal(support.issueCredit(input, { requestId: "i2" }));
    expect(twice.code).toBe("already_credited");
  });

  it("refuses when the proposal changed after the facts were read", async () => {
    const support = desk();
    const proposal = await support.proposeCredit(CREDIT, { requestId: "p1" });
    const approved = creditApprovalFacts(proposal);
    for (const changed of [
      { ...approved, creditCents: RECOVERY + 1 },
      { ...approved, client: "Someone Else" },
      { ...approved, line: 2 },
    ]) {
      const refused = await refusal(
        support.issueCredit({ creditId: proposal.id, approved: changed }, { requestId: "c" }),
      );
      expect(refused.code).toBe("credit_changed");
    }
    // Withdrawn while a person was deciding: the grant covers a pending proposal that is gone.
    await support.withdrawCredit(
      { creditId: proposal.id, reason: "Declined by a person." },
      { requestId: "w1" },
    );
    const withdrawn = await refusal(
      support.issueCredit({ creditId: proposal.id, approved }, { requestId: "c2" }),
    );
    expect(withdrawn.code).toBe("credit_changed");
    expect((await support.listCredits({ creditId: proposal.id }))[0]?.status).toBe("withdrawn");
  });

  it("withdraws a pending proposal once on replay with its reason, and never an issued one", async () => {
    const support = desk();
    const proposal = await support.proposeCredit(CREDIT, { requestId: "p1" });
    const input = { creditId: proposal.id, reason: "The person approving credits declined it." };
    const withdrawn = await support.withdrawCredit(input, { requestId: "w1" });
    expect(await support.withdrawCredit(input, { requestId: "w1" })).toEqual(withdrawn);
    expect(withdrawn).toMatchObject({ status: "withdrawn", withdrawnReason: input.reason });
    expect((await support.listCases({ caseId: "C-302" }))[0]?.credit).toBeNull();
    expect((await refusal(support.withdrawCredit(input, { requestId: "w2" }))).code).toBe(
      "invalid",
    );
    expect(
      (await refusal(support.withdrawCredit({ ...input, reason: " " }, { requestId: "w3" }))).code,
    ).toBe("invalid");
    expect(
      (await refusal(support.withdrawCredit({ ...input, creditId: "CR-9" }, { requestId: "w4" })))
        .code,
    ).toBe("not_found");

    const other = desk();
    const issued = await other.proposeCredit(CREDIT, { requestId: "p" });
    await other.issueCredit(
      { creditId: issued.id, approved: creditApprovalFacts(issued) },
      { requestId: "i" },
    );
    expect(
      (await refusal(other.withdrawCredit({ ...input, creditId: issued.id }, { requestId: "w" })))
        .code,
    ).toBe("already_credited");
  });
});

describe("fakeSupportDesk: escalation", () => {
  it("hands each reason to the person the company record names for it", async () => {
    const expected: Record<string, string | undefined> = {
      safety: escalationOwner(company, "safety-incident")?.id,
      refund: refunds.refundNeeds,
      billing: refunds.creditNeeds,
      legal: escalationOwner(company, "contract-terms")?.id,
      data: escalationOwner(company, "data-and-security")?.id,
      unresolved: refunds.complaintOwner,
    };
    for (const [reason, owner] of Object.entries(expected)) {
      const support = desk();
      const receipt = await support.escalateCase(
        { caseId: "C-301", reason: reason as never, note: "Please look at this." },
        { requestId: `e-${reason}` },
      );
      expect(owner, reason).toBeDefined();
      expect(receipt.toPersonId, reason).toBe(owner);
      expect(receipt.toName).toBe(person(company, owner ?? "")?.name);
      expect(receipt.redirected).toBe(false);
    }
  });

  it("never hands a complaint about someone to that same person", async () => {
    const owner = person(company, refunds.complaintOwner);
    const head = companyHead(company);
    if (owner === undefined || head === undefined) throw new Error("company changed");
    const firstName = owner.name.split(" ")[0] ?? owner.name;
    const support = desk();
    const receipt = await support.escalateCase(
      { caseId: "C-303", reason: "staff", note: "Rude on the phone.", about: firstName },
      { requestId: "s1" },
    );
    expect(receipt.toPersonId).toBe(head.id);
    expect(receipt.toPersonId).not.toBe(owner.id);
    expect(receipt.redirected).toBe(true);
    expect(receipt.about).toBe(firstName);

    // A complaint about the head goes to the complaint owner instead.
    const aboutHead = await desk().escalateCase(
      { caseId: "C-303", reason: "staff", note: "Rude.", about: head.name },
      { requestId: "s2" },
    );
    expect(aboutHead.toPersonId).toBe(owner.id);

    // Whatever the reason, a case never goes to anyone it names: a refund naming the person who
    // decides money back goes up the line instead.
    const refundOwner = person(company, refunds.refundNeeds);
    const named = await desk().escalateCase(
      { caseId: "C-301", reason: "refund", note: "Wants October back.", about: refundOwner?.name },
      { requestId: "s3" },
    );
    expect(named.toPersonId).not.toBe(refundOwner?.id);
    expect(named.redirected).toBe(true);

    // A crew member the record does not list is not a person the case could go to.
    const crew = await desk().escalateCase(
      { caseId: "C-301", reason: "staff", note: "Crew lead was rude.", about: "the crew lead" },
      { requestId: "s4" },
    );
    expect(crew.toPersonId).toBe(owner.id);
    expect(crew.redirected).toBe(false);
  });

  it("recognises the person a staff complaint is about by title, surname or first name, as whole words", async () => {
    const owner = person(company, refunds.complaintOwner);
    const head = companyHead(company);
    if (owner === undefined || head === undefined) throw new Error("company changed");
    const [first = "", last = ""] = owner.name.split(" ");
    for (const about of [
      `the ${owner.title}`,
      `your ${owner.title.toLowerCase()}`,
      `Mr ${last}`,
      first,
      `${first.toUpperCase()} on the phone`,
    ]) {
      const receipt = await desk().escalateCase(
        { caseId: "C-303", reason: "staff", note: "Rude on the phone.", about },
        { requestId: `w-${about}` },
      );
      expect(receipt.toPersonId, about).toBe(head.id);
      expect(receipt.redirected, about).toBe(true);
    }
    // A word that merely contains a name is not that person.
    const near = await desk().escalateCase(
      { caseId: "C-303", reason: "staff", note: "Rude.", about: `${first}as from the night crew` },
      { requestId: "w-near" },
    );
    expect(near.toPersonId).toBe(owner.id);
    expect(near.redirected).toBe(false);
  });

  it('a staff complaint about "HR" is routed away from the People Ops person', async () => {
    const peopleOps = company.people.find((candidate) => /\bpeople\b/i.test(candidate.title));
    const head = companyHead(company);
    if (peopleOps === undefined || head === undefined) throw new Error("company changed");
    // The complaint owner is the People Ops person here, so "HR" must send it up to the head.
    const hrOwned = {
      ...company,
      policies: {
        ...company.policies,
        refunds: { ...refunds, complaintOwner: peopleOps.id },
      },
    };
    const receipt = await fakeSupportDesk({
      company: hrOwned,
      now: () => new Date(DEMO_NOW),
    }).escalateCase(
      { caseId: "C-303", reason: "staff", note: "Rude on the phone.", about: "HR" },
      { requestId: "hr1" },
    );
    expect(receipt.toPersonId).toBe(head.id);
    expect(receipt.toPersonId).not.toBe(peopleOps.id);
  });

  it("never hands a safety complaint to the safety owner it is about, and a safety case goes to safety first", async () => {
    const safetyOwner = escalationOwner(company, "safety-incident");
    if (safetyOwner === undefined) throw new Error("company changed");
    const receipt = await desk().escalateCase(
      { caseId: "C-301", reason: "safety", note: "Ignored a hazard.", about: safetyOwner.name },
      { requestId: "y1" },
    );
    expect(receipt.toPersonId).not.toBe(safetyOwner.id);
    expect(receipt.toPersonId).toBe(refunds.complaintOwner);
    expect(receipt.redirected).toBe(true);

    // A logged safety complaint is escalated for safety before anything else.
    const support = desk();
    const logged = await support.logCase(SAFETY, { requestId: "y-log" });
    const wrong = await refusal(
      support.escalateCase(
        { caseId: logged.id, reason: "unresolved", note: "Bleach left out." },
        { requestId: "y2" },
      ),
    );
    expect(wrong.code).toBe("not_escalated");
    await support.escalateCase(
      { caseId: logged.id, reason: "safety", note: "Bleach left out." },
      { requestId: "y3" },
    );
    const refund = await support.escalateCase(
      { caseId: logged.id, reason: "refund", note: "Wants the month back." },
      { requestId: "y4" },
    );
    expect(refund.toPersonId).toBe(refunds.refundNeeds);
  });

  it("keeps a staff-category complaint away from its subject whatever reason it is escalated under", async () => {
    const owner = person(company, refunds.complaintOwner);
    if (owner === undefined) throw new Error("company changed");
    for (const reason of ["unresolved", "billing", "legal"] as const) {
      const support = desk();
      const logged = await support.logCase(
        { ...SAFETY, category: "staff", summary: "Rude on the phone." },
        { requestId: `st-log-${reason}` },
      );
      const receipt = await support.escalateCase(
        { caseId: logged.id, reason, note: "Rude on the phone.", about: owner.name },
        { requestId: `st-${reason}` },
      );
      expect(receipt.toPersonId, reason).not.toBe(owner.id);
    }
  });

  it("a complaint naming Tom under reason quality is not routed to Tom", async () => {
    const owner = person(company, refunds.complaintOwner);
    const head = companyHead(company);
    if (owner === undefined || head === undefined) throw new Error("company changed");
    const first = owner.name.split(" ")[0] ?? owner.name;
    // Logged as a quality complaint, with the person named only in the client's own words.
    const support = desk();
    const logged = await support.logCase(
      {
        ...SAFETY,
        category: "quality",
        summary: `Floors left dirty, and ${first} hung up on us when we called.`,
      },
      { requestId: "q-log" },
    );
    const fromSummary = await support.escalateCase(
      { caseId: logged.id, reason: "unresolved", note: "Third poor visit this month." },
      { requestId: "q1" },
    );
    expect(fromSummary.toPersonId).toBe(head.id);
    expect(fromSummary.redirected).toBe(true);
    // Named in the note on a case whose summary names nobody.
    const fromNote = await desk().escalateCase(
      { caseId: "C-301", reason: "unresolved", note: `The client says ${first} ignored them.` },
      { requestId: "q2" },
    );
    expect(fromNote.toPersonId).toBe(head.id);
    // A case that names nobody still goes to its usual owner.
    const plain = await desk().escalateCase(
      { caseId: "C-301", reason: "unresolved", note: "Third poor visit this month." },
      { requestId: "q3" },
    );
    expect(plain.toPersonId).toBe(owner.id);
    expect(plain.redirected).toBe(false);
  });

  it("findPeople matches DW and D. Whitfield to Dana", async () => {
    const dana = person(company, "dana-whitfield");
    if (dana === undefined) throw new Error("company changed");
    expect(findPeople(company, "it was DW who promised it").map((who) => who.id)).toEqual([
      dana.id,
    ]);
    expect(findPeople(company, "D. Whitfield signed it").map((who) => who.id)).toEqual([dana.id]);
    // The money-back owner named by her initials is not handed the case.
    const receipt = await desk().escalateCase(
      { caseId: "C-301", reason: "refund", note: "DW promised a refund on the phone." },
      { requestId: "dw" },
    );
    expect(receipt.toPersonId).not.toBe(dana.id);
    expect(receipt.redirected).toBe(true);
  });

  it("existing title-word matches route as before", async () => {
    // The words colleagues used before aliases existed still find the same people.
    const ids = (words: string) => findPeople(company, words).map((who) => who.id);
    expect(ids("the client services lead")).toEqual(["tom-becker"]);
    expect(ids("HR")).toEqual(["jules-okafor"]);
    expect(ids("the operations manager")).toEqual(["priya-raman"]);
    expect(ids("finance and billing")).toEqual(["eileen-hart"]);
    expect(ids("the night crew")).toEqual([]);
  });

  it("excludes every person a complaint names, not only the first", async () => {
    const owner = person(company, refunds.complaintOwner);
    const head = companyHead(company);
    const safetyOwner = escalationOwner(company, "safety-incident");
    if (owner === undefined || head === undefined || safetyOwner === undefined) {
      throw new Error("company changed");
    }
    // The safety owner comes before the complaint owner in the record, so a first-match lookup
    // would exclude only the safety owner and hand the case to the complaint owner it also names.
    expect(company.people.indexOf(safetyOwner)).toBeLessThan(company.people.indexOf(owner));
    const receipt = await desk().escalateCase(
      {
        caseId: "C-303",
        reason: "staff",
        note: "Both were rude.",
        about: `${safetyOwner.name} and ${owner.name}`,
      },
      { requestId: "two" },
    );
    expect(receipt.toPersonId).toBe(head.id);

    // Naming everyone the case could go to leaves nobody: the desk refuses rather than guess.
    const nobody = await refusal(
      desk().escalateCase(
        {
          caseId: "C-303",
          reason: "staff",
          note: "All rude.",
          about: `${head.name} and ${owner.name}`,
        },
        { requestId: "none" },
      ),
    );
    expect(nobody.code).toBe("no_one");
  });

  it("marks the case escalated, escalates once on replay, and refuses the same reason twice", async () => {
    const support = desk();
    const input = { caseId: "C-301", reason: "unresolved" as const, note: "Third time." };
    const first = await support.escalateCase(input, { requestId: "e1" });
    const again = await support.escalateCase(input, { requestId: "e1" });
    expect(again).toEqual(first);
    const [escalated] = await support.listCases({ caseId: "C-301" });
    expect(escalated?.status).toBe("escalated");
    expect(escalated?.escalations).toHaveLength(1);
    expect((await refusal(support.escalateCase(input, { requestId: "e2" }))).code).toBe(
      "already_escalated",
    );
    // A different reason on the same case is a second hand-off.
    await support.escalateCase({ ...input, reason: "refund" }, { requestId: "e3" });
    expect((await support.listCases({ caseId: "C-301" }))[0]?.escalations).toHaveLength(2);
  });

  it("refuses a staff complaint that names nobody, an empty note, and a closed case", async () => {
    const support = desk();
    const code = async (input: Parameters<SupportDesk["escalateCase"]>[0], id: string) =>
      (await refusal(support.escalateCase(input, { requestId: id }))).code;
    expect(await code({ caseId: "C-301", reason: "staff", note: "Rude." }, "z1")).toBe("invalid");
    expect(await code({ caseId: "C-301", reason: "safety", note: " " }, "z2")).toBe("invalid");
    expect(await code({ caseId: "C-300", reason: "refund", note: "Money back." }, "z3")).toBe(
      "closed",
    );
  });
});

describe("fakeSupportDesk: closing a case", () => {
  it("closes a case with its outcome recorded, once on replay", async () => {
    const support = desk();
    const input = { caseId: "C-302", outcome: "Re-clean done; the director confirmed it." };
    const closed = await support.resolveCase(input, { requestId: "x1" });
    const again = await support.resolveCase(input, { requestId: "x1" });
    expect(again).toEqual(closed);
    expect(closed).toMatchObject({
      status: "closed",
      outcome: input.outcome,
      closedOn: "2026-11-09",
    });
    expect((await refusal(support.resolveCase(input, { requestId: "x2" }))).code).toBe("closed");
  });

  it("refuses no outcome, a credit waiting, a re-clean not done, an unescalated safety case and a case a person has", async () => {
    const support = desk();
    const code = async (caseId: string, outcome = "Sorted.") =>
      (await refusal(support.resolveCase({ caseId, outcome }, { requestId: `y-${caseId}` }))).code;
    expect(await code("C-302", "  ")).toBe("invalid");
    expect(await code("C-304")).toBe("credit_pending");
    expect(await code("C-305")).toBe("reclean_pending");
    const safety = await support.logCase(SAFETY, { requestId: "log" });
    expect(await code(safety.id)).toBe("not_escalated");
    await support.escalateCase(
      { caseId: safety.id, reason: "safety", note: "Bleach left out." },
      { requestId: "esc" },
    );
    const escalated = await refusal(
      support.resolveCase({ caseId: safety.id, outcome: "Done." }, { requestId: "y-again" }),
    );
    expect(escalated.code).toBe("escalated");
    // Nothing above was closed.
    expect((await support.listCases({ status: "closed" })).map((entry) => entry.id)).toEqual([
      "C-300",
    ]);
  });

  it("resolve_case refuses while a credit proposal is pending", async () => {
    const support = desk();
    const proposal = await support.proposeCredit(CREDIT, { requestId: "p" });
    const pending = await refusal(
      support.resolveCase({ caseId: "C-302", outcome: "Sorted." }, { requestId: "r1" }),
    );
    expect(pending.code).toBe("credit_pending");
    expect(pending.message).toContain(proposal.id);
    expect((await support.listCases({ caseId: "C-302" }))[0]?.status).toBe("open");
  });

  it("a withdrawn proposal lets the case resolve", async () => {
    const support = desk();
    const proposal = await support.proposeCredit(CREDIT, { requestId: "p" });
    await support.withdrawCredit(
      { creditId: proposal.id, reason: "Declined by the person who approves credits." },
      { requestId: "w" },
    );
    const closed = await support.resolveCase(
      { caseId: "C-302", outcome: "Credit declined; the client was told." },
      { requestId: "r" },
    );
    expect(closed.status).toBe("closed");
  });

  it("closes a complaint once its booked re-clean is no longer waiting, and after a credit is issued", async () => {
    const support = desk();
    const proposal = await support.proposeCredit(CREDIT, { requestId: "propose" });
    await support.issueCredit(
      { creditId: proposal.id, approved: creditApprovalFacts(proposal) },
      { requestId: "credit" },
    );
    const closed = await support.resolveCase(
      { caseId: "C-302", outcome: "Credit note issued on the October invoice." },
      { requestId: "close" },
    );
    expect(closed.status).toBe("closed");
    // Booking a re-clean makes the case wait for it again (with no credit pending on it).
    const other = fakeSupportDesk({ credits: [], now: () => new Date(DEMO_NOW) });
    await other.bookReclean({ caseId: "C-301", date: "2026-11-11" }, { requestId: "book" });
    expect(
      (await refusal(other.resolveCase({ caseId: "C-301", outcome: "Done." }, { requestId: "c" })))
        .code,
    ).toBe("reclean_pending");
  });
});

describe("fakeSupportDesk: demonstration data", () => {
  it("prices each demonstration credit as the desk would propose it today", async () => {
    expect(demoCredits().map((credit) => credit.caseId)).toEqual(["C-304", "C-301"]);
    for (const seeded of demoCredits()) {
      const fresh = fakeSupportDesk({ credits: [], now: () => new Date(DEMO_NOW) });
      const proposal = await fresh.proposeCredit(seeded, { requestId: "p" });
      const { id: _id, proposedOn: _on, ...expected } = seeded;
      expect(proposal, seeded.id).toMatchObject(expected);
    }
  });

  it("lists cases by client, by id and by status", async () => {
    const support = desk();
    expect((await support.listCases()).map((entry) => entry.id)).toEqual([
      "C-300",
      "C-301",
      "C-302",
      "C-303",
      "C-304",
      "C-305",
    ]);
    expect((await support.listCases({ status: "open" })).map((entry) => entry.id)).toEqual([
      "C-301",
      "C-302",
      "C-303",
      "C-304",
      "C-305",
    ]);
    expect((await support.listCases({ clientId: "CL-105" })).map((entry) => entry.id)).toEqual([
      "C-300",
      "C-305",
    ]);
  });
});
