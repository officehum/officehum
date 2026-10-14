import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { awaitWithContext, BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import frontdesk from "@officehum/frontdesk";
import { createDemoModels, openLocalCalendar, openSolo } from "@officehum/office";
import { afterEach, describe, expect, it } from "vitest";
import { type CliIo, cliApprover, runCli } from "./cli.js";
import { createTerminalIo } from "./terminal-io.js";

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

async function entryCount(directory: string): Promise<number> {
  const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
  const role = frontdesk({ calendar });
  const solo = await openSolo({ directory, role, ...createDemoModels() });
  try {
    return (await solo.root.context(BACKGROUND_CONTEXT)).entries.length;
  } finally {
    await solo.close();
    calendar.close();
  }
}

async function createLiveState(directory: string, modelId = "gpt-6-sol"): Promise<void> {
  const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
  const role = frontdesk({ calendar });
  const faux = fauxProvider({ provider: "openai", models: [{ id: modelId }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const solo = await openSolo({
    directory,
    role,
    models,
    model: { provider: "openai", modelId },
  });
  await solo.close();
  calendar.close();
}

async function createPendingDemo(directory: string): Promise<string> {
  const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
  let reached!: () => void;
  const barrier = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const role = frontdesk({
    calendar,
    approve: async (_request, context) => {
      reached();
      await awaitWithContext(new Promise<never>(() => {}), context);
      return { approved: true };
    },
  });
  const solo = await openSolo({ directory, role, ...createDemoModels() });
  const pending = solo.submit("Book Demo Guest on 2030-01-15", "terminal-pending");
  await barrier;
  const [record] = (await solo.harness.inspect(BACKGROUND_CONTEXT)).submissions;
  if (record === undefined) throw new Error("Expected a pending submission");
  await solo.close();
  await pending.catch(() => {});
  calendar.close();
  return String(record.id);
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

  it("rejects demo-to-live state reuse before adding a submission", async () => {
    const directory = state();
    expect(await runCli(["demo", "--state", directory], io().io)).toBe(0);
    const before = await entryCount(directory);
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-only-placeholder";
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
            "live-after-demo",
          ],
          capture.io,
        ),
      ).toBe(1);
      expect(capture.errors.join("\n")).toMatch(/synthetic demo.*fresh --state/i);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
    expect(await entryCount(directory)).toBe(before);
  });

  it("rejects live-to-demo state reuse and labels the persisted live model", async () => {
    const directory = state();
    await createLiveState(directory, "gpt-6.1-sol");
    const before = await entryCount(directory);
    const demo = io();
    expect(await runCli(["demo", "--state", directory], demo.io)).toBe(1);
    expect(demo.errors.join("\n")).toMatch(/live OpenAI.*fresh --state/i);
    expect(await entryCount(directory)).toBe(before);

    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-only-placeholder";
    try {
      const resumed = io();
      expect(await runCli(["resume", "--state", directory], resumed.io)).toBe(0);
      expect(resumed.output.join("\n")).toContain("Mode: live OpenAI (gpt-6.1-sol)");
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it.each([
    ["Aborted with Ctrl+D", "eof"],
    ["Aborted with Ctrl+C", "sigint"],
  ] as const)("keeps the original request pending after %s", async (message, kind) => {
    const directory = state();
    const submissionId = await createPendingDemo(directory);
    const stream = Object.assign(new PassThrough(), { isTTY: true });
    const interruptions: string[] = [];
    const terminalIo = createTerminalIo({
      input: stream,
      output: stream,
      error: stream,
      onInterrupt: (value) => interruptions.push(value),
      open: () => ({
        question: async () => {
          throw new Error(message);
        },
        close: () => {},
      }),
    });
    expect(await runCli(["resume", "--state", directory], terminalIo)).toBe(1);
    expect(interruptions).toEqual([kind]);
    const before = openLocalCalendar(join(directory, "calendar.sqlite"));
    expect(before.bookings()).toEqual([]);
    before.close();

    const resumed = io();
    const resumeCode = await runCli(
      ["resume", "--state", directory, "--approval", "allow"],
      resumed.io,
    );
    expect({ code: resumeCode, errors: resumed.errors.join("\n") }).toEqual({
      code: 0,
      errors: "",
    });
    expect(resumed.output.join("\n")).toContain(`Submission: ${submissionId}`);
    const after = openLocalCalendar(join(directory, "calendar.sqlite"));
    expect(after.bookings()).toHaveLength(1);
    after.close();
  });
});
