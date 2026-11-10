/**
 * One block per tool, against `fakeOperationsDesk` and the company facts generated into this package,
 * through the registrations the factory builds and with the durable call identity Pi Durable hands to
 * `execute`. No network, no model.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import { loadCompanyFacts, personLabel, scheduleOwner } from "./company.js";
import { fakeOperationsDesk, type OperationsDesk } from "./desk.js";
import { type OperationsToolset, operationsTools } from "./tools.js";

const company = loadCompanyFacts();
const owner = personLabel(scheduleOwner(company));

const NOW = new Date("2026-11-09T15:00:00.000Z");

/** The durable identity one tool call runs under; only the ids matter to these tools. */
const call = (callId: string) =>
  ({ conversationId: "conversation-1", taskId: "task-1", callId }) as never;

const tools = (desk: OperationsDesk | undefined): OperationsToolset =>
  operationsTools({ desk, company });

const desk = (): OperationsDesk => fakeOperationsDesk({ now: () => NOW });

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
    const result = await tools(operations).requestOvertime.execute(
      { crewId: "cleaning-central", jobId: "J-2101", hours: 7 },
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
    const wrong = await tools(operations).requestOvertime.execute(
      { crewId: "cleaning-central", jobId: "J-2101", hours: 10 },
      call("c9"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(wrong)).toBe(true);
    expect(text(wrong)).toContain("exactly 7 hours");

    const args = { crewId: "cleaning-central", jobId: "J-2101", hours: 7 };
    const first = await tools(operations).requestOvertime.execute(
      args,
      call("ot"),
      BACKGROUND_CONTEXT,
    );
    const again = await tools(operations).requestOvertime.execute(
      args,
      call("ot"),
      BACKGROUND_CONTEXT,
    );
    expect(text(again)).toBe(text(first));
    const central = (await operations.listCrews()).find(
      (crew) => crew.crewId === "cleaning-central",
    );
    expect(central?.overtimeHours).toBe(7);
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
    const result = await tools(desk()).requestContractReschedule.execute(
      { jobId: "J-1034", newDate: "2026-11-14", reason: "Floors recarpeted on Thursday" },
      call("c12"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(false);
    expect(text(result)).toContain("J-1034");
    expect(text(result)).toContain("CT-303");
    expect(text(result)).toContain("2026-11-12 to 2026-11-14");
  });

  it("refuses a one-off job", async () => {
    const result = await tools(desk()).requestContractReschedule.execute(
      { jobId: "J-2103", newDate: "2026-11-16", reason: "Client asked" },
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
    for (const [tool, args] of cases) {
      const operations = desk();
      const first = await tools(operations)[tool].execute(args, call("r"), BACKGROUND_CONTEXT);
      const again = await tools(operations)[tool].execute(args, call("r"), BACKGROUND_CONTEXT);
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
