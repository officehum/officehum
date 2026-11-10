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
import {
  operatorSender,
  parseRunArguments,
  readClientConfig,
  requestIdFor,
  terminalApprover,
  terminalUser,
} from "./run.js";

const sampleDesk = fileURLToPath(new URL("../../sdk/fixtures/sample-desk", import.meta.url));
const sampleStockroom = fileURLToPath(
  new URL("../../sdk/fixtures/sample-stockroom", import.meta.url),
);
const clientsFile = fileURLToPath(new URL("./fixtures/clients.json", import.meta.url));
const peopleOps = fileURLToPath(new URL("../../../agents/people-ops", import.meta.url));
const sales = fileURLToPath(new URL("../../../agents/sales", import.meta.url));
/** The first person on the company record generated into the People Ops package. */
const colleague = (
  JSON.parse(
    readFileSync(join(peopleOps, "skills/company-handbook/references/facts.json"), "utf8"),
  ) as { people: { id: string; name: string; email: string }[] }
).people[0] as { id: string; name: string; email: string };
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

describe("officehum run --as", () => {
  /** A model that asks for the sender's own leave balance, then repeats what the tool said. */
  const balanceModel = () =>
    scriptedProvider((messages) => {
      const result = messages.find((message) => message.role === "toolResult");
      if (result === undefined) return { toolCalls: [{ name: "get_leave_balance", args: {} }] };
      const text = (result.content as { type: string; text?: string }[])
        .map((part) => part.text ?? "")
        .join("");
      return { text: `TOOL SAID: ${text}` };
    });

  const runPeopleOps = async (extra: readonly string[]) => {
    const directory = temporary();
    const terminal = scripted(["What is my leave balance?", undefined]);
    const code = await runCli(
      [
        "run",
        peopleOps,
        "--model",
        "scripted/scripted-1",
        "--db",
        join(directory, "office.sqlite"),
        "--demo",
        ...extra,
      ],
      terminal.io,
      runDeps(balanceModel()),
    );
    return { code, output: terminal.output.join("\n"), errors: terminal.errors.join("\n") };
  };

  it("gives the role the operator as an internal sender, by person id", async () => {
    const run = await runPeopleOps(["--as", colleague.id]);
    expect({ code: run.code, errors: run.errors }).toEqual({ code: 0, errors: "" });
    expect(run.output).toContain(`Sender: ${colleague.name} (${colleague.id}), at this terminal`);
    expect(run.output).toContain(`TOOL SAID: Leave for ${colleague.name} (the sender)`);
    expect(run.output).not.toContain("Nobody verified");
  }, 20_000);

  it("leaves the sender unknown without --as, and says so", async () => {
    const run = await runPeopleOps([]);
    expect(run.code).toBe(0);
    expect(run.output).toContain("Sender: unknown");
    expect(run.output).toContain("--as");
    expect(run.output).toContain("TOOL SAID: Nobody verified who sent this");
  }, 20_000);

  // A wrong --as is a usage error (exit 2), refused before any role code runs.
  it("refuses someone the company record does not name, and says how to fix it", async () => {
    const run = await runPeopleOps(["--as", "nobody@example.com"]);
    expect(run.code).toBe(2);
    expect(run.errors).toContain('--as "nobody@example.com" is not anyone on the company record');
    expect(run.errors).toContain(colleague.id);
    expect(run.output).not.toContain("TOOL SAID");
  }, 20_000);

  it("refuses --as for a role package with no company record", async () => {
    const terminal = scripted([undefined]);
    const code = await runCli(
      ["run", sampleDesk, "--model", "scripted/scripted-1", "--as", colleague.id],
      terminal.io,
      runDeps(scriptedProvider([])),
    );
    expect(code).toBe(2);
    expect(terminal.errors.join("\n")).toContain("has no company record");
  });

  it("matches the operator by email too, and always passes their person id", async () => {
    const { sender, person } = operatorSender(peopleOps, colleague.email.toUpperCase());
    expect(person.id).toBe(colleague.id);
    expect(await sender({ conversationId: "1", taskId: "1" })).toEqual({
      origin: "internal",
      channel: "terminal",
      contact: colleague.id,
    });
  });

  it("parses --as once, with a value", () => {
    expect(parseRunArguments([sampleDesk, "--as", "x"]).as).toBe("x");
    expect(parseRunArguments([sampleDesk]).as).toBeUndefined();
    expect(() => parseRunArguments([sampleDesk, "--as"])).toThrow("--as requires a value");
  });
});

describe("officehum run --demo", () => {
  const runSales = async (extra: readonly string[]) => {
    const directory = temporary();
    const terminal = scripted([undefined]);
    const code = await runCli(
      [
        "run",
        sales,
        "--model",
        "scripted/scripted-1",
        "--db",
        join(directory, "office.sqlite"),
        ...extra,
      ],
      terminal.io,
      runDeps(scriptedProvider([])),
    );
    return { code, output: terminal.output.join("\n"), errors: terminal.errors.join("\n") };
  };

  it("says the role runs on its demonstration data with --demo", async () => {
    const run = await runSales(["--demo"]);
    expect({ code: run.code, errors: run.errors }).toEqual({ code: 0, errors: "" });
    expect(run.output).toContain("Desk: demonstration data (--demo)");
  });

  it("says no desk is bound, and how to bind one, without --demo or a desk client", async () => {
    const run = await runSales([]);
    expect({ code: run.code, errors: run.errors }).toEqual({ code: 0, errors: "" });
    expect(run.output).toContain("Desk: none bound (a role that keeps records refuses until you pass --demo or a desk in --clients)");
  });

  it("says nothing new when --clients binds a desk", async () => {
    const directory = temporary();
    await writeFile(join(directory, "desk.mjs"), "export default () => ({});\n");
    const clients = join(directory, "clients.json");
    await writeFile(clients, JSON.stringify({ desk: { module: "./desk.mjs" } }));
    const run = await runSales(["--clients", clients, "--demo"]);
    expect({ code: run.code, errors: run.errors }).toEqual({ code: 0, errors: "" });
    expect(run.output).not.toContain("Desk:");
  });

  it("parses --demo as a flag with no value", () => {
    expect(parseRunArguments([sampleDesk, "--demo"]).demo).toBe(true);
    expect(parseRunArguments([sampleDesk, "--demo", "--as", "x"])).toMatchObject({
      demo: true,
      as: "x",
    });
    expect(parseRunArguments([sampleDesk]).demo).toBeUndefined();
  });
});
