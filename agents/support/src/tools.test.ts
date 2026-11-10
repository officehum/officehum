/**
 * One block per tool, against `fakeSupportDesk` and the company facts generated into this package,
 * through the registrations the factory builds and with the durable call identity Pi Durable hands to
 * `execute`. Every unsafe tool is replayed under the same call id here, at the tool level, and must
 * write once. Every next step is chosen from a refusal's code, never from its wording. No network, no
 * model.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { APPROVED_FACTS_ARG, type VerifiedSender } from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import {
  companyHead,
  escalationOwner,
  loadCompanyFacts,
  money,
  person,
  personLabel,
} from "./company.js";
import {
  creditApprovalFacts,
  DEMO_NOW,
  fakeSupportDesk,
  type SupportDesk,
  SupportDeskError,
} from "./desk.js";
import { type SupportToolset, supportTools } from "./tools.js";

const company = loadCompanyFacts();
const refunds = company.policies.refunds;
const creditOwner = personLabel(person(company, refunds.creditNeeds));
const refundOwner = personLabel(person(company, refunds.refundNeeds));
const complaintOwner = personLabel(person(company, refunds.complaintOwner));
const safetyOwner = personLabel(escalationOwner(company, "safety-incident"));
/** "Name (Title)", as a hand-off receipt names who has the case. */
const named = (who: ReturnType<typeof person>) => `${who?.name} (${who?.title})`;

/** The durable identity one tool call runs under; only the ids matter to these tools. */
const call = (callId: string) =>
  ({ conversationId: "conversation-1", taskId: "task-1", callId }) as never;

/** A colleague on the company record, asking from inside the office: may read any client's cases. */
const COLLEAGUE: VerifiedSender = { origin: "internal", channel: "chat", contact: "noah-kim" };
/** Megan Shaw, Little Acorns Childcare's contact on the desk, writing in by email. */
const MEGAN: VerifiedSender = {
  origin: "external",
  channel: "email",
  contact: "megan@littleacorns.example",
};
/** Grace Liu, Hawthorne Family Dental's contact on the desk, writing in by email. */
const GRACE: VerifiedSender = {
  origin: "external",
  channel: "email",
  contact: "Grace@HawthorneFamilyDental.example",
};

/** The tools, asked by `sender`; `null` is a host that knows nobody. */
const tools = (
  desk: SupportDesk | undefined,
  sender: VerifiedSender | null = COLLEAGUE,
): SupportToolset => supportTools({ desk, company, sender: async () => sender ?? undefined });

const desk = (): SupportDesk => fakeSupportDesk({ now: () => new Date(DEMO_NOW) });

function text(result: { output?: readonly unknown[] }): string {
  return (result.output ?? [])
    .map((block) => (block as { type?: string; text?: string }).text ?? "")
    .join("\n");
}

function details(result: unknown): Record<string, unknown> {
  return (result as { details?: Record<string, unknown> }).details ?? {};
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

/** A fresh credit: C-301 and C-304 already have a demonstration credit pending, so this is C-302's. */
const CREDIT = { caseId: "C-302", invoiceId: "INV-2042", line: 1 };

/** An `offer_credit` call as the approval gate hands it to the tool after a yes. */
async function approvedCall(support: SupportDesk, creditId: string) {
  const [credit] = await support.listCredits({ creditId });
  if (credit === undefined) throw new Error(`no ${creditId}`);
  return { creditId, [APPROVED_FACTS_ARG]: creditApprovalFacts(credit) };
}

const SAFETY = {
  clientId: "CL-102",
  kind: "complaint",
  category: "safety",
  summary: "An unlabelled bottle of bleach was left on a low shelf in the toddler room.",
  reportedBy: "Megan Shaw",
  source: "email from Megan Shaw, Monday 9 November",
};

/** A desk whose every write refuses with one code and a message that names no tool. */
function quiet(
  code: SupportDeskError["code"],
  extra: ConstructorParameters<typeof SupportDeskError>[2] = {},
): SupportDesk {
  const refuse = async (): Promise<never> => {
    throw new SupportDeskError(code, "Refused.", extra);
  };
  return {
    ...desk(),
    logCase: refuse,
    bookReclean: refuse,
    proposeCredit: refuse,
    issueCredit: refuse,
    withdrawCredit: refuse,
    escalateCase: refuse,
    resolveCase: refuse,
  };
}

describe("find_client", () => {
  it("finds a client with its contact, site, contract and open cases", async () => {
    const result = await tools(desk()).findClient.execute(
      { query: "Hawthorne" },
      call("a1"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain(
      "CL-101 — Hawthorne Family Dental — contact Grace Liu (grace@hawthornefamilydental.example) — 2,400 sq ft dental suite on SE Hawthorne Boulevard — contract CT-301 — 1 case open",
    );
    expect(details(result).found).toBe(true);
  });

  it("shows an external sender only their own client, an unknown sender none, a colleague all", async () => {
    const own = await tools(desk(), GRACE).findClient.execute(
      { query: "Hawthorne" },
      call("a-own"),
      BACKGROUND_CONTEXT,
    );
    expect(text(own)).toContain("CL-101 — Hawthorne Family Dental");
    const other = await tools(desk(), GRACE).findClient.execute(
      { query: "Burnside" },
      call("a-other"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(other)).toBe(true);
    expect(text(other)).not.toContain("lena@burnsideproperty.example");
    expect(details(other)).toMatchObject({ found: false, clients: [] });
    // A broad query still shows a client nobody but itself.
    const broad = await tools(desk(), GRACE).findClient.execute(
      { query: "e" },
      call("a-broad"),
      BACKGROUND_CONTEXT,
    );
    expect(text(broad)).toContain("Clients (1):");
    const nobody = await tools(desk(), null).findClient.execute(
      { query: "Hawthorne" },
      call("a-nobody"),
      BACKGROUND_CONTEXT,
    );
    expect(details(nobody)).toMatchObject({ code: "unknown_sender", clients: [] });
    expect(text(nobody)).not.toContain("grace@");
    const colleague = await tools(desk()).findClient.execute(
      { query: "e" },
      call("a-all"),
      BACKGROUND_CONTEXT,
    );
    expect(text(colleague)).toContain("Clients (5):");
  });

  it("says plainly when no client matches", async () => {
    const result = await tools(desk()).findClient.execute(
      { query: "Acme Widgets" },
      call("a2"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(details(result).found).toBe(false);
  });
});

describe("list_cases", () => {
  it("lists a client's cases with re-clean, credit and escalation, and the credit for each invoice line", async () => {
    const result = await tools(desk()).listCases.execute(
      { clientId: "CL-102" },
      call("b1"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain(
      "C-302 — Little Acorns Childcare (CL-102) — complaint, quality — open — priority high — opened 2026-11-02 by Megan Shaw",
    );
    expect(text(result)).toContain("re-clean: done on 2026-11-05 — credit: none — escalated: no");
    expect(text(result)).toContain(
      "INV-2042 line 1 — Office cleaning, one visit, up to 3,000 sq ft — 22 × visit at $185.00 = $4,070.00 — credit if a person approves: $150.00",
    );
    expect(text(result)).toContain(
      "Only if the client asks for a credit on C-302: propose_credit with caseId C-302, invoiceId INV-2042, line 1.",
    );
    expect(details(result).found).toBe(true);
  });

  it("list_cases gives an external sender only their own cases", async () => {
    // Grace names another client: the verified sender decides, not the argument.
    const result = await tools(desk(), GRACE).listCases.execute(
      { clientId: "CL-104" },
      call("b-own"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain("Cases (1):");
    expect(text(result)).toContain("C-301 — Hawthorne Family Dental");
    expect(text(result)).not.toContain("Burnside");
    // Another client's case by number reads as no case at all.
    const other = await tools(desk(), GRACE).listCases.execute(
      { caseId: "C-304" },
      call("b-other"),
      BACKGROUND_CONTEXT,
    );
    expect(details(other).found).toBe(false);
    expect(text(other)).not.toContain("Burnside");
    // The same address from inside the office is still that client, never a colleague.
    const internal = await tools(desk(), { ...GRACE, origin: "internal" }).listCases.execute(
      {},
      call("b-int"),
      BACKGROUND_CONTEXT,
    );
    expect(text(internal)).toContain("Cases (1):");
    // A colleague's address from outside is not a colleague.
    const outside = await tools(desk(), {
      origin: "external",
      channel: "email",
      contact: "noah@northwindfacilities.com",
    }).listCases.execute({}, call("b-out"), BACKGROUND_CONTEXT);
    expect(details(outside).code).toBe("unknown_sender");
  });

  it("an unknown sender gets no case data", async () => {
    for (const sender of [
      null,
      { origin: "external" as const, channel: "email", contact: "someone@example.test" },
    ]) {
      const support = tools(desk(), sender);
      const listed = await support.listCases.execute(
        { caseId: "C-301" } as never,
        call("u1"),
        BACKGROUND_CONTEXT,
      );
      expect(isError(listed)).toBe(true);
      expect(details(listed)).toMatchObject({ code: "unknown_sender", cases: [] });
      expect(text(listed)).toContain("log what they raised with log_case");
      expect(text(listed)).not.toContain("Hawthorne");
      for (const [tool, args] of [
        ["bookReclean", { caseId: "C-301", date: "2026-11-11" }],
        ["proposeCredit", CREDIT],
        ["resolveCase", { caseId: "C-302", outcome: "Done." }],
      ] as const) {
        const refused = await support[tool].execute(
          args as never,
          call(`u-${tool}`),
          BACKGROUND_CONTEXT,
        );
        expect(details(refused).code, tool).toBe("unknown_sender");
        expect(text(refused), tool).not.toContain("Hawthorne");
      }
      // A complaint still reaches a person, and the receipt says nothing about the case or who has it.
      const logged = await support.logCase.execute(SAFETY, call("u-log"), BACKGROUND_CONTEXT);
      expect(isError(logged)).toBe(false);
      const handed = await support.escalateCase.execute(
        { caseId: "C-306", reason: "safety", note: "Bleach left out." },
        call("u-esc"),
        BACKGROUND_CONTEXT,
      );
      expect(isError(handed)).toBe(false);
      expect(text(handed)).toContain("a person will look at it");
      expect(text(handed)).not.toContain(safetyOwner);
      expect(text(handed)).not.toContain("Little Acorns");
      // A refusal on someone else's case is just as generic: no category, owner or outcome.
      const closed = await support.escalateCase.execute(
        { caseId: "C-300", reason: "unresolved", note: "Still unhappy." },
        call("u-closed"),
        BACKGROUND_CONTEXT,
      );
      expect(isError(closed)).toBe(true);
      expect(details(closed).code).toBe("unknown_sender");
      expect(text(closed)).toContain("a person will look at it");
      expect(text(closed)).not.toMatch(/closed|kitchen|Gateway|Ravi/);
    }
  });

  it("withdraw_credit answers a proposal out of reach exactly like one that does not exist", async () => {
    const support = desk();
    for (const sender of [GRACE, null]) {
      const toolset = tools(support, sender);
      const missing = await toolset.withdrawCredit.execute(
        { creditId: "CR-999", reason: "Not wanted." },
        call("w-missing"),
        BACKGROUND_CONTEXT,
      );
      const other = await toolset.withdrawCredit.execute(
        { creditId: "CR-400", reason: "Not wanted." },
        call("w-other"),
        BACKGROUND_CONTEXT,
      );
      // No case id, client or state: word for word the unknown-id text, with only the id changed.
      expect(text(other)).toBe(text(missing).replace("CR-999", "CR-400"));
      expect(text(other)).not.toMatch(/C-304|Burnside/);
      expect(details(other).code).toBe(details(missing).code);
    }
    expect((await support.listCredits({ creditId: "CR-400" }))[0]?.status).toBe("pending");
  });

  it("gives an unknown sender the generic escalation text even when the note names the owner", async () => {
    const owner = person(company, refunds.refundNeeds);
    const result = await tools(desk(), null).escalateCase.execute(
      { caseId: "C-301", reason: "refund", note: `For ${owner?.name} to decide.` },
      call("u-note"),
      BACKGROUND_CONTEXT,
    );
    expect(details(result).code).toBe("unknown_sender");
    expect(text(result)).toContain("a person will look at it");
    expect(text(result)).not.toContain(owner?.name ?? "?");
  });

  it("an internal ticket carrying a client's email counts as that client, never a colleague", async () => {
    // Office trials put a client's address on an internal ticket: it narrows to that client only.
    const internalGrace = tools(desk(), { ...GRACE, origin: "internal" });
    const own = await internalGrace.listCases.execute({}, call("m6-own"), BACKGROUND_CONTEXT);
    expect(text(own)).toContain("Cases (1):");
    const other = await internalGrace.listCases.execute(
      { clientId: "CL-104" },
      call("m6-other"),
      BACKGROUND_CONTEXT,
    );
    expect(text(other)).not.toContain("Burnside");
    const write = await internalGrace.resolveCase.execute(
      { caseId: "C-302", outcome: "Done." },
      call("m6-write"),
      BACKGROUND_CONTEXT,
    );
    expect(details(write).code).toBe("not_found");
  });

  it("a client may act only on its own cases", async () => {
    const support = desk();
    const grace = tools(support, GRACE);
    for (const [tool, args] of [
      ["bookReclean", { caseId: "C-305", date: "2026-11-11" }],
      ["proposeCredit", { caseId: "C-304", invoiceId: "INV-2044", line: 2 }],
      ["escalateCase", { caseId: "C-304", reason: "unresolved", note: "x" }],
      ["resolveCase", { caseId: "C-302", outcome: "Done." }],
    ] as const) {
      const refused = await grace[tool].execute(
        args as never,
        call(`own-${tool}`),
        BACKGROUND_CONTEXT,
      );
      expect(details(refused).code, tool).toBe("not_found");
      expect(text(refused), tool).toContain("is on Hawthorne Family Dental's account");
    }
    expect((await support.listCredits({ creditId: "CR-400" }))[0]?.status).toBe("pending");
    const own = await tools(support, MEGAN).proposeCredit.execute(
      CREDIT,
      call("own-credit"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(own)).toBe(false);
  });

  it("shows a credit waiting for a person and a re-clean not yet done, and offers no second credit", async () => {
    const result = await tools(desk()).listCases.execute(
      { status: "open" },
      call("b2"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain(
      `credit: CR-400, $150.00 on INV-2044 line 1, proposed and put to ${creditOwner}; not issued. If an approval in this conversation returned a decision, say that decision; otherwise say ${creditOwner} has it. Do not call propose_credit or offer_credit for this case.`,
    );
    expect(text(result)).toContain("re-clean: booked for 2026-11-10, not done yet");
    expect(text(result)).not.toContain("propose_credit with caseId C-304");
  });

  it("lists every case with no filter, and refuses a case that does not exist", async () => {
    const all = await tools(desk()).listCases.execute({}, call("b3"), BACKGROUND_CONTEXT);
    expect(text(all)).toContain("Cases (6)");
    const missing = await tools(desk()).listCases.execute(
      { caseId: "C-42" },
      call("b4"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(missing)).toBe(true);
    expect(details(missing).found).toBe(false);
  });
});

describe("log_case", () => {
  it("logs a case once on replay, and points a safety complaint at escalate_case from its category", async () => {
    const support = desk();
    const first = await tools(support).logCase.execute(SAFETY, call("same"), BACKGROUND_CONTEXT);
    const again = await tools(support).logCase.execute(SAFETY, call("same"), BACKGROUND_CONTEXT);
    expect(text(again)).toBe(text(first));
    expect(text(first)).toContain(
      "Logged C-306 for Little Acorns Childcare: complaint, safety, priority urgent",
    );
    expect(text(first)).toContain(
      `Next: a safety complaint goes to a person now: call escalate_case with caseId C-306 and reason safety, which hands it to ${safetyOwner}.`,
    );
    expect(details(first)).toMatchObject({ id: "C-306", category: "safety" });
    expect(await support.listCases({ clientId: "CL-102" })).toHaveLength(2);
  });

  it("treats a different call as a different write: the replay key is the durable call identity", async () => {
    const support = desk();
    await tools(support).logCase.execute(SAFETY, call("one"), BACKGROUND_CONTEXT);
    const second = await tools(support).logCase.execute(SAFETY, call("two"), BACKGROUND_CONTEXT);
    expect(text(second)).toContain("Logged C-307");
    const other = { conversationId: "conversation-2", taskId: "task-1", callId: "one" } as never;
    const third = await tools(support).logCase.execute(SAFETY, other, BACKGROUND_CONTEXT);
    expect(text(third)).toContain("Logged C-308");
  });

  it("points a staff complaint at escalate_case with reason staff and about, from its category", async () => {
    const result = await tools(desk()).logCase.execute(
      { ...SAFETY, category: "staff", summary: "Rude on the phone." },
      call("c-staff"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain(
      "Next: a complaint about a member of staff goes to a person: call escalate_case with caseId C-306, reason staff and about naming who it is about; the desk keeps it away from them.",
    );
  });

  it("gives no escalation step for a question", async () => {
    const result = await tools(desk()).logCase.execute(
      { ...SAFETY, kind: "question", category: "other", summary: "Do you clean on holidays?" },
      call("c2"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain("Logged C-306");
    expect(text(result)).not.toContain("escalate_case");
  });

  it("logs an external client's case on its own account, whatever client the call names", async () => {
    const support = desk();
    const result = await tools(support, GRACE).logCase.execute(
      { ...SAFETY, clientId: "CL-104" },
      call("c-own"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain("Logged C-306 for Hawthorne Family Dental");
    expect(text(result)).not.toContain("Burnside");
    expect((await support.listCases({ caseId: "C-306" }))[0]?.clientId).toBe("CL-101");
  });

  it("refuses an unknown client", async () => {
    const result = await tools(desk()).logCase.execute(
      { ...SAFETY, clientId: "CL-999" },
      call("c3"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(details(result).code).toBe("not_found");
  });
});

describe("book_reclean", () => {
  it("books a re-clean once on replay, with the weekday", async () => {
    const support = desk();
    const args = { caseId: "C-301", date: "2026-11-11" };
    const first = await tools(support).bookReclean.execute(args, call("same"), BACKGROUND_CONTEXT);
    const again = await tools(support).bookReclean.execute(args, call("same"), BACKGROUND_CONTEXT);
    expect(text(again)).toBe(text(first));
    expect(text(first)).toContain(
      "Booked a re-clean for C-301 (Hawthorne Family Dental) on Wednesday 2026-11-11",
    );
    expect(text(first)).toContain("no charge");
    expect((await support.listCases({ caseId: "C-301" }))[0]?.reclean?.date).toBe("2026-11-11");
  });

  it("refuses a date outside the window and points to the complaint owner", async () => {
    const result = await tools(desk()).bookReclean.execute(
      { caseId: "C-301", date: "2026-11-20" },
      call("d2"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(details(result).code).toBe("outside_window");
    expect(text(result)).toContain(
      `Next: offer a date inside the window, or call escalate_case with reason unresolved, which hands it to ${complaintOwner}.`,
    );
  });

  it("refuses a case a re-clean does not put right, naming the other remedies", async () => {
    const result = await tools(desk()).bookReclean.execute(
      { caseId: "C-304", date: "2026-11-11" },
      call("d3"),
      BACKGROUND_CONTEXT,
    );
    expect(details(result).code).toBe("not_reclean");
    expect(text(result)).toContain("only if the client asks for a credit, propose_credit");
    expect(text(result)).toContain("escalate_case");
  });
});

describe("propose_credit", () => {
  it("a replayed propose_credit records one proposal", async () => {
    const support = desk();
    const first = await tools(support).proposeCredit.execute(
      CREDIT,
      call("same"),
      BACKGROUND_CONTEXT,
    );
    const again = await tools(support).proposeCredit.execute(
      CREDIT,
      call("same"),
      BACKGROUND_CONTEXT,
    );
    expect(text(again)).toBe(text(first));
    expect(text(first)).toContain(
      "Proposed credit CR-402: $150.00 to Little Acorns Childcare on INV-2042 line 1 (Office cleaning, one visit, up to 3,000 sq ft), case C-302, worked out by the desk. Nothing is issued: a person decides it.",
    );
    expect(text(first)).toContain(
      `Next: call offer_credit with creditId CR-402, which asks ${creditOwner}. If they decline, record it with withdraw_credit for CR-402, reason declined.`,
    );
    expect(details(first)).toMatchObject({ id: "CR-402", status: "pending", creditCents: 15000 });
    expect(await support.listCredits({ caseId: "C-302" })).toHaveLength(1);
  });

  it("refuses a second credit for the same line, naming the proposal", async () => {
    const support = desk();
    await tools(support).proposeCredit.execute(CREDIT, call("p1"), BACKGROUND_CONTEXT);
    const second = await tools(support).proposeCredit.execute(
      CREDIT,
      call("p2"),
      BACKGROUND_CONTEXT,
    );
    expect(details(second)).toMatchObject({ code: "duplicate_credit", creditId: "CR-402" });
    expect(text(second)).toContain("CR-402 is that credit");
    const waiting = await tools(support).proposeCredit.execute(
      { caseId: "C-304", invoiceId: "INV-2044", line: 2 },
      call("p3"),
      BACKGROUND_CONTEXT,
    );
    expect(details(waiting).code).toBe("credit_pending");
    expect(text(waiting)).toContain(`CR-400 on C-304 is proposed and not issued`);
    expect(text(waiting)).toContain(`otherwise tell the client ${creditOwner} has it`);
  });
});

describe("offer_credit", () => {
  it("offer_credit takes only creditId and shows desk-read facts", async () => {
    const support = desk();
    const toolset = tools(support);
    const schema = toolset.offerCredit.parameters as unknown as {
      properties: Record<string, { description?: string }>;
      required?: string[];
    };
    expect(Object.keys(schema.properties).filter((key) => key !== APPROVED_FACTS_ARG)).toEqual([
      "creditId",
    ]);
    expect(schema.required).toEqual(["creditId"]);
    await toolset.proposeCredit.execute(CREDIT, call("p"), BACKGROUND_CONTEXT);
    const read = await toolset.creditFacts(
      { creditId: "CR-402" },
      BACKGROUND_CONTEXT as never,
      call("cf"),
    );
    expect(read.summary).toBe(
      "Issue credit CR-402: $150.00 to Little Acorns Childcare on INV-2042 line 1 (Office cleaning, one visit, up to 3,000 sq ft), case C-302, worked out by the desk",
    );
    const [credit] = await support.listCredits({ creditId: "CR-402" });
    expect(read.facts).toEqual(creditApprovalFacts(credit as never));
    // Nothing to approve: a proposal that does not exist, is issued or was withdrawn.
    await expect(
      toolset.creditFacts({ creditId: "CR-9" }, BACKGROUND_CONTEXT as never, call("cf")),
    ).rejects.toThrow("Nothing was put to a person");
    await support.withdrawCredit({ creditId: "CR-400", reason: "Declined." }, { requestId: "w" });
    await expect(
      toolset.creditFacts({ creditId: "CR-400" }, BACKGROUND_CONTEXT as never, call("cf")),
    ).rejects.toThrow("was withdrawn");
  });

  it("never puts another client's proposal to a person, answering as if it did not exist", async () => {
    const support = desk();
    const unknownId = async (sender: VerifiedSender | null) =>
      tools(support, sender)
        .creditFacts({ creditId: "CR-999" }, BACKGROUND_CONTEXT as never, call("f0"))
        .catch((error: Error) => error.message);
    for (const sender of [GRACE, null]) {
      const message = await tools(support, sender)
        .creditFacts({ creditId: "CR-400" }, BACKGROUND_CONTEXT as never, call("f1"))
        .catch((error: Error) => error.message);
      // Word for word what an id nobody has gets, with only the id changed: no client, no state.
      expect(message).toBe((await unknownId(sender)).replace("CR-999", "CR-400"));
      expect(message).not.toContain("Burnside");
    }
    // Grace's own proposal reads as usual.
    const own = await tools(support, GRACE).creditFacts(
      { creditId: "CR-401" },
      BACKGROUND_CONTEXT as never,
      call("f2"),
    );
    expect(own.summary).toContain("Hawthorne Family Dental");
  });

  it("checks the sender again before issuing, even with approved facts", async () => {
    const support = desk();
    const args = await approvedCall(support, "CR-400");
    for (const sender of [GRACE, null]) {
      const result = await tools(support, sender).offerCredit.execute(
        args,
        call("f3"),
        BACKGROUND_CONTEXT,
      );
      expect(details(result).code).toBe("not_found");
      expect(text(result)).toContain('No credit proposal has the id "CR-400"');
      expect(text(result)).not.toContain("Burnside");
    }
    expect((await support.listCredits({ creditId: "CR-400" }))[0]?.status).toBe("pending");
  });

  it("issues the approved proposal once on replay, saying it was approved", async () => {
    const support = desk();
    await tools(support).proposeCredit.execute(CREDIT, call("p"), BACKGROUND_CONTEXT);
    const args = await approvedCall(support, "CR-402");
    const first = await tools(support).offerCredit.execute(args, call("same"), BACKGROUND_CONTEXT);
    const again = await tools(support).offerCredit.execute(args, call("same"), BACKGROUND_CONTEXT);
    expect(text(again)).toBe(text(first));
    expect(isError(first)).toBe(false);
    expect(text(first)).toContain(
      "Approved and issued: credit note CN-501 for $150.00 on INV-2042 line 1 (Office cleaning, one visit, up to 3,000 sq ft), Little Acorns Childcare, case C-302.",
    );
    expect(text(first)).toContain("It is a credit on the invoice, not money back.");
    expect((await support.listCases({ caseId: "C-302" }))[0]?.credit?.status).toBe("issued");
  });

  it("issues nothing without facts a person approved", async () => {
    const support = desk();
    const result = await tools(support).offerCredit.execute(
      { creditId: "CR-400" },
      call("e1"),
      BACKGROUND_CONTEXT,
    );
    expect(details(result).code).toBe("not_approved");
    expect((await support.listCredits({ creditId: "CR-400" }))[0]?.status).toBe("pending");
  });

  it("refuses when the proposal changed after the facts were read", async () => {
    const support = desk();
    const args = await approvedCall(support, "CR-400");
    await support.withdrawCredit({ creditId: "CR-400", reason: "Declined." }, { requestId: "w" });
    const result = await tools(support).offerCredit.execute(args, call("e2"), BACKGROUND_CONTEXT);
    expect(details(result)).toMatchObject({ code: "credit_changed", creditId: "CR-400" });
    expect(text(result)).toContain("changed after its facts were read");
    expect(text(result)).toContain("Next: tell the client the credit was not issued");
  });
});

describe("withdraw_credit", () => {
  it("a withdrawn proposal lets the case resolve", async () => {
    const support = desk();
    const toolset = tools(support);
    const blocked = await toolset.resolveCase.execute(
      { caseId: "C-304", outcome: "Declined." },
      call("r1"),
      BACKGROUND_CONTEXT,
    );
    expect(details(blocked).code).toBe("credit_pending");
    const args = { creditId: "CR-400", reason: "The person who approves credits declined it." };
    const first = await toolset.withdrawCredit.execute(args, call("same"), BACKGROUND_CONTEXT);
    const again = await toolset.withdrawCredit.execute(args, call("same"), BACKGROUND_CONTEXT);
    expect(text(again)).toBe(text(first));
    expect(text(first)).toContain(
      "Withdrew credit CR-400: $150.00 to Burnside Property Group on INV-2044 line 1",
    );
    expect(text(first)).toContain("nothing has been sent to the client");
    const closed = await toolset.resolveCase.execute(
      { caseId: "C-304", outcome: "Credit declined; the client was told." },
      call("r2"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(closed)).toBe(false);
  });
});

describe("escalate_case", () => {
  it("hands a refund to the person who decides money back, once on replay, promising nothing", async () => {
    const support = desk();
    const args = { caseId: "C-301", reason: "refund", note: "Wants October back." };
    const first = await tools(support).escalateCase.execute(args, call("same"), BACKGROUND_CONTEXT);
    const again = await tools(support).escalateCase.execute(args, call("same"), BACKGROUND_CONTEXT);
    expect(text(again)).toBe(text(first));
    expect(text(first)).toContain(
      `Handed C-301 (Hawthorne Family Dental) to ${refundOwner}, for refund.`,
    );
    expect(text(first)).toContain(
      `Tell the client plainly that ${named(person(company, refunds.refundNeeds))} will decide; promise no money.`,
    );
    expect(text(first)).toContain("nothing has been sent to the client");
    expect((await support.listCases({ caseId: "C-301" }))[0]?.escalations).toHaveLength(1);
  });

  it("says when a complaint about someone went to another person", async () => {
    const owner = person(company, refunds.complaintOwner);
    const head = personLabel(companyHead(company));
    const headNamed = named(companyHead(company));
    const result = await tools(desk()).escalateCase.execute(
      { caseId: "C-303", reason: "staff", note: "Rude on the phone.", about: owner?.name },
      call("f2"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain(`to ${head}, for staff`);
    expect(text(result)).toContain(
      `The case names the person it would normally go to, so it went to ${headNamed} instead: never say it is with anyone it names.`,
    );
    expect(details(result)).toMatchObject({ redirected: true });
  });

  it("gives a safety escalation's owner", async () => {
    const result = await tools(desk()).escalateCase.execute(
      { caseId: "C-301", reason: "safety", note: "Chemical left out." },
      call("f3"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain(`to ${safetyOwner}, for safety`);
  });
});

describe("resolve_case", () => {
  it("closes a case with its outcome once on replay", async () => {
    const support = desk();
    const args = { caseId: "C-302", outcome: "Re-clean done; the director confirmed the carpet." };
    const first = await tools(support).resolveCase.execute(args, call("same"), BACKGROUND_CONTEXT);
    const again = await tools(support).resolveCase.execute(args, call("same"), BACKGROUND_CONTEXT);
    expect(text(again)).toBe(text(first));
    expect(text(first)).toContain("Closed C-302 (Little Acorns Childcare) on 2026-11-09. Outcome:");
    expect((await support.listCases({ caseId: "C-302" }))[0]?.status).toBe("closed");
  });

  it("resolve_case refuses while a credit proposal is pending", async () => {
    const waiting = await tools(desk()).resolveCase.execute(
      { caseId: "C-304", outcome: "Done." },
      call("g2"),
      BACKGROUND_CONTEXT,
    );
    expect(details(waiting)).toMatchObject({ code: "credit_pending", creditId: "CR-400" });
    expect(text(waiting)).toContain(creditOwner);
    const pending = await tools(desk()).resolveCase.execute(
      { caseId: "C-305", outcome: "Done." },
      call("g3"),
      BACKGROUND_CONTEXT,
    );
    expect(details(pending).code).toBe("reclean_pending");
    expect(text(pending)).toContain("Next: leave it open until the re-clean is done");
  });

  it("points an unescalated safety case at escalate_case", async () => {
    const support = desk();
    const logged = await support.logCase(
      { ...SAFETY, kind: "complaint", category: "safety" },
      { requestId: "log" },
    );
    const result = await tools(support).resolveCase.execute(
      { caseId: logged.id, outcome: "Spoke to the crew." },
      call("g4"),
      BACKGROUND_CONTEXT,
    );
    expect(details(result).code).toBe("not_escalated");
    expect(text(result)).toContain(
      `Next: call escalate_case with caseId ${logged.id} and reason safety, which hands it to ${safetyOwner}.`,
    );
  });
});

describe("next steps come from the refusal's code, not its wording", () => {
  it("names the step for each code even when the desk's message names no tool", async () => {
    const cases: [
      SupportDeskError["code"],
      keyof SupportToolset,
      Record<string, unknown>,
      string,
    ][] = [
      [
        "not_escalated",
        "resolveCase",
        { caseId: "C-9", outcome: "x" },
        "escalate_case with caseId C-9 and reason safety",
      ],
      ["credit_pending", "resolveCase", { caseId: "C-9", outcome: "x" }, creditOwner],
      [
        "note_names_owner",
        "escalateCase",
        { caseId: "C-9", reason: "refund", note: "x" },
        "call escalate_case again with them in about",
      ],
      [
        "duplicate_credit",
        "proposeCredit",
        { caseId: "C-9", invoiceId: "INV-9", line: 1 },
        "CR-9 is that credit",
      ],
      [
        "reclean_pending",
        "resolveCase",
        { caseId: "C-9", outcome: "x" },
        "until the re-clean is done",
      ],
      [
        "no_one",
        "escalateCase",
        { caseId: "C-9", reason: "staff", note: "x", about: "everyone" },
        "nobody has it yet, and that they can raise it directly with a manager they trust",
      ],
      [
        "outside_window",
        "bookReclean",
        { caseId: "C-9", date: "2026-11-11" },
        "escalate_case with reason unresolved",
      ],
      [
        "not_reclean",
        "bookReclean",
        { caseId: "C-9", date: "2026-11-11" },
        "only if the client asks for a credit",
      ],
    ];
    for (const [code, tool, args, step] of cases) {
      const result = await tools(quiet(code, { caseId: "C-9", creditId: "CR-9" }))[tool].execute(
        args as never,
        call(`q-${code}`),
        BACKGROUND_CONTEXT,
      );
      expect(text(result), code).toContain(step);
      expect(details(result).code).toBe(code);
    }
    const changed = await tools(quiet("credit_changed", { creditId: "CR-9" })).offerCredit.execute(
      { creditId: "CR-400", [APPROVED_FACTS_ARG]: { id: "CR-400" } },
      call("q-changed"),
      BACKGROUND_CONTEXT,
    );
    expect(text(changed)).toContain("Read the case again with list_cases");
  });
});

describe("read_company", () => {
  it("reads who decides complaints, credits and money back, the re-clean window and the usual credit", async () => {
    const result = await tools(desk()).readCompany.execute(
      { section: "support" },
      call("h1"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain(complaintOwner);
    expect(text(result)).toContain(creditOwner);
    expect(text(result)).toContain(refundOwner);
    expect(text(result)).toContain(`${refunds.recleanWindowDays} business days`);
    expect(text(result)).toContain(money(refunds.serviceRecoveryCreditCents));
  });

  it("reads the people and who decides what", async () => {
    const result = await tools(desk()).readCompany.execute(
      { section: "people" },
      call("h2"),
      BACKGROUND_CONTEXT,
    );
    for (const worker of company.people) expect(text(result)).toContain(worker.name);
  });
});

describe("with no desk", () => {
  it("refuses at the point of use", async () => {
    await expect(
      tools(undefined).listCases.execute({}, call("i1"), BACKGROUND_CONTEXT),
    ).rejects.toThrow("No support desk is configured");
  });
});
