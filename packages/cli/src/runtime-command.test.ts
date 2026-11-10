import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import type { createModels } from "@earendil-works/pi-ai/models";
import type { ModelRef } from "@earendil-works/pi-durable";
import { scriptedProvider } from "@officehum/office/testing";
import { LineDecoder } from "@officehum/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CliIo, runCli } from "./cli.js";
import { parseRuntimeArguments } from "./runtime-command.js";
import { UsageError } from "./usage-error.js";

const sales = fileURLToPath(new URL("../../../agents/sales", import.meta.url));
const principal = { id: "ada", roles: ["staff"] };

const temps: string[] = [];
afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

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
});
