/**
 * One block per tool, against `fakeOperationsDesk` and the company facts generated into this package,
 * through the registrations the factory builds and with the durable call identity Pi Durable hands to
 * `execute`. No network, no model.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { APPROVED_FACTS_ARG, type ApprovalFactsReader } from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import { loadCompanyFacts, personLabel, scheduleOwner } from "./company.js";
import { fakeOperationsDesk, type OperationsDesk } from "./desk.js";
import { type OperationsToolset, operationsTools } from "./tools.js";

const company = loadCompanyFacts();
const owner = personLabel(scheduleOwner(company));

/** The Central crew's name, as the company record gives it. */
const CENTRAL = company.crews.find((crew) => crew.id === "cleaning-central")?.name;

const NOW = new Date("2026-11-09T15:00:00.000Z");

/** The durable identity one tool call runs under; only the ids matter to these tools. */
const call = (callId: string) =>
  ({ conversationId: "conversation-1", taskId: "task-1", callId }) as never;

const tools = (desk: OperationsDesk | undefined): OperationsToolset =>
  operationsTools({ desk, company });

const desk = (): OperationsDesk => fakeOperationsDesk({ now: () => NOW });

/**
 * The arguments a gated tool receives after a yes: the model's, plus the facts the gate read from
 * the desk and a person approved.
 */
async function approvedArgs<Args extends Record<string, unknown>>(
  reader: ApprovalFactsReader,
  args: Args,
) {
  const read = await reader(args, BACKGROUND_CONTEXT as never, {
    conversationId: "conversation-1",
    taskId: "task-1",
  });
  return { ...args, [APPROVED_FACTS_ARG]: read.facts };
}

function text(result: { output?: readonly unknown[] }): string {
  return (result.output ?? [])
    .map((block) => (block as { type?: string; text?: string }).text ?? "")
    .join("\n");
}

async function centralWeek(operations: OperationsDesk) {
  return (await operations.listCrews()).find((crew) => crew.crewId === "cleaning-central");
}

function details(result: unknown): Record<string, unknown> {
  return (result as { details?: Record<string, unknown> }).details ?? {};
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

describe("list_jobs", () => {
  it("lists a day's jobs with their crew, hours and whether they are on a contract", async () => {
    const result = await tools(desk()).listJobs.execute(
      { date: "2026-11-12" },
      call("c1"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain("J-2101");
    expect(text(result)).toContain("Riverside Dental");
    expect(text(result)).toContain("12 crew-hours");
    expect(text(result)).toContain("no crew yet");
    expect(text(result)).toContain("one-off");
    expect(text(result)).toContain("recurring contract CT-303");
    expect(details(result).found).toBe(true);
  });

  it("filters by client, and says plainly when nothing matches", async () => {
    const found = await tools(desk()).listJobs.execute(
      { client: "Sellwood" },
      call("c2"),
      BACKGROUND_CONTEXT,
    );
    expect((details(found).jobs as unknown[]).length).toBe(5);
    const none = await tools(desk()).listJobs.execute(
      { client: "Nobody Ltd" },
      call("c3"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(none)).toBe(true);
    expect(details(none).found).toBe(false);
    expect(text(none)).toContain("No job matches");
  });
});

describe("list_crews", () => {
  it("gives each crew's booked hours, cap and hours left, from the desk", async () => {
    const result = await tools(desk()).listCrews.execute(
      { weekOf: "2026-11-12" },
      call("c4"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain("week of 2026-11-09 to 2026-11-15");
    expect(text(result)).toContain("Central cleaning crews");
    expect(text(result)).toContain("135 of 140 hours booked, 5 left");
    expect(text(result)).toContain("approved time off on 2026-11-12");
    const crews = details(result).crews as { crewId: string; bookedHours: number }[];
    expect(crews.map((crew) => crew.crewId)).toEqual(company.crews.map((crew) => crew.id));
  });
});

describe("assign_crew", () => {
  it("assigns a crew with room and reports the week's hours", async () => {
    const result = await tools(desk()).assignCrew.execute(
      { jobId: "J-2102", crewId: "cleaning-north" },
      call("c5"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(false);
    expect(text(result)).toContain("Assigned North cleaning crews to J-2102");
    expect(text(result)).toContain("138 hours booked against a weekly cap of 140");
    expect(details(result)).toMatchObject({ jobId: "J-2102", crewId: "cleaning-north" });
  });

  it("refuses over the cap with the overtime the desk worked out, and names who decides", async () => {
    const operations = desk();
    const result = await tools(operations).assignCrew.execute(
      { jobId: "J-2101", crewId: "cleaning-central" },
      call("c6"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("request_overtime");
    expect(text(result)).toContain("hours 7");
    expect(text(result)).toContain(owner);
    expect(details(result)).toMatchObject({ code: "over_cap", overtimeHoursNeeded: 7 });
    expect((await operations.listJobs({ client: "Riverside" }))[0]?.crewId).toBeNull();
  });

  it("refuses a crew on approved time off", async () => {
    const result = await tools(desk()).assignCrew.execute(
      { jobId: "J-2101", crewId: "cleaning-south" },
      call("c7"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(details(result).code).toBe("time_off");
  });

  it("makes one assignment however many times the same call is replayed", async () => {
    const operations = desk();
    const first = await tools(operations).assignCrew.execute(
      { jobId: "J-2102", crewId: "cleaning-north" },
      call("same"),
      BACKGROUND_CONTEXT,
    );
    const again = await tools(operations).assignCrew.execute(
      { jobId: "J-2102", crewId: "cleaning-north" },
      call("same"),
      BACKGROUND_CONTEXT,
    );
    expect(text(again)).toBe(text(first));
    const [north] = await operations.listCrews();
    expect(north?.bookedHours).toBe(138);
  });
});

describe("request_overtime", () => {
  it("records the overtime and assigns the crew, in the desk's figures", async () => {
    const operations = desk();
    const set = tools(operations);
    const result = await set.requestOvertime.execute(
      await approvedArgs(set.overtimeFacts, {
        crewId: "cleaning-central",
        jobId: "J-2101",
        hours: 7,
      }),
      call("c8"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(false);
    expect(text(result)).toContain("OT-1");
    expect(text(result)).toContain("7 hours");
    expect(text(result)).toContain("J-2101");
    expect(details(result)).toMatchObject({ id: "OT-1", hours: 7, bookedHours: 147 });
  });

  it("refuses a figure that is not the overage, and replays without granting twice", async () => {
    const operations = desk();
    const set = tools(operations);
    const wrong = await set.requestOvertime.execute(
      await approvedArgs(set.overtimeFacts, {
        crewId: "cleaning-central",
        jobId: "J-2101",
        hours: 10,
      }),
      call("c9"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(wrong)).toBe(true);
    expect(text(wrong)).toContain("exactly 7 hours");

    const args = await approvedArgs(set.overtimeFacts, {
      crewId: "cleaning-central",
      jobId: "J-2101",
      hours: 7,
    });
    const first = await set.requestOvertime.execute(args, call("ot"), BACKGROUND_CONTEXT);
    const again = await set.requestOvertime.execute(args, call("ot"), BACKGROUND_CONTEXT);
    expect(text(again)).toBe(text(first));
    // After a restart the role is built again over the same desk, and the same call is run again
    // with the facts the gate kept: still one grant.
    const restarted = await tools(operations).requestOvertime.execute(
      args,
      call("ot"),
      BACKGROUND_CONTEXT,
    );
    expect(text(restarted)).toBe(text(first));
    expect(await centralWeek(operations)).toMatchObject({ overtimeHours: 7, bookedHours: 147 });
  });

  it("refuses a call that carries no facts a person approved, and records nothing", async () => {
    const operations = desk();
    const result = await tools(operations).requestOvertime.execute(
      { crewId: "cleaning-central", jobId: "J-2101", hours: 7 },
      call("bare"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(details(result).code).toBe("not_approved");
    expect(text(result)).toContain(owner);
    expect(await centralWeek(operations)).toMatchObject({ overtimeHours: 0, bookedHours: 135 });
  });

  it("refuses when the job was given to another crew after the person saw it", async () => {
    const operations = desk();
    const set = tools(operations);
    const args = await approvedArgs(set.overtimeFacts, {
      crewId: "cleaning-central",
      jobId: "J-2101",
      hours: 7,
    });
    await set.assignCrew.execute(
      { jobId: "J-2101", crewId: "cleaning-north" },
      call("meanwhile"),
      BACKGROUND_CONTEXT,
    );
    const result = await set.requestOvertime.execute(args, call("stale"), BACKGROUND_CONTEXT);
    expect(isError(result)).toBe(true);
    expect(details(result).code).toBe("changed");
    expect(text(result)).toContain("Nothing was recorded");
    expect(text(result)).toContain("list_jobs");
    expect((await operations.listJobs({ client: "J-2101" }))[0]?.crewId).toBe("cleaning-north");
    expect(await centralWeek(operations)).toMatchObject({ overtimeHours: 0, bookedHours: 135 });
  });
});

describe("approval facts", () => {
  it("reads an overtime request's crew, client, date and hours from the desk", async () => {
    const read = await tools(desk()).overtimeFacts(
      { crewId: "cleaning-central", jobId: "J-2101", hours: 7 },
      BACKGROUND_CONTEXT as never,
      call("f1"),
    );
    expect(read.facts).toEqual({
      crewId: "cleaning-central",
      crewName: CENTRAL,
      jobId: "J-2101",
      client: "Riverside Dental",
      site: "3,200 sq ft suite on SE Hawthorne Boulevard",
      service: "Deep clean and floor care",
      date: "2026-11-12",
      crewHours: 12,
      assignedCrewId: null,
      overtimeHours: 7,
      weekStart: "2026-11-09",
      bookedHours: 135,
      weeklyHoursCap: 140,
    });
  });

  it("reads a contract move's client, contract, crew and both dates, with the client's reason", async () => {
    const read = await tools(desk()).contractRescheduleFacts(
      { jobId: "J-1034", newDate: "2026-11-14", reason: "  Floors recarpeted on Thursday. " },
      BACKGROUND_CONTEXT as never,
      call("f2"),
    );
    expect(read.summary).toBe(
      `Move J-1034 (Sellwood Law Partners, Recurring janitorial, contract CT-303, ${CENTRAL}) from 2026-11-12 to 2026-11-14. The client's reason: Floors recarpeted on Thursday.`,
    );
    expect(read.facts).toMatchObject({
      jobId: "J-1034",
      contractId: "CT-303",
      fromDate: "2026-11-12",
      toDate: "2026-11-14",
    });
  });

  it("throws, so nobody is asked, for an unknown job or crew and with no desk", async () => {
    const toolset = tools(desk());
    await expect(
      toolset.overtimeFacts(
        { crewId: "cleaning-west", jobId: "J-2101", hours: 7 },
        BACKGROUND_CONTEXT as never,
        call("f3"),
      ),
    ).rejects.toThrow('No crew has the id "cleaning-west". Nothing was put to a person.');
    await expect(
      toolset.contractRescheduleFacts(
        { jobId: "J-9", newDate: "2026-11-14", reason: "Asked." },
        BACKGROUND_CONTEXT as never,
        call("f4"),
      ),
    ).rejects.toThrow('No job has the id "J-9". Nothing was put to a person.');
    await expect(
      tools(undefined).overtimeFacts(
        { crewId: "cleaning-central", jobId: "J-2101", hours: 7 },
        BACKGROUND_CONTEXT as never,
        call("f5"),
      ),
    ).rejects.toThrow("No operations desk is bound");
  });
});

describe("reschedule_job", () => {
  it("moves a one-off job", async () => {
    const result = await tools(desk()).rescheduleJob.execute(
      { jobId: "J-2103", newDate: "2026-11-16" },
      call("c10"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(false);
    expect(text(result)).toContain("Moved J-2103");
    expect(text(result)).toContain("2026-11-13 to 2026-11-16");
  });

  it("refuses a contract visit, pointing to request_contract_reschedule and who decides", async () => {
    const result = await tools(desk()).rescheduleJob.execute(
      { jobId: "J-1034", newDate: "2026-11-14" },
      call("c11"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("request_contract_reschedule");
    expect(text(result)).toContain(owner);
    expect(details(result).code).toBe("recurring");
  });
});

describe("request_contract_reschedule", () => {
  it("moves the contract visit and keeps the reason", async () => {
    const set = tools(desk());
    const result = await set.requestContractReschedule.execute(
      await approvedArgs(set.contractRescheduleFacts, {
        jobId: "J-1034",
        newDate: "2026-11-14",
        reason: "Floors recarpeted on Thursday",
      }),
      call("c12"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(false);
    expect(text(result)).toContain("J-1034");
    expect(text(result)).toContain("CT-303");
    expect(text(result)).toContain("2026-11-12 to 2026-11-14");
  });

  it("refuses a call that carries no facts a person approved, and moves nothing", async () => {
    const operations = desk();
    const result = await tools(operations).requestContractReschedule.execute(
      { jobId: "J-1034", newDate: "2026-11-14", reason: "Floors recarpeted on Thursday" },
      call("bare"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(details(result).code).toBe("not_approved");
    expect((await operations.listJobs({ client: "J-1034" }))[0]?.date).toBe("2026-11-12");
  });

  it("refuses when the visit moved after the person saw it, and moves nothing more", async () => {
    const operations = desk();
    const set = tools(operations);
    const stale = await approvedArgs(set.contractRescheduleFacts, {
      jobId: "J-1034",
      newDate: "2026-11-14",
      reason: "Floors recarpeted on Thursday",
    });
    await set.requestContractReschedule.execute(
      await approvedArgs(set.contractRescheduleFacts, {
        jobId: "J-1034",
        newDate: "2026-11-15",
        reason: "Client asked",
      }),
      call("meanwhile"),
      BACKGROUND_CONTEXT,
    );
    const result = await set.requestContractReschedule.execute(
      stale,
      call("stale"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(details(result).code).toBe("changed");
    expect(text(result)).toContain("Nothing was moved");
    expect((await operations.listJobs({ client: "J-1034" }))[0]?.date).toBe("2026-11-15");
  });

  it("refuses a one-off job", async () => {
    const result = await tools(desk()).requestContractReschedule.execute(
      // The gate's reader refuses a one-off job, so no real grant exists for one; the desk refuses too.
      { jobId: "J-2103", newDate: "2026-11-16", reason: "Client asked", [APPROVED_FACTS_ARG]: {} },
      call("c13"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(details(result).code).toBe("one_off");
  });
});

describe("record_callout", () => {
  it("records the call-out, says it booked nothing, and names who decides", async () => {
    const result = await tools(desk()).recordCallout.execute(
      { jobId: "J-1041", reason: "Water coming through the lobby ceiling" },
      call("c14"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(false);
    expect(text(result)).toContain("CO-1");
    expect(text(result)).toContain("no crew is booked");
    expect(text(result)).toContain(owner);
  });
});

describe("replay of the other writes", () => {
  it("answers a replayed reschedule, contract move and call-out with what it already did", async () => {
    const cases = [
      ["rescheduleJob", { jobId: "J-2103", newDate: "2026-11-16" }],
      ["requestContractReschedule", { jobId: "J-1034", newDate: "2026-11-14", reason: "Carpet" }],
      ["recordCallout", { jobId: "J-1041", reason: "Leak" }],
    ] as const;
    for (const [tool, bare] of cases) {
      const operations = desk();
      const set = tools(operations);
      const args =
        tool === "requestContractReschedule"
          ? await approvedArgs(set.contractRescheduleFacts, bare)
          : bare;
      const first = await set[tool].execute(args as never, call("r"), BACKGROUND_CONTEXT);
      // The second run is on tools built again over the same desk, as after a restart.
      const again = await tools(operations)[tool].execute(
        args as never,
        call("r"),
        BACKGROUND_CONTEXT,
      );
      expect(isError(first), tool).toBe(false);
      expect(text(again), tool).toBe(text(first));
    }
    // A replayed call-out is one record: the next new call is CO-2, not CO-3.
    const operations = desk();
    const args = { jobId: "J-1041", reason: "Leak" };
    await tools(operations).recordCallout.execute(args, call("x"), BACKGROUND_CONTEXT);
    await tools(operations).recordCallout.execute(args, call("x"), BACKGROUND_CONTEXT);
    const next = await tools(operations).recordCallout.execute(args, call("y"), BACKGROUND_CONTEXT);
    expect(text(next)).toContain("CO-2");
  });
});

describe("contract crew", () => {
  it("refuses another crew on a contract visit and says to hand it to the schedule owner", async () => {
    const result = await tools(desk()).assignCrew.execute(
      { jobId: "J-1051", crewId: "cleaning-central" },
      call("cc"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(details(result).code).toBe("contract_crew");
    expect(text(result)).toContain(owner);
    expect(text(result)).not.toContain("request_contract_reschedule");
  });
});

describe("read_company", () => {
  it("gives the crews with their caps, and the staff policies with who answers each", async () => {
    const result = await tools(undefined).readCompany.execute(
      { section: "crews" },
      call("c15"),
      BACKGROUND_CONTEXT,
    );
    for (const crew of company.crews) {
      expect(text(result)).toContain(crew.name);
      expect(text(result)).toContain(`${crew.weeklyHoursCap} hours a week`);
    }
    expect(text(result)).toContain("Overtime needs a person's approval");
    const discipline = company.people.find(
      (worker) => worker.id === company.staffPolicies.disciplineTo,
    );
    expect(text(result)).toContain(discipline?.name ?? "missing");
  });

  it("answers for the people and the escalation path", async () => {
    const people = await tools(undefined).readCompany.execute(
      { section: "people" },
      call("c16"),
      BACKGROUND_CONTEXT,
    );
    for (const worker of company.people) expect(text(people)).toContain(worker.name);
    const escalation = await tools(undefined).readCompany.execute(
      { section: "escalation" },
      call("c17"),
      BACKGROUND_CONTEXT,
    );
    expect(text(escalation)).toContain("start-date");
  });
});

describe("with no desk", () => {
  it("refuses rather than pretending", async () => {
    await expect(
      tools(undefined).listJobs.execute({}, call("c18"), BACKGROUND_CONTEXT),
    ).rejects.toThrow("No operations desk is bound to this role, so nothing was read or written.");
  });
});
