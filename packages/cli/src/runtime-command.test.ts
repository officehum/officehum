import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import type { Message } from "@earendil-works/pi-ai";
import type { createModels } from "@earendil-works/pi-ai/models";
import type { ModelRef } from "@earendil-works/pi-durable";
import { openOfficeBoard } from "@officehum/office/board";
import { scriptedProvider } from "@officehum/office/testing";
import { LineDecoder } from "@officehum/protocol";
import { localVersionedFileStore } from "@officehum/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CliIo, runCli } from "./cli.js";
import { parseRuntimeArguments } from "./runtime-command.js";
import { UsageError } from "./usage-error.js";

const sales = fileURLToPath(new URL("../../../agents/sales", import.meta.url));
const officeManager = fileURLToPath(new URL("../../../agents/office-manager", import.meta.url));
const bookkeeper = fileURLToPath(new URL("../../../agents/bookkeeper", import.meta.url));
const frontdesk = fileURLToPath(new URL("../../../agents/frontdesk", import.meta.url));
const principal = { id: "ada", roles: ["staff"] };

const temps: string[] = [];
afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/**
 * One `officehum runtime` over a directory's files, driven by a scripted model. `flags` are added to
 * the command line (`--demo`, `--board FILE`), and `dependencies` reach the CLI as a host's would.
 */
function startRuntime(
  directory: string,
  officeFile: string,
  script: Parameters<typeof scriptedProvider>[0],
  flags: readonly string[] = [],
  dependencies: Omit<NonNullable<Parameters<typeof runCli>[2]>, "createRunModels" | "stdio"> = {},
) {
  const scripted = scriptedProvider(script);
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: Record<string, unknown>[] = [];
  const decoder = new LineDecoder();
  output.on("data", (chunk: Buffer) => {
    for (const frame of decoder.push(chunk)) {
      if (frame.ok) frames.push(frame.value as Record<string, unknown>);
    }
  });
  const log: string[] = [];
  const io: CliIo = {
    output: () => {},
    error: (line) => log.push(line),
    readApproval: async () => undefined,
  };
  const running = runCli(
    [
      "runtime",
      "--db",
      join(directory, "harness.sqlite"),
      "--office",
      officeFile,
      "--model",
      `${scripted.model.provider}/${scripted.model.modelId}`,
      ...flags,
    ],
    io,
    {
      ...dependencies,
      createRunModels: (ref: ModelRef) => ({
        models: scripted.models as ReturnType<typeof createModels>,
        model: ref,
      }),
      stdio: { input, output },
    },
  );
  const send = (frame: object) => input.write(`${JSON.stringify(frame)}\n`);
  const settled = (requestId: string) =>
    vi.waitFor(
      () => {
        const found = frames.find(
          (frame) =>
            frame.type === "event" &&
            frame.requestId === requestId &&
            (frame.event as { kind: string }).kind === "settled",
        );
        if (found === undefined) throw new Error("not settled yet");
        return found.event as { status: string; answer?: string };
      },
      { timeout: 20_000 },
    );
  const stop = async () => {
    input.end();
    expect(await running).toBe(0);
  };
  return { scripted, frames, log, send, settled, stop };
}

/** The text of the last result of `tool` in a transcript, or `undefined` when it has none yet. */
function toolResult(messages: readonly Message[], tool: string): string | undefined {
  const found = messages.findLast(
    (message) => message.role === "toolResult" && message.toolName === tool,
  );
  const content = (found as { content?: readonly { text?: string }[] } | undefined)?.content;
  return content?.map((block) => block.text ?? "").join("");
}

describe("parseRuntimeArguments", () => {
  it("reads the database, office file, model and demo flag", () => {
    expect(
      parseRuntimeArguments([
        "--db",
        "o.sqlite",
        "--office",
        "office.json",
        "--model",
        "p/m",
        "--demo",
      ]),
    ).toEqual({ database: "o.sqlite", officeFile: "office.json", model: "p/m", demo: true });
  });

  it("reads the board file, and refuses the database's own file as the board", () => {
    expect(
      parseRuntimeArguments(["--db", "h.sqlite", "--office", "office.json", "--board", "b.sqlite"]),
    ).toEqual({ database: "h.sqlite", officeFile: "office.json", board: "b.sqlite", demo: false });
    expect(() =>
      parseRuntimeArguments([
        "--db",
        "state/o.sqlite",
        "--office",
        "office.json",
        "--board",
        "./state/o.sqlite",
      ]),
    ).toThrow("--board and --db must be different files");
  });

  it("requires --db and --office, and refuses unknown options", () => {
    expect(() => parseRuntimeArguments(["--db", "o.sqlite"])).toThrow(UsageError);
    expect(() => parseRuntimeArguments(["--db"])).toThrow("--db needs a value");
    expect(() => parseRuntimeArguments(["--port", "1"])).toThrow("Unknown runtime option: --port");
  });
});

describe("officehum runtime", () => {
  it("answers hello and submit on stdio, with stdout carrying frames only", async () => {
    const directory = mkdtempSync(join(tmpdir(), "officehum-runtime-cli-"));
    temps.push(directory);
    const officeFile = join(directory, "office.json");
    writeFileSync(
      officeFile,
      JSON.stringify({ version: 1, id: "office-1", roles: [{ dir: sales }] }),
    );

    const scripted = scriptedProvider([{ text: "Hello from Sales." }]);
    const input = new PassThrough();
    const output = new PassThrough();
    const frames: unknown[] = [];
    const decoder = new LineDecoder();
    output.on("data", (chunk: Buffer) => {
      for (const frame of decoder.push(chunk)) frames.push(frame.ok ? frame.value : frame);
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io: CliIo = {
      output: (line) => stdout.push(line),
      error: (line) => stderr.push(line),
      readApproval: async () => undefined,
    };
    const model = `${scripted.model.provider}/${scripted.model.modelId}`;
    const running = runCli(
      [
        "runtime",
        "--db",
        join(directory, "office.sqlite"),
        "--office",
        officeFile,
        "--model",
        model,
        "--demo",
      ],
      io,
      {
        createRunModels: (ref: ModelRef) => ({
          models: scripted.models as ReturnType<typeof createModels>,
          model: ref,
        }),
        stdio: { input, output },
      },
    );

    input.write(`${JSON.stringify({ type: "hello", version: 1, client: "gateway" })}\n`);
    input.write(
      `${JSON.stringify({
        type: "submit",
        id: "c1",
        agent: "sales",
        requestId: "r1",
        input: { kind: "message", text: "Hello" },
        principal,
      })}\n`,
    );
    await vi.waitFor(
      () => {
        expect(frames).toContainEqual(
          expect.objectContaining({
            type: "event",
            event: { kind: "settled", status: "done", answer: "Hello from Sales." },
          }),
        );
      },
      { timeout: 20_000 },
    );
    input.end();
    expect(await running).toBe(0);

    expect(frames.slice(0, 3)).toEqual([
      { type: "welcome", version: 1, serverId: "office-1" },
      { type: "welcome", version: 1, serverId: "office-1" },
      { type: "accepted", id: "c1", requestId: "ada/r1", disposition: "started" },
    ]);
    expect(stdout).toEqual([]);
    expect(stderr).toContain(`Agent sales: ${model}`);
  }, 30_000);

  it("with --board, loads the company's people and carries a ticket between two agents", async () => {
    const directory = mkdtempSync(join(tmpdir(), "officehum-runtime-cli-"));
    temps.push(directory);
    const officeFile = join(directory, "office.json");
    writeFileSync(
      officeFile,
      JSON.stringify({
        version: 1,
        id: "office-1",
        roles: [{ dir: sales }, { dir: officeManager }],
      }),
    );
    const boardFile = join(directory, "office.sqlite");

    const said = (message: Message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    // Sales hands the request to whoever takes triage and waits; the Office Manager, delivered the
    // ticket, replies on it.
    const scripted = scriptedProvider((messages) => {
      const ticket = messages
        .filter((message) => message.role === "user")
        .map((message) => /TICKET (\S+)/.exec(said(message))?.[1])
        .find((id) => id !== undefined);
      const answered = (tool: string) =>
        messages.find((message) => message.role === "toolResult" && message.toolName === tool);
      if (ticket !== undefined) {
        return answered("agent_reply") === undefined
          ? {
              toolCalls: [
                {
                  name: "agent_reply",
                  args: { ticketId: ticket, result: "Sorted: it is Sales'." },
                },
              ],
            }
          : { text: "Replied on the ticket." };
      }
      const dispatched = answered("agent_dispatch");
      return dispatched === undefined
        ? {
            toolCalls: [
              {
                name: "agent_dispatch",
                args: {
                  type: "triage.request",
                  title: "Whose is this?",
                  detail: "A caller asked about a contract.",
                  wait: true,
                },
              },
            ],
          }
        : { text: `Triage says: ${said(dispatched)}` };
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const frames: unknown[] = [];
    const decoder = new LineDecoder();
    output.on("data", (chunk: Buffer) => {
      for (const frame of decoder.push(chunk)) frames.push(frame.ok ? frame.value : frame);
    });
    const stderr: string[] = [];
    const io: CliIo = {
      output: () => {},
      error: (line) => stderr.push(line),
      readApproval: async () => undefined,
    };
    const running = runCli(
      [
        "runtime",
        "--db",
        join(directory, "harness.sqlite"),
        "--board",
        boardFile,
        "--office",
        officeFile,
        "--model",
        `${scripted.model.provider}/${scripted.model.modelId}`,
        "--demo",
      ],
      io,
      {
        createRunModels: (ref: ModelRef) => ({
          models: scripted.models as ReturnType<typeof createModels>,
          model: ref,
        }),
        stdio: { input, output },
      },
    );

    input.write(
      `${JSON.stringify({
        type: "submit",
        id: "c1",
        agent: "sales",
        requestId: "r1",
        input: { kind: "message", text: "Who handles this?" },
        principal,
      })}\n`,
    );
    // The catalog's `triage.request` asks for a person's confirmation, so the Office Manager's reply
    // does not finish the ticket: the runtime announces it as an approval, and the signed-in person
    // confirms it through the gateway.
    const confirmation = await vi.waitFor(
      () => {
        const found = frames.find(
          (frame) =>
            (frame as { type?: unknown }).type === "approval" &&
            (frame as { approval: { tool: string } }).approval.tool === "agent_reply",
        ) as { approval: { approvalId: string; agent: string; status: string } } | undefined;
        if (found === undefined) throw new Error("no confirmation announced yet");
        return found.approval;
      },
      { timeout: 20_000 },
    );
    expect(confirmation).toMatchObject({ agent: "office-manager", status: "pending" });
    expect(frames).not.toContainEqual(
      expect.objectContaining({ event: expect.objectContaining({ kind: "settled" }) }),
    );
    input.write(
      `${JSON.stringify({
        type: "approve",
        id: "c2",
        approvalId: confirmation.approvalId,
        decision: "approve",
        principal,
      })}\n`,
    );
    await vi.waitFor(
      () => {
        expect(frames).toContainEqual(
          expect.objectContaining({
            type: "event",
            event: {
              kind: "settled",
              status: "done",
              answer: "Triage says: Sorted: it is Sales'.",
            },
          }),
        );
      },
      { timeout: 20_000 },
    );
    input.end();
    expect(await running).toBe(0);
    expect(stderr).toContain(`Board ${boardFile}: 9 people from the company record`);

    // The runtime has closed the board; what it left is the office's record.
    const board = openOfficeBoard(boardFile);
    try {
      expect(board.people()).toHaveLength(9);
      expect(board.people()[0]).toEqual({ id: "dana-whitfield", name: "Dana Whitfield" });
      expect(board.list({ type: "triage.request" })).toEqual([
        expect.objectContaining({
          status: "done",
          createdBy: "sales",
          assignee: "office-manager",
          result: "Sorted: it is Sales'.",
        }),
      ]);
    } finally {
      board.close();
    }
  }, 30_000);

  it("gives Front Desk the local calendar its office file names, and the booking outlives a restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "officehum-runtime-cli-"));
    temps.push(directory);
    const officeFile = join(directory, "office.json");
    writeFileSync(
      officeFile,
      JSON.stringify({
        version: 1,
        id: "office-1",
        roles: [
          {
            dir: frontdesk,
            connections: { calendar: { kind: "local", file: "state/calendar.sqlite" } },
          },
        ],
      }),
    );

    const start = (script: Parameters<typeof scriptedProvider>[0]) =>
      startRuntime(directory, officeFile, script);

    // The model asks the calendar for a free slot and books the first one it is given.
    const first = start((messages) => {
      const booked = toolResult(messages, "book_appointment");
      if (booked !== undefined) return { text: `Booked: ${booked}` };
      const free = toolResult(messages, "check_schedule");
      if (free === undefined) {
        return { toolCalls: [{ name: "check_schedule", args: { date: "2027-03-01" } }] };
      }
      const slot = /Free: ([^,]+)/.exec(free)?.[1] ?? "";
      return {
        toolCalls: [{ name: "book_appointment", args: { start: slot, customer: "Ada Lovelace" } }],
      };
    });
    first.send({
      type: "submit",
      id: "c1",
      agent: "frontdesk",
      requestId: "r1",
      input: { kind: "message", text: "Book Ada in on 1 March." },
      principal,
    });
    // A booking is a gated action: it waits for a person, who approves it through the gateway.
    const asked = await vi.waitFor(
      () => {
        const found = first.frames.find((frame) => frame.type === "approval");
        if (found === undefined) throw new Error("no approval asked yet");
        return found.approval as { approvalId: string; tool: string };
      },
      { timeout: 20_000 },
    );
    expect(asked.tool).toBe("book_appointment");
    first.send({
      type: "approve",
      id: "c2",
      approvalId: asked.approvalId,
      decision: "approve",
      principal,
    });
    const booked = await first.settled("ada/r1");
    expect(booked.status).toBe("done");
    expect(booked.answer).toContain("at 2027-03-01T09:00:00Z");
    await first.stop();

    // A second run over the same files reads the booking back from the calendar the file names.
    const second = start((messages) => {
      const listed = toolResult(messages, "list_bookings");
      return listed === undefined
        ? { toolCalls: [{ name: "list_bookings", args: {} }] }
        : { text: `On the calendar: ${listed}` };
    });
    second.send({
      type: "submit",
      id: "c3",
      agent: "frontdesk",
      requestId: "r2",
      input: { kind: "message", text: "What is booked?" },
      principal,
    });
    const listed = await second.settled("ada/r2");
    expect(listed.answer).toContain("Ada Lovelace");
    expect(listed.answer).toContain("2027-03-01");
    await second.stop();
  });

  it("stops at start, naming the variable, when a named connection's credential is not set", async () => {
    const directory = mkdtempSync(join(tmpdir(), "officehum-runtime-cli-"));
    temps.push(directory);
    const officeFile = join(directory, "office.json");
    writeFileSync(
      officeFile,
      JSON.stringify({
        version: 1,
        id: "office-1",
        roles: [
          {
            dir: frontdesk,
            connections: {
              calendar: { kind: "google", calendarId: "team@example.com", decisions: "g.sqlite" },
            },
          },
        ],
      }),
    );
    const errors: string[] = [];
    const io: CliIo = {
      output: () => {},
      error: (line) => errors.push(line),
      readApproval: async () => undefined,
    };
    const code = await runCli(
      ["runtime", "--db", join(directory, "h.sqlite"), "--office", officeFile],
      io,
      { connections: { env: {} }, stdio: { input: new PassThrough(), output: new PassThrough() } },
    );
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(
      "The office file names connections that need GOOGLE_CALENDAR_ACCESS_TOKEN; set it in the environment before starting the runtime.",
    );
  });

  describe("document tools for a role the office file grants them to", () => {
    const WORKBOOK = {
      output: "close-summary.xlsx",
      sheets: [
        {
          name: "Summary",
          rows: [
            ["Item", "Count"],
            ["Unmatched bank items", 2],
            ["Unpaid bills", 3],
          ],
        },
      ],
    };
    const office = (roles: readonly object[]) => {
      const directory = mkdtempSync(join(tmpdir(), "officehum-runtime-cli-"));
      temps.push(directory);
      const officeFile = join(directory, "office.json");
      writeFileSync(officeFile, JSON.stringify({ version: 1, id: "office-1", roles }));
      return { directory, officeFile };
    };
    const ask = (agent: string, requestId: string) => ({
      type: "submit",
      id: requestId,
      agent,
      requestId,
      input: { kind: "message", text: "Put the close summary in a workbook." },
      principal,
    });
    /** Makes the workbook once, then answers with what the tool said. */
    const makeWorkbook = (messages: readonly Message[]) => {
      const made = toolResult(messages, "create_workbook");
      return made === undefined
        ? { toolCalls: [{ name: "create_workbook", args: WORKBOOK }] }
        : { text: made };
    };

    it("offers the granted formats' typed tools to that role only, under a lease for the task", async () => {
      const { directory, officeFile } = office([
        { dir: bookkeeper, documents: ["xlsx"] },
        { dir: sales },
      ]);
      const leases: unknown[] = [];
      const runtime = startRuntime(directory, officeFile, makeWorkbook, ["--demo"], {
        documents: {
          service: {
            async runDocumentPython(request) {
              leases.push(request.lease);
              return {
                kind: "refused",
                operationId: request.operationId,
                code: "worker-refused",
                message: "a fake service",
              };
            },
          },
        },
      });
      runtime.send(ask("bookkeeper", "r1"));
      await runtime.settled("ada/r1");
      runtime.send({ ...ask("sales", "r2"), input: { kind: "message", text: "Hello" } });
      await runtime.settled("ada/r2");
      await runtime.stop();

      const offered = (agentTool: string) =>
        runtime.scripted.requests
          .map((request) => request.tools.map((tool) => tool.name))
          .find((names) => names.includes(agentTool)) ?? [];
      const books = offered("list_invoices");
      expect(books).toEqual(
        expect.arrayContaining([
          "inspect_workbook",
          "read_workbook",
          "create_workbook",
          "edit_workbook",
          "preview_workbook",
          "compare_workbook",
        ]),
      );
      // Typed tools for the granted format only: no free-form Python, no Word or PowerPoint.
      for (const withheld of ["run_document_python", "create_document", "create_presentation"]) {
        expect(books).not.toContain(withheld);
      }
      expect(offered("create_quote")).not.toContain("create_workbook");

      expect(leases).toHaveLength(1);
      expect(leases[0]).toMatchObject({
        inputs: [],
        outputFormats: ["xlsx"],
        taskId: expect.any(String),
      });
      expect(runtime.log).toContain("Agent bookkeeper: document tools for xlsx (6 tools).");
    });

    it("runs the role without the tools, and says why, when no worker is provisioned", async () => {
      const { directory, officeFile } = office([{ dir: bookkeeper, documents: ["xlsx"] }]);
      const runtime = startRuntime(
        directory,
        officeFile,
        [{ text: "No workbook here." }],
        ["--demo"],
        {
          documents: { env: {} },
        },
      );
      runtime.send(ask("bookkeeper", "r1"));
      expect((await runtime.settled("ada/r1")).answer).toBe("No workbook here.");
      await runtime.stop();
      expect(runtime.scripted.requests[0]?.tools.map((tool) => tool.name)).not.toContain(
        "create_workbook",
      );
      expect(runtime.log.join("\n")).toContain(
        "Agent bookkeeper: the office file grants it document tools, but OFFICEHUM_PAPER_PYTHON is not set, so it runs without them.",
      );
    });

    // The real worker: skipped, visibly, where no interpreter is provisioned. CI provisions one.
    it.skipIf(process.env.OFFICEHUM_PAPER_PYTHON === undefined)(
      "creates a workbook with the real worker, and it is in the office's file store",
      async () => {
        const { directory, officeFile } = office([{ dir: bookkeeper, documents: ["xlsx"] }]);
        const runtime = startRuntime(directory, officeFile, makeWorkbook, ["--demo"]);
        runtime.send(ask("bookkeeper", "r1"));
        const answer = (await runtime.settled("ada/r1")).answer ?? "";
        await runtime.stop();

        const fileId = /file_[0-9A-HJKMNP-TV-Z]{26}/.exec(answer)?.[0];
        expect(fileId, answer).toBeDefined();
        // The store `file` completion evidence reads: the same directory, opened afresh.
        const stored = await localVersionedFileStore(join(directory, "files")).info(fileId ?? "");
        expect(stored).toMatchObject({
          id: fileId,
          name: "close-summary.xlsx",
          metadata: { createdBy: "role:bookkeeper" },
        });
        expect(stored?.size).toBeGreaterThan(0);
      },
      60_000,
    );
  });
});
