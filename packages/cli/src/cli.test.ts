/**
 * The one-agent command line: what it lists, and `verify-role`. The office's commands, run through
 * the same dispatcher, are tested with the office's command line.
 */

import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { type CliIo, runCli } from "./cli.js";

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

describe("runCli without a host", () => {
  it("lists only the one-agent commands, and a host's command is unknown", async () => {
    const listed = io();
    expect(await runCli([], listed.io)).toBe(2);
    const usage = listed.errors.join("\n");
    for (const command of ["run", "eval", "judge-check", "verify-role", "review list"]) {
      expect(usage).toContain(`officehum ${command} `);
    }
    expect(usage).not.toContain(" runtime");
    expect(usage).not.toContain("--mode bare");
    const office = io();
    expect(await runCli(["runtime"], office.io)).toBe(2);
    expect(office.errors.join("\n")).toContain("Unknown command: runtime");
  });
});

describe("verify-role", () => {
  const validRole = fileURLToPath(new URL("../../sdk/src/fixtures/role-md/valid", import.meta.url));
  const pages: Record<string, string> = {
    "https://example.com/selling":
      "Selling turns interest into agreed deals. A lead is qualified once need, budget, authority and timing are known. Do not overpromise.",
    "https://example.com/quoting":
      "A quote states price, scope and validity. Discounts need sign-off.",
  };

  it("accepts a valid role.md offline without fetching", async () => {
    const capture = io();
    const fetchText = async () => {
      throw new Error("offline mode must not fetch");
    };
    expect(await runCli(["verify-role", validRole], capture.io, { fetchText })).toBe(0);
    expect(capture.output).toEqual(["role.md OK"]);
  });

  it("--online passes when every passage is found", async () => {
    const capture = io();
    const fetchText = async (url: string) => pages[url] ?? "";
    expect(await runCli(["verify-role", validRole, "--online"], capture.io, { fetchText })).toBe(0);
  });

  it("--online exits 1 and names the claim whose passage is gone", async () => {
    const capture = io();
    const fetchText = async (url: string) =>
      (pages[url] ?? "").replace("Discounts need sign-off.", "");
    expect(await runCli(["verify-role", validRole, "--online"], capture.io, { fetchText })).toBe(1);
    expect(capture.output.join("\n")).toContain("claim C4: passage not found");
  });

  it("--online still fetches when the offline check found issues", async () => {
    const directory = state();
    copyFileSync(join(validRole, "role.sources.json"), join(directory, "role.sources.json"));
    copyFileSync(join(validRole, "../uncited-item.md"), join(directory, "role.md"));
    const capture = io();
    const fetched: string[] = [];
    const fetchText = async (url: string) => {
      fetched.push(url);
      return (pages[url] ?? "").replace("Discounts need sign-off.", "");
    };
    expect(await runCli(["verify-role", directory, "--online"], capture.io, { fetchText })).toBe(1);
    expect(fetched.length).toBe(2);
    const text = capture.output.join("\n");
    expect(text).toContain("Responsibilities and actions › line 9");
    expect(text).toContain("claim C4: passage not found");
  });

  it("warns, without failing, on a sending tool that does not declare outside", async () => {
    const directory = state();
    copyFileSync(join(validRole, "role.md"), join(directory, "role.md"));
    copyFileSync(join(validRole, "role.sources.json"), join(directory, "role.sources.json"));
    writeFileSync(
      join(directory, "officehum.json"),
      JSON.stringify({
        tools: [{ name: "send_statement", replay: "unsafe", noApproval: "a fixture" }],
      }),
    );
    const capture = io();
    expect(await runCli(["verify-role", directory], capture.io)).toBe(0);
    expect(capture.output).toEqual([
      'officehum.json › tools[0]: warning: "send_statement" changes something and mentions "send"; if it sends or publishes to people outside the business, declare "outside": true so no overlay can switch its approval off',
      "role.md OK",
    ]);
  });

  it("names the tools the role declares from a tool pack its office supplies", async () => {
    const directory = state();
    copyFileSync(join(validRole, "role.md"), join(directory, "role.md"));
    copyFileSync(join(validRole, "role.sources.json"), join(directory, "role.sources.json"));
    writeFileSync(
      join(directory, "officehum.json"),
      JSON.stringify({
        tools: [
          { name: "list_periods", replay: "safe" },
          { name: "data_inspect", replay: "safe", pack: "data", description: "Looks at a file." },
          { name: "data_query", replay: "safe", pack: "data", description: "Asks a question." },
        ],
      }),
    );
    const capture = io();
    expect(await runCli(["verify-role", directory], capture.io)).toBe(0);
    expect(capture.output).toEqual([
      "officehum.json: data_inspect, data_query come from the office's data pack; the role offers them only where its office gives it that pack",
      "role.md OK",
    ]);
  });

  it("checks a directory holding only role.md and role.sources.json, with no package", async () => {
    // A role is researched before its package exists: no package.json, no officehum.json.
    const directory = state();
    copyFileSync(join(validRole, "role.md"), join(directory, "role.md"));
    copyFileSync(join(validRole, "role.sources.json"), join(directory, "role.sources.json"));
    expect(existsSync(join(directory, "package.json"))).toBe(false);
    expect(existsSync(join(directory, "officehum.json"))).toBe(false);
    const offline = io();
    expect(await runCli(["verify-role", directory], offline.io)).toBe(0);
    expect(offline.output).toEqual(["role.md OK"]);
    const online = io();
    const fetchText = async (url: string) => pages[url] ?? "";
    expect(await runCli(["verify-role", directory, "--online"], online.io, { fetchText })).toBe(0);
    expect(online.output).toEqual(["role.md OK (online)"]);
  });

  it("exits 1 with the offline issues for a broken role.md", async () => {
    const directory = state();
    copyFileSync(join(validRole, "role.sources.json"), join(directory, "role.sources.json"));
    copyFileSync(join(validRole, "../uncited-item.md"), join(directory, "role.md"));
    const capture = io();
    expect(await runCli(["verify-role", directory], capture.io)).toBe(1);
    expect(capture.output.join("\n")).toContain("Responsibilities and actions › line 9");
  });
});
