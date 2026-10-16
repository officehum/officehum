import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { createModels } from "@earendil-works/pi-ai/models";
import type { ModelRef } from "@earendil-works/pi-durable";
import { scriptedProvider } from "@officehum/office/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { CliDependencies, CliIo } from "./cli.js";
import { runCli } from "./cli.js";
import { readClientConfig, requestIdFor, terminalApprover, terminalUser } from "./run.js";

const sampleDesk = fileURLToPath(new URL("../../sdk/fixtures/sample-desk", import.meta.url));
const sampleStockroom = fileURLToPath(
  new URL("../../sdk/fixtures/sample-stockroom", import.meta.url),
);
const clientsFile = fileURLToPath(new URL("./fixtures/clients.json", import.meta.url));
const temps: string[] = [];
afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const temporary = () => {
  const directory = mkdtempSync(join(tmpdir(), "officehum-run-"));
  temps.push(directory);
  return directory;
};

/** A terminal that hands out queued lines and approval answers. */
function scripted(lines: (string | undefined)[], answers: (string | undefined)[] = []) {
  const output: string[] = [];
  const errors: string[] = [];
  const io: CliIo = {
    output: (line) => output.push(line),
    error: (line) => errors.push(line),
    readLine: async () => lines.shift(),
    readApproval: async () => answers.shift(),
  };
  return { io, output, errors };
}

const approval = {
  approvalId: "book_after_hours",
  description: "Bookings that start at 18:00 or later",
  tool: "book_appointment",
  arguments: { start: "2030-01-15T18:00", customer: "Guest" },
  conversationId: "1",
  taskId: "1",
  callId: "call-1",
};

/** Test dependencies: the scripted provider as the run command's models. */
function runDeps(model: ReturnType<typeof scriptedProvider>): CliDependencies {
  return {
    createRunModels: (ref: ModelRef) => ({
      models: model.models as ReturnType<typeof createModels>,
      model: ref,
    }),
  };
}

describe("terminalApprover", () => {
  it("prints the approval and approves only on an explicit y", async () => {
    const yes = scripted([], ["y"]);
    await expect(terminalApprover(yes.io)(approval, BACKGROUND_CONTEXT)).resolves.toEqual({
      approved: true,
      by: terminalUser(),
    });
    expect(yes.output.join("\n")).toContain("Bookings that start at 18:00 or later");
    expect(yes.output.join("\n")).toContain('"customer":"Guest"');
    expect(yes.output.join("\n")).toContain("book_appointment");
  });

  it("declines on n, end of input, and anything it does not recognize", async () => {
    for (const answer of ["n", undefined, "maybe"]) {
      const capture = scripted([], [answer]);
      const decision = await terminalApprover(capture.io)(approval, BACKGROUND_CONTEXT);
      expect(decision.approved).toBe(false);
      expect(decision.by).toBe(terminalUser());
    }
    const blank = scripted([], [""]);
    expect((await terminalApprover(blank.io)(approval, BACKGROUND_CONTEXT)).approved).toBe(false);
  });
});

describe("officehum run", () => {
  it("submits a line, runs the gated tool once when the operator says y", async () => {
    const directory = temporary();
    const log = join(directory, "booked.log");
    process.env.OFFICEHUM_TEST_BOOK_LOG = log;
    const scriptedModel = scriptedProvider([
      {
        toolCalls: [
          { name: "book_appointment", args: { start: "2030-01-15T18:00", customer: "Guest" } },
        ],
      },
      { text: "Booked for the guest." },
    ]);
    const terminal = scripted(["Book the guest for 2030-01-15T18:00", undefined], ["y"]);
    try {
      const code = await runCli(
        [
          "run",
          sampleDesk,
          "--model",
          "scripted/scripted-1",
          "--clients",
          clientsFile,
          "--db",
          join(directory, "office.sqlite"),
        ],
        terminal.io,
        runDeps(scriptedModel),
      );
      expect({ code, errors: terminal.errors }).toEqual({ code: 0, errors: [] });
      expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
      expect(terminal.output.join("\n")).toContain("Booked for the guest.");
      expect(existsSync(join(directory, "office.sqlite"))).toBe(true);
    } finally {
      delete process.env.OFFICEHUM_TEST_BOOK_LOG;
    }
  }, 20_000);

  it("blocks the gated tool when the operator says n", async () => {
    const directory = temporary();
    const log = join(directory, "booked.log");
    process.env.OFFICEHUM_TEST_BOOK_LOG = log;
    const scriptedModel = scriptedProvider([
      {
        toolCalls: [
          { name: "book_appointment", args: { start: "2030-01-15T18:00", customer: "Guest" } },
        ],
      },
      { text: "I could not book that." },
    ]);
    const terminal = scripted(["Book the guest for 2030-01-15T18:00", undefined], ["n"]);
    try {
      const code = await runCli(
        [
          "run",
          sampleDesk,
          "--model",
          "scripted/scripted-1",
          "--clients",
          clientsFile,
          "--db",
          join(directory, "office.sqlite"),
        ],
        terminal.io,
        runDeps(scriptedModel),
      );
      expect(code).toBe(0);
      expect(existsSync(log)).toBe(false);
      expect(terminal.output.join("\n")).toContain("I could not book that.");
    } finally {
      delete process.env.OFFICEHUM_TEST_BOOK_LOG;
    }
  }, 20_000);

  it("lists and runs the manifest's operator commands without a model", async () => {
    const directory = temporary();
    const scriptedModel = scriptedProvider([{ text: "unused" }]);
    const terminal = scripted(["/commands", "/stock-board", "/reload", undefined]);
    const code = await runCli(
      [
        "run",
        sampleStockroom,
        "--model",
        "scripted/scripted-1",
        "--data",
        join(directory, "data"),
        "--work",
        join(directory, "work"),
        "--db",
        join(directory, "office.sqlite"),
      ],
      terminal.io,
      runDeps(scriptedModel),
    );
    expect(code).toBe(0);
    expect(terminal.output.join("\n")).toContain("stock-board: Show stock on hand for every SKU");
    expect(terminal.output.join("\n")).toContain('"BOLT-10": 120');
    expect(terminal.output.join("\n")).toContain("Reloaded the role's files and overlays.");
  }, 20_000);

  it("reports an unknown operator command and stays running", async () => {
    const directory = temporary();
    const scriptedModel = scriptedProvider([{ text: "unused" }]);
    const terminal = scripted(["/wat", undefined]);
    const code = await runCli(
      [
        "run",
        sampleStockroom,
        "--model",
        "scripted/scripted-1",
        "--db",
        join(directory, "o.sqlite"),
      ],
      terminal.io,
      runDeps(scriptedModel),
    );
    expect(code).toBe(0);
    expect(terminal.errors.join("\n")).toContain("Unknown command: /wat");
  }, 20_000);

  it("refuses a role package whose Pi Durable peer range excludes this release", async () => {
    const directory = await mkdtemp(join(tmpdir(), "officehum-run-pkg-"));
    temps.push(directory);
    await cp(sampleDesk, directory, { recursive: true });
    const pkgPath = join(directory, "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as Record<string, unknown>;
    pkg.peerDependencies = {
      "@earendil-works/pi-ai": "1.0.x",
      "@earendil-works/pi-durable": "1.0.x",
    };
    await writeFile(pkgPath, JSON.stringify(pkg));
    const terminal = scripted([undefined]);
    const code = await runCli(
      ["run", directory, "--model", "scripted/scripted-1"],
      terminal.io,
      runDeps(scriptedProvider([])),
    );
    expect(code).toBe(1);
    expect(terminal.errors.join("\n")).toContain("supports Pi Durable 1.0.x");
  });

  it("rejects a provider it cannot run before loading any role", async () => {
    const terminal = scripted([undefined]);
    const code = await runCli(["run", sampleDesk, "--model", "wat/thing"], terminal.io);
    expect(code).toBe(1);
    expect(terminal.errors.join("\n")).toContain("runs paper or openai models");
  });

  it("rejects a --clients file that would carry a credential", async () => {
    const directory = await mkdtemp(join(tmpdir(), "officehum-run-clients-"));
    temps.push(directory);
    const file = join(directory, "clients.json");
    await writeFile(file, JSON.stringify({ calendar: { module: "./x.mjs", apiKey: "secret" } }));
    await expect(readClientConfig(file)).rejects.toThrow(/only "module" and "export" are allowed/);
  });

  it("hashes the line and its position into the request id", () => {
    expect(requestIdFor("hello", 0)).toBe(requestIdFor("hello", 0));
    expect(requestIdFor("hello", 0)).not.toBe(requestIdFor("hello", 1));
    expect(requestIdFor("hello", 0)).not.toBe(requestIdFor("other", 0));
  });
});
