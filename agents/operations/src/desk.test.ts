/**
 * The demonstration desk's rules, on the company's own crews: the weekly hours cap, approved time
 * off, the line between a one-off job and a visit on a recurring contract, and a replayed write that
 * changes nothing twice. These are the limits the role enforces in code, so each one is tested at its
 * edge.
 */

import { describe, expect, it } from "vitest";
import { type Crew, loadCompanyFacts } from "./company.js";
import { fakeOperationsDesk, type OperationsDesk, OperationsDeskError } from "./desk.js";

const company = loadCompanyFacts();

/** Monday of the demonstration week, at the start of the office day. */
const NOW = new Date("2026-11-09T15:00:00.000Z");

const desk = (crews: readonly Crew[] = company.crews): OperationsDesk =>
  fakeOperationsDesk({ crews, now: () => NOW });

/** The error a desk call throws, so a test can read its code and message. */
async function refusalOf(promise: Promise<unknown>): Promise<OperationsDeskError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OperationsDeskError) return error;
    throw error;
  }
  throw new Error("the desk did not refuse");
}

async function crewWeek(operations: OperationsDesk, crewId: string, weekOf = "2026-11-09") {
  const crews = await operations.listCrews({ weekOf });
  const crew = crews.find((candidate) => candidate.crewId === crewId);
  if (crew === undefined) throw new Error(`no crew ${crewId}`);
  return crew;
}

describe("listJobs", () => {
  it("filters by date, by crew and by a part of the client's name", async () => {
    const operations = desk();
    const thursday = await operations.listJobs({ date: "2026-11-12" });
    expect(thursday.map((job) => job.id)).toContain("J-2101");
    expect(thursday.every((job) => job.date === "2026-11-12")).toBe(true);

    const central = await operations.listJobs({ crewId: "cleaning-central" });
    expect(central.length).toBe(10);
    expect(central.every((job) => job.crewId === "cleaning-central")).toBe(true);

    const riverside = await operations.listJobs({ client: "riverside" });
    expect(riverside.map((job) => job.id)).toEqual(["J-2101"]);
    expect(riverside[0]?.crewId).toBeNull();
    expect(riverside[0]?.contractId).toBeNull();
  });

  it("returns jobs in date order, and nothing for a client it does not hold", async () => {
    const jobs = await desk().listJobs();
    const dates = jobs.map((job) => job.date);
    expect(dates).toEqual([...dates].sort());
    expect(await desk().listJobs({ client: "Nobody Ltd" })).toEqual([]);
  });
});

describe("listCrews", () => {
  it("adds up each crew's booked hours for the week, against the company's cap", async () => {
    const operations = desk();
    const crews = await operations.listCrews({ weekOf: "2026-11-11" });
    expect(crews.map((crew) => crew.crewId)).toEqual(company.crews.map((crew) => crew.id));
    const central = crews.find((crew) => crew.crewId === "cleaning-central");
    expect(central).toMatchObject({
      weekStart: "2026-11-09",
      weekEnd: "2026-11-15",
      bookedHours: 135,
      weeklyHoursCap: 140,
      overtimeHours: 0,
      hoursLeft: 5,
    });
    expect((await crewWeek(operations, "cleaning-north")).bookedHours).toBe(128);
    expect((await crewWeek(operations, "cleaning-south")).bookedHours).toBe(50);
    expect((await crewWeek(operations, "maintenance")).bookedHours).toBe(83);
    const south = await crewWeek(operations, "cleaning-south");
    expect(south.timeOff.map((entry) => entry.date)).toEqual(["2026-11-12"]);
    // The demo week books no South job on its own day off.
    const thursday = await operations.listJobs({ date: "2026-11-12", crewId: "cleaning-south" });
    expect(thursday).toEqual([]);
  });

  it("defaults to the week the clock is in", async () => {
    const [first] = await desk().listCrews();
    expect(first?.weekStart).toBe("2026-11-09");
  });

  it("takes each cap from the crews it is given, never from a constant", async () => {
    const tight = company.crews.map((crew) =>
      crew.id === "cleaning-north" ? { ...crew, weeklyHoursCap: 100 } : crew,
    );
    const north = await crewWeek(desk(tight), "cleaning-north");
    expect(north.weeklyHoursCap).toBe(100);
    expect(north.hoursLeft).toBe(0);
  });
});

describe("assignCrew", () => {
  it("assigns a crew whose week has room, and books the job's hours against it", async () => {
    const operations = desk();
    const assignment = await operations.assignCrew(
      { jobId: "J-2102", crewId: "cleaning-north" },
      { requestId: "assign-1" },
    );
    expect(assignment).toMatchObject({
      jobId: "J-2102",
      crewId: "cleaning-north",
      crewHours: 10,
      weekStart: "2026-11-09",
      bookedHours: 138,
      weeklyHoursCap: 140,
      overtimeHours: 0,
    });
    expect((await crewWeek(operations, "cleaning-north")).bookedHours).toBe(138);
  });

  it("assigns a job that lands the week exactly at the cap", async () => {
    const operations = desk();
    const assignment = await operations.assignCrew(
      { jobId: "J-2101", crewId: "cleaning-north" },
      { requestId: "assign-at-cap" },
    );
    expect(assignment.bookedHours).toBe(140);
  });

  it("refuses an hour over the cap, and points to request_overtime with the hours code worked out", async () => {
    const operations = desk();
    const refused = await refusalOf(
      operations.assignCrew(
        { jobId: "J-2101", crewId: "cleaning-central" },
        { requestId: "assign-2" },
      ),
    );
    expect(refused.code).toBe("over_cap");
    expect(refused.overtimeHoursNeeded).toBe(7);
    expect(refused.message).toContain("147");
    expect(refused.message).toContain("140");
    expect(refused.message).toContain("request_overtime");
    expect((await crewWeek(operations, "cleaning-central")).bookedHours).toBe(135);
    expect((await operations.listJobs({ client: "Riverside" }))[0]?.crewId).toBeNull();
  });

  it("refuses a crew with approved time off that day, even with room in its week", async () => {
    const operations = desk();
    const refused = await refusalOf(
      operations.assignCrew(
        { jobId: "J-2101", crewId: "cleaning-south" },
        { requestId: "assign-3" },
      ),
    );
    expect(refused.code).toBe("time_off");
    expect(refused.message).toContain("2026-11-12");
    expect((await crewWeek(operations, "cleaning-south")).bookedHours).toBe(50);
  });

  it("answers a replayed call with the assignment it already made, counting the hours once", async () => {
    const operations = desk();
    const first = await operations.assignCrew(
      { jobId: "J-2102", crewId: "cleaning-north" },
      { requestId: "assign-4" },
    );
    const again = await operations.assignCrew(
      { jobId: "J-2102", crewId: "cleaning-north" },
      { requestId: "assign-4" },
    );
    expect(again).toEqual(first);
    expect((await crewWeek(operations, "cleaning-north")).bookedHours).toBe(138);
  });

  it("keeps a contract visit's crew: another crew is the Operations Manager's decision", async () => {
    const operations = desk();
    const refused = await refusalOf(
      operations.assignCrew({ jobId: "J-1051", crewId: "cleaning-central" }, { requestId: "cc" }),
    );
    expect(refused.code).toBe("contract_crew");
    expect(refused.message).toContain("CT-305");
    expect((await operations.listJobs({ client: "J-1051" }))[0]?.crewId).toBe("cleaning-south");
    // Re-assigning the crew it already has changes nothing and is not refused.
    const same = await operations.assignCrew(
      { jobId: "J-1051", crewId: "cleaning-south" },
      { requestId: "cc-same" },
    );
    expect(same.crewId).toBe("cleaning-south");
  });

  it("refuses a job or a crew it does not hold, naming what it does", async () => {
    const operations = desk();
    const noJob = await refusalOf(
      operations.assignCrew({ jobId: "J-9999", crewId: "cleaning-north" }, { requestId: "a-5" }),
    );
    expect(noJob.code).toBe("not_found");
    const noCrew = await refusalOf(
      operations.assignCrew({ jobId: "J-2102", crewId: "night-owls" }, { requestId: "a-6" }),
    );
    expect(noCrew.code).toBe("not_found");
    expect(noCrew.message).toContain("cleaning-north");
  });
});

describe("requestOvertime", () => {
  it("records the overtime the cap needs and assigns the crew", async () => {
    const operations = desk();
    const grant = await operations.requestOvertime(
      { crewId: "cleaning-central", jobId: "J-2101", hours: 7 },
      { requestId: "ot-1" },
    );
    expect(grant).toMatchObject({
      crewId: "cleaning-central",
      jobId: "J-2101",
      hours: 7,
      weekStart: "2026-11-09",
      bookedHours: 147,
      weeklyHoursCap: 140,
      overtimeHours: 7,
    });
    const central = await crewWeek(operations, "cleaning-central");
    expect(central).toMatchObject({ bookedHours: 147, overtimeHours: 7, hoursLeft: 0 });
    expect((await operations.listJobs({ client: "Riverside" }))[0]?.crewId).toBe(
      "cleaning-central",
    );
  });

  it("refuses hours that are not the overage, saying what the overage is", async () => {
    const operations = desk();
    for (const hours of [6, 8]) {
      const refused = await refusalOf(
        operations.requestOvertime(
          { crewId: "cleaning-central", jobId: "J-2101", hours },
          { requestId: `ot-${hours}` },
        ),
      );
      expect(refused.code).toBe("invalid");
      expect(refused.overtimeHoursNeeded).toBe(7);
    }
    expect((await crewWeek(operations, "cleaning-central")).overtimeHours).toBe(0);
  });

  it("refuses overtime a job does not need, pointing back to assign_crew", async () => {
    const refused = await refusalOf(
      desk().requestOvertime(
        { crewId: "cleaning-north", jobId: "J-2102", hours: 2 },
        { requestId: "ot-fits" },
      ),
    );
    expect(refused.code).toBe("fits");
    expect(refused.message).toContain("assign_crew");
  });

  it("refuses overtime on a day the crew has approved time off", async () => {
    const refused = await refusalOf(
      desk().requestOvertime(
        { crewId: "cleaning-south", jobId: "J-2101", hours: 1 },
        { requestId: "ot-off" },
      ),
    );
    expect(refused.code).toBe("time_off");
  });

  it("answers a replayed call with the overtime it already recorded, granting it once", async () => {
    const operations = desk();
    const args = { crewId: "cleaning-central", jobId: "J-2101", hours: 7 };
    const first = await operations.requestOvertime(args, { requestId: "ot-replay" });
    const again = await operations.requestOvertime(args, { requestId: "ot-replay" });
    expect(again).toEqual(first);
    expect((await crewWeek(operations, "cleaning-central")).overtimeHours).toBe(7);
  });
  it("counts approved overtime only while its job is still on that crew in that week", async () => {
    const operations = desk();
    await operations.requestOvertime(
      { crewId: "cleaning-central", jobId: "J-2101", hours: 7 },
      { requestId: "ot-moves" },
    );
    await operations.rescheduleJob(
      { jobId: "J-2101", newDate: "2026-11-17" },
      { requestId: "move-away" },
    );
    const central = await crewWeek(operations, "cleaning-central");
    expect(central).toMatchObject({ bookedHours: 135, overtimeHours: 0, hoursLeft: 5 });
    const refused = await refusalOf(
      operations.assignCrew(
        { jobId: "J-2102", crewId: "cleaning-central" },
        { requestId: "spend-credit" },
      ),
    );
    expect(refused.code).toBe("over_cap");
  });

  it("stops counting overtime once its job is given to another crew", async () => {
    const operations = desk();
    await operations.requestOvertime(
      { crewId: "cleaning-central", jobId: "J-2101", hours: 7 },
      { requestId: "ot-reassigned" },
    );
    await operations.assignCrew(
      { jobId: "J-2101", crewId: "cleaning-north" },
      { requestId: "to-north" },
    );
    expect((await crewWeek(operations, "cleaning-central")).overtimeHours).toBe(0);
    // The approval was for Central: North gains no headroom from a job that arrived with one.
    expect((await crewWeek(operations, "cleaning-north")).overtimeHours).toBe(0);
  });

  it("keeps a recurring contract's visit on its crew, as assignCrew does", async () => {
    const operations = desk();
    const refused = await refusalOf(
      operations.requestOvertime(
        { crewId: "cleaning-central", jobId: "J-1011", hours: 7 },
        { requestId: "ot-contract" },
      ),
    );
    expect(refused.code).toBe("contract_crew");
  });
});

describe("rescheduleJob", () => {
  it("moves a one-off job, and its hours move to the new week", async () => {
    const operations = desk();
    const moved = await operations.rescheduleJob(
      { jobId: "J-2103", newDate: "2026-11-16" },
      { requestId: "move-1" },
    );
    expect(moved).toMatchObject({ jobId: "J-2103", fromDate: "2026-11-13", toDate: "2026-11-16" });
    expect((await crewWeek(operations, "cleaning-north")).bookedHours).toBe(120);
    expect((await crewWeek(operations, "cleaning-north", "2026-11-16")).bookedHours).toBe(8);
  });

  it("refuses a visit on a recurring contract and points to request_contract_reschedule", async () => {
    const operations = desk();
    const refused = await refusalOf(
      operations.rescheduleJob({ jobId: "J-1034", newDate: "2026-11-14" }, { requestId: "m-2" }),
    );
    expect(refused.code).toBe("recurring");
    expect(refused.message).toContain("request_contract_reschedule");
    expect((await operations.listJobs({ date: "2026-11-12", client: "Sellwood" })).length).toBe(1);
  });

  it("refuses a date that is not a date, the same date, or one already past", async () => {
    const operations = desk();
    for (const newDate of ["next Tuesday", "2026-02-30", "2026-11-13", "2026-11-02"]) {
      const refused = await refusalOf(
        operations.rescheduleJob({ jobId: "J-2103", newDate }, { requestId: `m-${newDate}` }),
      );
      expect(refused.code).toBe("invalid");
    }
  });

  it("refuses a date the crew has approved time off, or a week its cap cannot take", async () => {
    const operations = desk();
    await operations.assignCrew({ jobId: "J-2102", crewId: "cleaning-south" }, { requestId: "s" });
    const offDay = await refusalOf(
      operations.rescheduleJob({ jobId: "J-2102", newDate: "2026-11-12" }, { requestId: "m-3" }),
    );
    expect(offDay.code).toBe("time_off");

    const tight = company.crews.map((crew) =>
      crew.id === "cleaning-north" ? { ...crew, weeklyHoursCap: 130 } : crew,
    );
    const full = desk(tight);
    // With J-2103 moved out, J-2102 fills North's week to its cap, so J-2103 cannot move back in.
    await full.rescheduleJob({ jobId: "J-2103", newDate: "2026-11-16" }, { requestId: "out" });
    await full.assignCrew({ jobId: "J-2102", crewId: "cleaning-north" }, { requestId: "fill" });
    const overCap = await refusalOf(
      full.rescheduleJob({ jobId: "J-2103", newDate: "2026-11-11" }, { requestId: "m-4" }),
    );
    expect(overCap.code).toBe("over_cap_move");
  });

  it("answers a replayed call with the move it already made", async () => {
    const operations = desk();
    const first = await operations.rescheduleJob(
      { jobId: "J-2103", newDate: "2026-11-16" },
      { requestId: "move-replay" },
    );
    const again = await operations.rescheduleJob(
      { jobId: "J-2103", newDate: "2026-11-16" },
      { requestId: "move-replay" },
    );
    expect(again).toEqual(first);
  });
});

describe("requestContractReschedule", () => {
  it("moves a visit on a recurring contract, keeping the reason", async () => {
    const operations = desk();
    const moved = await operations.requestContractReschedule(
      { jobId: "J-1034", newDate: "2026-11-14", reason: "Floors recarpeted on Thursday" },
      { requestId: "c-1" },
    );
    expect(moved).toMatchObject({
      jobId: "J-1034",
      fromDate: "2026-11-12",
      toDate: "2026-11-14",
      contractId: "CT-303",
      reason: "Floors recarpeted on Thursday",
    });
    expect((await operations.listJobs({ date: "2026-11-14", client: "Sellwood" })).length).toBe(1);
  });

  it("refuses a one-off job, which reschedule_job moves", async () => {
    const refused = await refusalOf(
      desk().requestContractReschedule(
        { jobId: "J-2103", newDate: "2026-11-16", reason: "Client asked" },
        { requestId: "c-2" },
      ),
    );
    expect(refused.code).toBe("one_off");
    expect(refused.message).toContain("reschedule_job");
  });

  it("refuses a move with no reason", async () => {
    const refused = await refusalOf(
      desk().requestContractReschedule(
        { jobId: "J-1034", newDate: "2026-11-14", reason: "  " },
        { requestId: "c-3" },
      ),
    );
    expect(refused.code).toBe("invalid");
  });

  it("answers a replayed call with the move it already made", async () => {
    const operations = desk();
    const args = { jobId: "J-1034", newDate: "2026-11-14", reason: "Floors recarpeted" };
    const first = await operations.requestContractReschedule(args, { requestId: "c-replay" });
    const again = await operations.requestContractReschedule(args, { requestId: "c-replay" });
    expect(again).toEqual(first);
  });
});

describe("recordCallout", () => {
  it("records the call-out and books nothing", async () => {
    const operations = desk();
    const before = await operations.listCrews();
    const jobsBefore = await operations.listJobs();
    const callout = await operations.recordCallout(
      { jobId: "J-1041", reason: "Water coming through the lobby ceiling" },
      { requestId: "co-1" },
    );
    expect(callout).toMatchObject({
      id: "CO-1",
      jobId: "J-1041",
      reason: "Water coming through the lobby ceiling",
      at: NOW.toISOString(),
    });
    expect(await operations.listCrews()).toEqual(before);
    expect(await operations.listJobs()).toEqual(jobsBefore);
  });

  it("refuses a call-out with no reason, or on a job it does not hold", async () => {
    const operations = desk();
    expect(
      (
        await refusalOf(
          operations.recordCallout({ jobId: "J-1041", reason: "" }, { requestId: "co-2" }),
        )
      ).code,
    ).toBe("invalid");
    expect(
      (
        await refusalOf(
          operations.recordCallout({ jobId: "J-0000", reason: "Leak" }, { requestId: "co-3" }),
        )
      ).code,
    ).toBe("not_found");
  });

  it("answers a replayed call with the record it already made", async () => {
    const operations = desk();
    const args = { jobId: "J-1041", reason: "Leak" };
    const first = await operations.recordCallout(args, { requestId: "co-replay" });
    const again = await operations.recordCallout(args, { requestId: "co-replay" });
    expect(again).toEqual(first);
    const next = await operations.recordCallout(args, { requestId: "co-other" });
    expect(next.id).toBe("CO-2");
  });
});

describe("the company's day", () => {
  it("reads today, and so this week, in the company's time zone, not in UTC", async () => {
    // 17:30 on Sunday 15 November in Portland is already Monday the 16th in UTC.
    const evening = fakeOperationsDesk({ now: () => new Date("2026-11-16T01:30:00.000Z") });
    const [crew] = await evening.listCrews();
    expect(crew).toMatchObject({ weekStart: "2026-11-09", weekEnd: "2026-11-15" });
    // Sunday is still today, so a job can still be moved to it, and Saturday has passed.
    const moved = await evening.rescheduleJob(
      { jobId: "J-2104", newDate: "2026-11-15" },
      { requestId: "sunday" },
    );
    expect(moved.toDate).toBe("2026-11-15");
    const passed = await refusalOf(
      evening.rescheduleJob({ jobId: "J-2104", newDate: "2026-11-14" }, { requestId: "saturday" }),
    );
    expect(passed.message).toContain("2026-11-14 has already passed (today is 2026-11-15)");
  });

  it("takes another company's time zone", async () => {
    const tokyo = fakeOperationsDesk({
      timeZone: "Asia/Tokyo",
      now: () => new Date("2026-11-15T16:00:00.000Z"),
    });
    expect((await tokyo.listCrews())[0]?.weekStart).toBe("2026-11-16");
  });
});
