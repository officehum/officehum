/** The manifest's CLI declarations and their rules (docs/design/tool-sources.md, sections 3 and 4). */
import { describe, expect, it } from "vitest";
import labelsManifest from "../fixtures/sample-labels/officehum.json" with { type: "json" };
import { formatIssue } from "./issues.js";
import { validateManifest } from "./manifest.js";

type Json = Record<string, unknown>;
const base = (): Json => structuredClone(labelsManifest) as unknown as Json;
const tool = (): Json => structuredClone(labelsManifest.tools[0]) as unknown as Json;
const cli = (): Json => structuredClone(labelsManifest.tools[0]?.cli) as unknown as Json;

/** The fixture manifest with one tool and some fields replaced. */
function manifestWith(fields: Json = {}, toolFields: Json = {}): Json {
  return { ...base(), tools: [{ ...tool(), ...toolFields }], ...fields };
}

/** The fixture's tool with its `cli.args` replaced. */
const argsOf = (args: string[], fields: Json = {}) =>
  manifestWith(fields, { cli: { ...cli(), args } });

/** The fixture's one CLI with its declaration replaced. */
const trackerWith = (declaration: Json) => ({ clis: { tracker: declaration } });

const messages = (value: unknown) => {
  const result = validateManifest(value);
  return result.ok ? [] : result.issues.map(formatIssue);
};

describe("CLI declarations in officehum.json", () => {
  it("accepts the Sample Labels manifest", () => {
    expect(messages(base())).toEqual([]);
  });

  it("requires a CLI tool to state its description and parameters", () => {
    const { description: _description, parameters: _parameters, ...bare } = tool();
    const args = ["label", "list"];
    expect(
      messages({
        ...base(),
        tools: [{ ...bare, cli: { ...cli(), args }, noApproval: "test only" }],
        approvals: [],
      }),
    ).toEqual([
      "officehum.json › tools[0].description: is required for a CLI tool: it is all the model reads about it",
      'officehum.json › tools[0].parameters: are required for a CLI tool, even when empty ("parameters": {}): they are all the model reads about its arguments',
    ]);
  });

  it("refuses a tool whose CLI is not declared", () => {
    expect(messages(manifestWith({}, { cli: { ...cli(), use: "github" } }))).toEqual([
      'officehum.json › tools[0].cli.use: "github" is not declared in clis',
    ]);
  });

  it("refuses a CLI whose program is not a declared runtime", () => {
    expect(messages({ ...base(), runtimes: [] })).toEqual([
      'officehum.json › clis.tracker.command[0]: "node" must be declared in runtimes, e.g. { "name": "node", "version": ">=1.0" }, so hosts know to provide it',
    ]);
  });

  it("accepts a program named by its path, as engines do", () => {
    expect(
      messages({
        ...base(),
        ...trackerWith({ command: ["/usr/bin/env", "./cli/fake-cli.mjs"] }),
      }),
    ).toEqual([]);
  });

  it("refuses a fixed package file that leaves the package", () => {
    expect(
      messages({ ...base(), ...trackerWith({ command: ["node", "./cli/../../secrets.mjs"] }) }),
    ).toEqual([
      'officehum.json › clis.tracker.command[1]: "./cli/../../secrets.mjs" must stay inside the role package; a "./" argument names a file in the package and may not contain ".."',
    ]);
  });

  it("refuses an env entry that is not a variable's name", () => {
    expect(
      messages({
        ...base(),
        ...trackerWith({ command: ["node", "./cli/fake-cli.mjs"], env: ["TOKEN=abc", "OK_NAME"] }),
      }),
    ).toEqual([
      'officehum.json › clis.tracker.env[0]: must be the NAME of an environment variable, like "GH_TOKEN", never a value; the host supplies the value',
    ]);
  });

  it("refuses the office's own secret key in env, in any letter case", () => {
    expect(
      messages({
        ...base(),
        ...trackerWith({
          command: ["node", "./cli/fake-cli.mjs"],
          env: ["OFFICEHUM_SECRET_KEY", "officehum_secret_key"],
        }),
      }),
    ).toEqual([
      "officehum.json › clis.tracker.env[0]: OFFICEHUM_SECRET_KEY is the office's own secret, which no role's program is given",
      "officehum.json › clis.tracker.env[1]: officehum_secret_key is the office's own secret, which no role's program is given",
    ]);
  });

  it("refuses a CLI id that is not kebab-case", () => {
    const declared = base();
    declared.clis = { Tracker: { command: ["node", "./cli/fake-cli.mjs"] } };
    (declared.tools as Json[])[0] = { ...tool(), cli: { ...cli(), use: "Tracker" } };
    expect(messages(declared)).toEqual([
      'officehum.json › clis.Tracker: must be named in kebab-case, like "gh"',
    ]);
  });

  it("refuses a tool that states two sources", () => {
    const engine = { command: ["node", "engine.mjs"] };
    expect(messages(manifestWith({ engine }, { engine: ["label"] }))).toEqual([
      'officehum.json › tools[0]: "add_label" states 2 sources, engine and cli; a tool comes from exactly one (engine, mcp, cli, pack, or code with none)',
    ]);
  });

  it.each([
    ["a flag joined to it", "--issue={issue}"],
    ["two placeholders", "{issue}/{label}"],
    ["text around it", "issue-{issue}"],
  ])("refuses a placeholder with %s", (_label, element) => {
    expect(messages(argsOf(["label", "add", element, "{issue}", "{label}"]))).toEqual([
      `officehum.json › tools[0].cli.args[2]: ${JSON.stringify(element)} embeds a placeholder; a placeholder must be a whole argument, like "{issue}", so its value is passed as exactly one argument`,
    ]);
  });

  it("accepts braces that are not a placeholder, such as a jq filter", () => {
    expect(
      messages(argsOf(["label", "add", "{issue}", "{label}", "--jq", "{number,title}"])),
    ).toEqual([]);
  });

  it("refuses a placeholder that names no declared parameter", () => {
    expect(messages(argsOf(["label", "add", "{issue}", "{label}", "{repo}"]))).toEqual([
      'officehum.json › tools[0].cli.args[4]: "{repo}" names no declared parameter; declare "repo" in parameters, or use {callId} for the call\'s idempotency key',
    ]);
  });

  it("refuses a required parameter that is not in args", () => {
    expect(messages(argsOf(["label", "add", "{label}"]))).toEqual([
      'officehum.json › tools[0].cli.args: never passes the required parameter "issue"; add "{issue}" to args, or make it optional',
    ]);
  });

  it("refuses a parameter called callId, which the SDK fills", () => {
    const parameters = {
      ...(tool().parameters as Json),
      callId: { type: "string", description: "Not the model's to choose" },
    };
    expect(messages(manifestWith({}, { parameters }))).toEqual([
      "officehum.json › tools[0].parameters.callId: \"callId\" is the SDK's placeholder for the call's idempotency key; the model must not be offered it, so choose another name",
    ]);
  });

  it("refuses a parameter name a placeholder could not spell", () => {
    const parameters = {
      ...(tool().parameters as Json),
      "issue-type": { type: "string", description: "Bug or feature" },
    };
    expect(messages(manifestWith({}, { parameters }))).toEqual([
      'officehum.json › tools[0].parameters.issue-type: must be a plain identifier like "repo" or "issueId", so a {placeholder} can name it',
    ]);
  });

  it("refuses an output mode other than json or text, and a timeout that is not positive", () => {
    expect(messages(manifestWith({}, { cli: { ...cli(), output: "yaml" } }))).toEqual([
      'officehum.json › tools[0].cli.output: must be one of "json", "text" (got "yaml")',
    ]);
    expect(messages(manifestWith({}, { cli: { ...cli(), timeoutSeconds: 0 } }))).toEqual([
      "officehum.json › tools[0].cli.timeoutSeconds: must be > 0",
    ]);
  });

  it("applies the approval rules to a CLI tool's declared parameters", () => {
    const approvals = [
      {
        id: "protected_label",
        tool: "add_label",
        description: "Release labels page people",
        when: [{ arg: "colour", op: "eq", value: "red" }],
      },
    ];
    expect(messages({ ...base(), approvals })).toEqual([
      'officehum.json › approvals[0].when[0].arg: "colour" is not a parameter of "add_label"',
    ]);
  });

  it("reports every problem at once, each with its path", () => {
    expect(
      messages(
        manifestWith(
          { runtimes: [] },
          { cli: { use: "github", args: ["--repo={repo}", "{nope}"], output: "json" } },
        ),
      ),
    ).toEqual([
      'officehum.json › clis.tracker.command[0]: "node" must be declared in runtimes, e.g. { "name": "node", "version": ">=1.0" }, so hosts know to provide it',
      'officehum.json › tools[0].cli.use: "github" is not declared in clis',
      'officehum.json › tools[0].cli.args[0]: "--repo={repo}" embeds a placeholder; a placeholder must be a whole argument, like "{issue}", so its value is passed as exactly one argument',
      'officehum.json › tools[0].cli.args[1]: "{nope}" names no declared parameter; declare "nope" in parameters, or use {callId} for the call\'s idempotency key',
      'officehum.json › tools[0].cli.args: never passes the required parameter "issue"; add "{issue}" to args, or make it optional',
      'officehum.json › tools[0].cli.args: never passes the required parameter "label"; add "{label}" to args, or make it optional',
    ]);
  });
});
