/**
 * The demonstration IT desk: who may see and change what, the priority it sets in code, the access,
 * sign-in, joiner and leaver rules it holds, the asset register, and replay of every write.
 */

import type { VerifiedSender } from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import { loadCompanyFacts } from "./company.js";
import {
  DEMO_NOW,
  fakeItDesk,
  type ItDesk,
  ItDeskError,
  priorityFor,
  type ResetReceipt,
} from "./desk.js";

const company = loadCompanyFacts();
const desk = (): ItDesk => fakeItDesk({ company, now: () => new Date(DEMO_NOW) });
const staff = (id: string): VerifiedSender => ({
  origin: "internal",
  channel: "chat",
  contact: id,
});

/** An ordinary member of staff with no administrator rights. */
const NOAH = staff("noah-kim");
/** The person who decides IT, who holds administrator rights. */
const DANA = staff("dana-whitfield");
const PRIYA = staff("priya-raman");
/** A colleague's own address, but from outside the office: not proof of who typed it. */
const NOAH_OUTSIDE: VerifiedSender = {
  origin: "external",
  channel: "email",
  contact: "noah@northwindfacilities.example",
};
const STRANGER: VerifiedSender = {
  origin: "external",
  channel: "email",
  contact: "someone@example.test",
};

async function refusalCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ItDeskError) return error.code;
    throw error;
  }
  throw new Error("expected the desk to refuse");
}

async function refusal(promise: Promise<unknown>): Promise<ItDeskError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ItDeskError) return error;
    throw error;
  }
  throw new Error("expected the desk to refuse");
}

const req = (id: string) => ({ requestId: id });

describe("priority", () => {
  it("is set from the impact, and a security ticket is never below high", () => {
    expect(priorityFor("printing", "one_person_can_work")).toBe("low");
    expect(priorityFor("software", "one_person_blocked")).toBe("medium");
    expect(priorityFor("email", "several_people")).toBe("high");
    expect(priorityFor("network", "everyone")).toBe("urgent");
    expect(priorityFor("security", "one_person_can_work")).toBe("high");
    expect(priorityFor("security", "everyone")).toBe("urgent");
  });
});

describe("who the desk answers", () => {
  it("refuses an unknown sender, an outside sender and a stranger on every staff tool", async () => {
    const it = desk();
    for (const from of [undefined, NOAH_OUTSIDE, STRANGER]) {
      const code = from === undefined ? "unknown_sender" : "not_staff";
      expect(await refusalCode(it.myAccess({ from }))).toBe(code);
      expect(
        await refusalCode(it.passwordReset({ from, systemId: "email" }, req(`r-${code}`))),
      ).toBe(code);
      expect(await refusalCode(it.listTickets({ from }))).toBe(code);
      expect(await refusalCode(it.listAssets({ from }))).toBe(code);
      expect(
        await refusalCode(
          it.logTicket(
            { from, category: "other", impact: "one_person_can_work", description: "x" },
            req(`l-${code}`),
          ),
        ),
      ).toBe(code);
      expect(
        await refusalCode(
          it.accessFacts({ from, person: "Noah Kim", groupId: "shared-files", reason: "x" }),
        ),
      ).toBe(code);
    }
  });

  it("gives the sender their own account and groups, and nobody else's", async () => {
    const it = desk();
    const own = await it.myAccess({ from: NOAH });
    expect(own.name).toBe("Noah Kim");
    expect(own.status).toBe("active");
    expect(own.groups.map((group) => group.id)).toContain("staff-email");
    expect(own.groups.some((group) => group.privileged)).toBe(false);
    // Naming themselves is themselves.
    expect((await it.myAccess({ from: NOAH, person: "Noah" })).name).toBe("Noah Kim");
    expect((await it.myAccess({ from: NOAH, person: "noah kim" })).name).toBe("Noah Kim");
    // Anyone else is refused, whether or not they exist, and even for the person who decides IT.
    expect(await refusalCode(it.myAccess({ from: NOAH, person: "Priya Raman" }))).toBe(
      "someone_else",
    );
    expect(await refusalCode(it.myAccess({ from: NOAH, person: "Nobody Atall" }))).toBe(
      "someone_else",
    );
    expect(await refusalCode(it.myAccess({ from: DANA, person: "Noah Kim" }))).toBe("someone_else");
  });
});

describe("password reset", () => {
  it("sends a link to the address on file and a notice to the holder, and shows nothing secret", async () => {
    const it = desk();
    const receipt = await it.passwordReset({ from: NOAH, systemId: "email" }, req("reset-1"));
    expect(receipt).toMatchObject({
      id: "RST-1",
      name: "Noah Kim",
      systemName: "Email and calendar",
      noticeTo: "Noah Kim",
      on: "2026-11-09",
    });
    // The receipt never carries the address, a password, a link or a code.
    const text = JSON.stringify(receipt);
    expect(text).not.toContain("@");
    expect(text).not.toMatch(/password\s*[:=]|code\s*[:=]|https?:/i);
  });

  it("is replayed by its request id and never sends twice", async () => {
    const it = desk();
    const first = await it.passwordReset({ from: NOAH, systemId: "email" }, req("reset-1"));
    const again = await it.passwordReset({ from: NOAH, systemId: "email" }, req("reset-1"));
    expect(again).toEqual(first);
    const second: ResetReceipt = await it.passwordReset(
      { from: NOAH, systemId: "email" },
      req("reset-2"),
    );
    expect(second.id).toBe("RST-2");
    expect((await it.resetsSent()).length).toBe(2);
  });

  it("refuses someone else's account, an account with administrator rights, and a system the sender has no access to", async () => {
    const it = desk();
    const other = await refusal(
      it.passwordReset({ from: NOAH, person: "Priya Raman", systemId: "email" }, req("a")),
    );
    expect(other.code).toBe("someone_else");
    expect(other.message).toContain("Nothing was sent");

    const privileged = await refusal(it.passwordReset({ from: DANA, systemId: "email" }, req("b")));
    expect(privileged.code).toBe("privileged");
    expect(privileged.message).toContain("Dana Whitfield, Managing Director");

    expect(await refusalCode(it.passwordReset({ from: NOAH, systemId: "payroll" }, req("c")))).toBe(
      "no_access",
    );
    expect(await refusalCode(it.passwordReset({ from: NOAH, systemId: "nowhere" }, req("d")))).toBe(
      "not_found",
    );
    expect((await it.resetsSent()).length).toBe(0);
  });
});

describe("sign-in method change", () => {
  it("reads the sender's own account for the person deciding, and refuses someone else's", async () => {
    const it = desk();
    const facts = await it.signInChangeFacts({ from: NOAH, reason: "New phone" });
    expect(facts).toEqual({ personId: "noah-kim", name: "Noah Kim", reason: "New phone" });
    expect(
      await refusalCode(
        it.signInChangeFacts({ from: NOAH, person: "Priya Raman", reason: "Her new phone" }),
      ),
    ).toBe("someone_else");
    expect(await refusalCode(it.signInChangeFacts({ from: undefined, reason: "x" }))).toBe(
      "unknown_sender",
    );
  });

  it("records the change only with the facts a person approved", async () => {
    const it = desk();
    const facts = await it.signInChangeFacts({ from: NOAH, reason: "New phone" });
    const done = await it.changeSignInMethod(
      { from: NOAH, reason: "New phone", approved: facts },
      req("s1"),
    );
    expect(done).toMatchObject({ id: "SIG-1", name: "Noah Kim", reason: "New phone" });
    expect(
      await refusalCode(
        it.changeSignInMethod(
          { from: NOAH, reason: "New phone", approved: { ...facts, personId: "priya-raman" } },
          req("s2"),
        ),
      ),
    ).toBe("changed");
  });
});

describe("access requests", () => {
  it("names the group, its system and owner for the person deciding", async () => {
    const it = desk();
    expect(
      await it.accessFacts({
        from: PRIYA,
        person: "Noah Kim",
        groupId: "accounting-billing",
        reason: "Covering invoices",
      }),
    ).toEqual({
      personId: "noah-kim",
      name: "Noah Kim",
      groupId: "accounting-billing",
      groupName: "Accounting, billing",
      systemName: "Accounting",
      owner: "Eileen Hart, Finance and Billing",
      reason: "Covering invoices",
    });
  });

  it("refuses a group with administrator rights outright and names who decides", async () => {
    const it = desk();
    const refused = await refusal(
      it.accessFacts({
        from: PRIYA,
        person: "Priya Raman",
        groupId: "email-admins",
        reason: "To fix things myself",
      }),
    );
    expect(refused.code).toBe("privileged");
    expect(refused.message).toContain("Dana Whitfield, Managing Director");
    expect(refused.message).toContain("Nothing was put to a person");
  });

  it("refuses an unknown group or person, a member already in it, and a disabled account", async () => {
    const it = desk();
    const base = { from: PRIYA, reason: "x" };
    expect(
      await refusalCode(it.accessFacts({ ...base, person: "Noah Kim", groupId: "nope" })),
    ).toBe("not_found");
    expect(
      await refusalCode(
        it.accessFacts({ ...base, person: "Nobody Atall", groupId: "shared-files" }),
      ),
    ).toBe("not_found");
    expect(
      await refusalCode(it.accessFacts({ ...base, person: "Noah Kim", groupId: "staff-email" })),
    ).toBe("already_member");
    const facts = await it.disableFacts({ from: PRIYA, person: "Noah Kim", reason: "Leaving" });
    await it.disableAccount(
      { from: PRIYA, person: "Noah Kim", reason: "Leaving", approved: facts },
      req("d"),
    );
    expect(
      await refusalCode(
        it.accessFacts({ ...base, person: "Noah Kim", groupId: "accounting-billing" }),
      ),
    ).toBe("disabled");
  });

  it("grants exactly what was approved, once, and refuses facts that changed", async () => {
    const it = desk();
    const input = {
      from: PRIYA,
      person: "Noah Kim",
      groupId: "accounting-billing",
      reason: "Covering invoices",
    };
    const facts = await it.accessFacts(input);
    const grant = await it.grantAccess({ ...input, approved: facts }, req("g1"));
    expect(grant).toMatchObject({
      id: "ACC-1",
      name: "Noah Kim",
      groupName: "Accounting, billing",
    });
    expect(await it.grantAccess({ ...input, approved: facts }, req("g1"))).toEqual(grant);
    expect((await it.myAccess({ from: NOAH })).groups.map((group) => group.id)).toContain(
      "accounting-billing",
    );
    expect(
      await refusalCode(
        it.grantAccess({ ...input, groupId: "scheduling-field", approved: facts }, req("g2")),
      ),
    ).toBe("changed");
  });
});

describe("joiners and leavers", () => {
  it("sets up a joiner's account with the standard staff groups once approved, and refuses a name already in use", async () => {
    const it = desk();
    const input = {
      from: PRIYA,
      name: "Lena Brooks",
      job: "Office assistant",
      startDate: "2026-11-16",
    };
    const facts = await it.setupFacts(input);
    expect(facts).toMatchObject({
      name: "Lena Brooks",
      job: "Office assistant",
      startDate: "2026-11-16",
    });
    const account = await it.setupAccount({ ...input, approved: facts }, req("j1"));
    expect(account.name).toBe("Lena Brooks");
    expect(account.mfaEnrolled).toBe(false);
    expect(account.groups.every((group) => !group.privileged)).toBe(true);
    expect(account.groups.map((group) => group.id).sort()).toEqual(["shared-files", "staff-email"]);
    expect(await it.setupAccount({ ...input, approved: facts }, req("j1"))).toEqual(account);
    expect(await refusalCode(it.setupFacts(input))).toBe("exists");
    expect(await refusalCode(it.setupFacts({ ...input, name: "Noah Kim" }))).toBe("exists");
    expect(await refusalCode(it.setupFacts({ ...input, name: "Mo Diaz", startDate: "soon" }))).toBe(
      "invalid",
    );
  });

  it("disables a leaver once approved, lists the equipment to collect, and refuses a second disable", async () => {
    const it = desk();
    const input = { from: PRIYA, person: "Noah Kim", reason: "Last day Friday 13 November" };
    const facts = await it.disableFacts(input);
    expect(facts).toMatchObject({ personId: "noah-kim", name: "Noah Kim" });
    const done = await it.disableAccount({ ...input, approved: facts }, req("x1"));
    expect(done.account.status).toBe("disabled");
    expect(done.assetsToCollect.map((asset) => asset.tag)).toEqual(["LT-203"]);
    expect(await it.disableAccount({ ...input, approved: facts }, req("x1"))).toEqual(done);
    expect(await refusalCode(it.disableFacts(input))).toBe("already_disabled");
    // A disabled account signs in to nothing, so no reset goes to it.
    expect(await refusalCode(it.passwordReset({ from: NOAH, systemId: "email" }, req("r")))).toBe(
      "disabled",
    );
  });
});

describe("tickets", () => {
  it("logs a ticket for the sender with the desk's priority", async () => {
    const it = desk();
    const ticket = await it.logTicket(
      {
        from: NOAH,
        category: "printing",
        impact: "several_people",
        description: "Front office printer offline",
      },
      req("t1"),
    );
    expect(ticket).toMatchObject({
      id: "T-1004",
      reporterName: "Noah Kim",
      priority: "high",
      status: "open",
      openedOn: "2026-11-09",
    });
    expect(
      await it.logTicket(
        { from: NOAH, category: "printing", impact: "several_people", description: "again" },
        req("t1"),
      ),
    ).toEqual(ticket);
    expect(
      await refusalCode(
        it.logTicket(
          { from: NOAH, category: "printing", impact: "several_people", description: " " },
          req("t2"),
        ),
      ),
    ).toBe("invalid");
  });

  it("escalates to the system's owner, or to the person who decides IT, with notes", async () => {
    const it = desk();
    const toOwner = await it.escalateTicket(
      { from: NOAH, ticketId: "T-1002", systemId: "accounting", notes: "Reinstall did not help" },
      req("e1"),
    );
    expect(toOwner.status).toBe("escalated");
    expect(toOwner.escalatedTo).toEqual({ name: "Eileen Hart", title: "Finance and Billing" });
    const toApprover = await it.escalateTicket(
      { from: NOAH, ticketId: "T-1001", notes: "Needs a technician" },
      req("e2"),
    );
    expect(toApprover.escalatedTo).toEqual({ name: "Dana Whitfield", title: "Managing Director" });
    expect(
      await refusalCode(it.escalateTicket({ from: NOAH, ticketId: "T-9", notes: "x" }, req("e3"))),
    ).toBe("not_found");
    expect(
      await refusalCode(
        it.escalateTicket({ from: NOAH, ticketId: "T-1001", notes: " " }, req("e4")),
      ),
    ).toBe("invalid");
  });

  it("closes a ticket only when the reporter confirmed the fix, and refuses a closed one", async () => {
    const it = desk();
    const waiting = await it.resolveTicket(
      { from: NOAH, ticketId: "T-1001", outcome: "Cleared the jam", reporterConfirmed: false },
      req("v1"),
    );
    expect(waiting.status).toBe("awaiting_confirmation");
    expect(waiting.resolution).toMatchObject({ reporterConfirmed: false });
    const closed = await it.resolveTicket(
      { from: NOAH, ticketId: "T-1001", outcome: "Cleared the jam", reporterConfirmed: true },
      req("v2"),
    );
    expect(closed.status).toBe("closed");
    expect(
      await refusalCode(
        it.resolveTicket(
          { from: NOAH, ticketId: "T-1001", outcome: "x", reporterConfirmed: true },
          req("v3"),
        ),
      ),
    ).toBe("closed");
    expect(
      await refusalCode(
        it.escalateTicket({ from: NOAH, ticketId: "T-1001", notes: "x" }, req("v4")),
      ),
    ).toBe("closed");
  });

  it("lists the demonstration tickets to staff, by number or status", async () => {
    const it = desk();
    expect((await it.listTickets({ from: NOAH })).map((ticket) => ticket.id)).toEqual([
      "T-1001",
      "T-1002",
      "T-1003",
    ]);
    expect((await it.listTickets({ from: NOAH, ticketId: "t-1003" }))[0]?.status).toBe(
      "awaiting_confirmation",
    );
    expect(
      (await it.listTickets({ from: NOAH, status: "open" })).map((ticket) => ticket.id),
    ).toEqual(["T-1001", "T-1002"]);
  });
});

describe("asset register", () => {
  it("refuses an asset already assigned, naming who has it", async () => {
    const it = desk();
    const refused = await refusal(
      it.assignAsset({ from: PRIYA, tag: "LT-201", person: "Noah Kim" }, req("a1")),
    );
    expect(refused.code).toBe("assigned");
    expect(refused.message).toContain("Dana Whitfield");
  });

  it("assigns one in stock, returns it, and refuses a return of one not assigned", async () => {
    const it = desk();
    const given = await it.assignAsset(
      { from: PRIYA, tag: "LT-204", person: "Noah Kim" },
      req("a1"),
    );
    expect(given).toMatchObject({
      status: "assigned",
      assignedToName: "Noah Kim",
      since: "2026-11-09",
    });
    expect(
      await it.assignAsset({ from: PRIYA, tag: "LT-204", person: "Noah Kim" }, req("a1")),
    ).toEqual(given);
    const back = await it.returnAsset({ from: PRIYA, tag: "LT-204", condition: "Good" }, req("a2"));
    expect(back).toMatchObject({ status: "in_stock", assignedToName: null, since: null });
    expect(
      await refusalCode(
        it.returnAsset({ from: PRIYA, tag: "LT-204", condition: "Good" }, req("a3")),
      ),
    ).toBe("not_assigned");
  });

  it("refuses a retired asset, an unknown tag, and a person whose account is disabled", async () => {
    const it = desk();
    expect(
      await refusalCode(
        it.assignAsset({ from: PRIYA, tag: "LT-205", person: "Noah Kim" }, req("b1")),
      ),
    ).toBe("retired");
    expect(
      await refusalCode(
        it.assignAsset({ from: PRIYA, tag: "XX-1", person: "Noah Kim" }, req("b2")),
      ),
    ).toBe("not_found");
    const facts = await it.disableFacts({ from: PRIYA, person: "Noah Kim", reason: "Leaving" });
    await it.disableAccount(
      { from: PRIYA, person: "Noah Kim", reason: "Leaving", approved: facts },
      req("b3"),
    );
    expect(
      await refusalCode(
        it.assignAsset({ from: PRIYA, tag: "LT-204", person: "Noah Kim" }, req("b4")),
      ),
    ).toBe("disabled");
  });

  it("lists by person and status", async () => {
    const it = desk();
    expect((await it.listAssets({ from: PRIYA, person: "Noah Kim" })).map((a) => a.tag)).toEqual([
      "LT-203",
    ]);
    expect((await it.listAssets({ from: PRIYA, status: "in_stock" })).map((a) => a.tag)).toEqual([
      "LT-204",
      "PH-302",
    ]);
  });
});

describe("security concerns", () => {
  it("hands a report to the person who decides IT, from staff or from outside", async () => {
    const it = desk();
    const report = await it.reportSecurityConcern(
      { from: NOAH, kind: "phishing", description: "Email asking me to confirm my password" },
      req("sec1"),
    );
    expect(report).toMatchObject({
      id: "SEC-1",
      kind: "phishing",
      reportedBy: "Noah Kim",
      handedTo: { name: "Dana Whitfield", title: "Managing Director" },
    });
    const outside = await it.reportSecurityConcern(
      { from: STRANGER, kind: "other", description: "Odd call" },
      req("sec2"),
    );
    expect(outside.reportedBy).toBe("an unverified sender");
    expect(
      await it.reportSecurityConcern(
        { from: NOAH, kind: "phishing", description: "dup" },
        req("sec1"),
      ),
    ).toEqual(report);
  });
});
