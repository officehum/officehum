import { describe, expect, it } from "vitest";
import { evidenceEngineArgs, resolveEvidenceArgs } from "./evidence.js";

const TICKET = {
  id: "t-1",
  data: { customer: "Acme", amount: 1250, paid: false, period: { month: "2026-10" }, blank: "" },
};

describe("resolveEvidenceArgs", () => {
  it("fills the ticket id and data paths, keeping a lone placeholder's own type", () => {
    expect(
      resolveEvidenceArgs(
        {
          ticket: "{ticket.id}",
          customer: "{ticket.data.customer}",
          amount: "{ticket.data.amount}",
          paid: "{ticket.data.paid}",
          label: "close {ticket.data.period.month} for {ticket.data.customer}",
          limit: 5,
        },
        TICKET,
      ),
    ).toEqual({
      ok: true,
      args: {
        ticket: "t-1",
        customer: "Acme",
        amount: 1250,
        paid: false,
        label: "close 2026-10 for Acme",
        limit: 5,
      },
    });
  });

  it("reports every placeholder the ticket cannot fill, and fills nothing by guessing", () => {
    expect(
      resolveEvidenceArgs(
        {
          customer: "{ticket.data.client}",
          month: "for {ticket.data.period.year}",
          whole: "{ticket.data.period}",
          blank: "{ticket.data.blank}",
          other: "{env.HOME}",
        },
        TICKET,
      ),
    ).toEqual({
      ok: false,
      missing: [
        "{ticket.data.client}",
        "{ticket.data.period.year}",
        "{ticket.data.period}",
        "{ticket.data.blank}",
        "{env.HOME}",
      ],
    });
  });

  it("does not read inherited properties or a ticket with no data", () => {
    expect(resolveEvidenceArgs({ a: "{ticket.data.constructor}" }, { id: "t", data: {} })).toEqual({
      ok: false,
      missing: ["{ticket.data.constructor}"],
    });
    expect(resolveEvidenceArgs({ a: "{ticket.data.x}" }, { id: "t", data: null })).toEqual({
      ok: false,
      missing: ["{ticket.data.x}"],
    });
    expect(resolveEvidenceArgs(undefined, { id: "t", data: null })).toEqual({ ok: true, args: {} });
  });
});

describe("evidenceEngineArgs", () => {
  it("writes each argument as a flag after the subcommand, as a tool's parameters are written", () => {
    expect(
      evidenceEngineArgs(["close", "check"], {
        work_order: "MP-1000",
        strict: true,
        dry: false,
        n: 3,
      }),
    ).toEqual(["close", "check", "--work-order", "MP-1000", "--strict", "--n", "3"]);
  });
});
