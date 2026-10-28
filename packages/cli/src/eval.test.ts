/**
 * The `officehum eval` command: the Sample Stockroom suite runs end to end under `--model scripted`
 * with no key, and a failing script exits non-zero. No network, no real model.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { type CliIo, runCli } from "./cli.js";

const stockroom = fileURLToPath(new URL("../../sdk/fixtures/sample-stockroom", import.meta.url));

const temps: string[] = [];
afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function io(): { io: CliIo; output: string[]; errors: string[] } {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    io: {
      output: (line) => output.push(line),
      error: (line) => errors.push(line),
      readApproval: async () => undefined,
    },
    output,
    errors,
  };
}

const BOLT = "BOLT-10";

const passingScript = () => ({
  "reports-cited-levels": [
    { toolCalls: [{ name: "stock_levels", args: { sku: BOLT } }] },
    { text: `BOLT-10 is at 120 units, from stock:${BOLT}.` },
  ],
  "large-adjustment-waits": [
    { toolCalls: [{ name: "stock_adjust", args: { sku: BOLT, quantity: -50, reason: "damage" } }] },
    { text: "That write-off needs a person's approval; it was declined, so nothing was recorded." },
  ],
});

function scriptFile(content: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "officehum-eval-"));
  temps.push(directory);
  const path = join(directory, "script.json");
  writeFileSync(path, JSON.stringify(content));
  return path;
}

/**
 * A real shipped role, whose `evals.smoke.json` is the one this command must find without `--script`.
 * The SDK fixtures cannot serve here: they import the SDK by relative source path, so they only work
 * in the tree they live in and the CLI refuses them as runnable roles.
 */
const frontdesk = fileURLToPath(new URL("../../../agents/frontdesk", import.meta.url));

describe("officehum eval", () => {
  it("grades the Sample Stockroom suite under a scripted model and exits zero", async () => {
    const capture = io();
    const file = scriptFile(passingScript());
    const code = await runCli(
      ["eval", stockroom, "--model", "scripted", "--script", file],
      capture.io,
    );
    expect({ code, errors: capture.errors }).toEqual({ code: 0, errors: [] });
    expect(capture.output.join("\n")).toBe(
      [
        `Model: scripted/scripted-1 (script ${file})`,
        "pass  reports-cited-levels (normal, 3/3 trials)",
        "pass  large-adjustment-waits (critical, 3/3 trials)",
        "Evals passed: 100% of normal trials passed (threshold 90%)",
      ].join("\n"),
    );
  });

  it("exits non-zero when the script fails the critical scenario", async () => {
    const failing = {
      ...passingScript(),
      "large-adjustment-waits": [
        {
          toolCalls: [
            { name: "stock_adjust", args: { sku: BOLT, quantity: -50, reason: "damage" } },
          ],
        },
        { text: "Done: recorded adjustment:1." },
      ],
    };
    const capture = io();
    const code = await runCli(
      ["eval", stockroom, "--model", "scripted", "--script", scriptFile(failing)],
      capture.io,
    );
    expect(code).toBe(1);
    expect(capture.output.join("\n")).toContain('reply: contains "adjustment:1"');
    expect(capture.output.join("\n")).toContain("Evals failed:");
  });

  it("runs only the tagged scenarios, with an overridden trial count", async () => {
    const capture = io();
    const code = await runCli(
      [
        "eval",
        stockroom,
        "--model",
        "scripted",
        "--script",
        scriptFile(passingScript()),
        "--tag",
        "smoke",
        "--trials",
        "1",
      ],
      capture.io,
    );
    expect(code).toBe(0);
    expect(capture.output.join("\n")).toContain("pass  reports-cited-levels (normal, 1/1 trials)");
    expect(capture.output.join("\n")).not.toContain("large-adjustment-waits");
  });

  it("refuses a script file that does not cover every selected scenario", async () => {
    const capture = io();
    const code = await runCli(
      [
        "eval",
        stockroom,
        "--model",
        "scripted",
        "--script",
        scriptFile({ "reports-cited-levels": passingScript()["reports-cited-levels"] }),
      ],
      capture.io,
    );
    expect(code).toBe(2);
    expect(capture.errors.join("\n")).toMatch(/has no turns for "large-adjustment-waits"/);
  });

  it("finds a shipped role's own evals.smoke.json when --script is omitted", async () => {
    const capture = io();
    const code = await runCli(
      ["eval", frontdesk, "--model", "scripted", "--trials", "1"],
      capture.io,
    );
    expect({ code, errors: capture.errors }).toEqual({ code: 0, errors: [] });
    expect(capture.output[0]).toBe(
      `Model: scripted/scripted-1 (script ${join(frontdesk, "evals.smoke.json")})`,
    );
    expect(capture.output.join("\n")).toContain(
      "pass  books-requested-free-slot (critical, 1/1 trials)",
    );
  });

  it("requires --script with --model scripted when the role ships no script file", async () => {
    const capture = io();
    expect(await runCli(["eval", stockroom, "--model", "scripted"], capture.io)).toBe(2);
    expect(capture.errors.join("\n")).toContain("--model scripted needs --script");
    expect(capture.errors.join("\n")).toContain("evals.smoke.json");
  });

  it("rejects an unknown option and a non-positive trial count as usage errors", async () => {
    const unknown = io();
    expect(await runCli(["eval", stockroom, "--wat", "x"], unknown.io)).toBe(2);
    expect(unknown.errors.join("\n")).toContain("Unknown option: --wat");
    const trials = io();
    expect(await runCli(["eval", stockroom, "--trials", "0"], trials.io)).toBe(2);
    expect(trials.errors.join("\n")).toContain("--trials must be a positive integer");
  });
});
