import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { openLocalCalendar } from "@officehum/office";
import { afterEach, describe, expect, it } from "vitest";
import { type CliIo, cliApprover, runCli } from "./cli.js";

const temps: string[] = [];
afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const state = () => {
  const directory = mkdtempSync(join(tmpdir(), "officehum-cli-"));
  temps.push(directory);
  return directory;
};

function io(...answers: [] | [string | undefined]) {
  const answer = answers.length === 0 ? "allow" : answers[0];
  const output: string[] = [];
  const errors: string[] = [];
  const value: CliIo = {
    output: (line) => output.push(line),
    error: (line) => errors.push(line),
    readApproval: async () => answer,
  };
  return { io: value, output, errors };
}

describe("runCli", () => {
  it("prints the version", async () => {
    const capture = io();
    expect(await runCli(["--version"], capture.io)).toBe(0);
    expect(capture.output.join("\n")).toMatch(/officehum 0\.0\.0.*1\.0\.2/);
  });

  it("rejects unknown commands and options", async () => {
    const first = io();
    expect(await runCli(["wat"], first.io)).toBe(2);
    const second = io();
    expect(await runCli(["bookings", "--wat"], second.io)).toBe(2);
    expect(second.errors.join("\n")).toContain("Unknown option");
  });

  it("requires an explicit request id for live start", async () => {
    const capture = io();
    expect(await runCli(["start", "--message", "Book Guest on 2030-01-15"], capture.io)).toBe(2);
    expect(capture.errors.join("\n")).toContain("--request-id");
  });

  it("runs deterministic allow and deny demos and lists bookings without credentials", async () => {
    const allowedState = state();
    const allowed = io();
    expect(await runCli(["demo", "--state", allowedState, "--approval", "allow"], allowed.io)).toBe(
      0,
    );
    expect(allowed.output.join("\n")).toContain("synthetic");
    const listing = io();
    expect(await runCli(["bookings", "--state", allowedState], listing.io)).toBe(0);
    expect(listing.output.join("\n")).toContain("2030-01-15T09:00:00Z");

    const deniedState = state();
    const denied = io();
    expect(await runCli(["demo", "--state", deniedState, "--approval", "deny"], denied.io)).toBe(0);
    const deniedListing = io();
    expect(await runCli(["bookings", "--state", deniedState], deniedListing.io)).toBe(0);
    expect(deniedListing.output.join("\n")).toContain("No bookings");
  });

  it("fails missing live credentials before admitting input", async () => {
    const directory = state();
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const capture = io();
      expect(
        await runCli(
          [
            "start",
            "--state",
            directory,
            "--message",
            "Book Guest on 2030-01-15",
            "--request-id",
            "live-1",
          ],
          capture.io,
        ),
      ).toBe(1);
      expect(capture.errors.join("\n")).toContain("OPENAI_API_KEY");
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
    const listing = io();
    await runCli(["bookings", "--state", directory], listing.io);
    expect(listing.output.join("\n")).toContain("No bookings");
  });

  it("interrupts approval on EOF without recording consent", async () => {
    const directory = state();
    const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
    const eof = io(undefined);
    const cancellation = withCancel(BACKGROUND_CONTEXT);
    const approver = cliApprover(calendar, undefined, eof.io, () => {
      cancellation.cancel(new Error("approval input ended"));
    });
    await expect(
      approver(
        {
          approvalId: "confirm_booking",
          description: "Confirm booking",
          tool: "book_appointment",
          arguments: { start: "2030-01-15T09:00:00Z", customer: "Demo Guest" },
          conversationId: "conversation",
          taskId: "task",
          callId: "call",
        },
        cancellation.context,
      ),
    ).rejects.toThrow("approval input ended");
    expect(calendar.decision("conversation:task:call:confirm_booking")).toBeUndefined();
    calendar.close();
  });
});
