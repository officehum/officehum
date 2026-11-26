/**
 * The generated sample-tracker role, run. Not a test of this fixture directory: role-factory's
 * generate tests copy this file into the package the generator writes from `ROLE_SPEC.md` (as
 * `src/runtime.test.ts`, beside the generated `src/index.ts`) and run it there, so every import below
 * resolves the way it does for any role package in the repository.
 *
 * Everything runs on a bare Pi Durable harness with a scripted model: the MCP tool is served by
 * `stubMcp` (no process, no network) and the CLI tool runs the fixture's own `cli/fake-tracker.mjs`,
 * which the test copies into the package with its command pointed at the running Node binary.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { AssistantEntry, createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { piDurableRunner } from "@officehum/runner";
import { type ScriptedTurn, scriptedProvider } from "@officehum/runner/testing";
import {
  type AgentManifest,
  type Approver,
  checkAgent,
  formatIssue,
  formatReport,
  type McpClients,
  runEvals,
  type StubMcpClient,
  stubMcp,
  validatePackage,
} from "@officehum/sdk";
import { afterEach, describe, expect, it } from "vitest";
import manifestJson from "../officehum.json" with { type: "json" };
import sampleTracker, { packageDir } from "./index.js";

const manifest = manifestJson as unknown as AgentManifest;

const clients: StubMcpClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});

/** The tracker's server: the two tools the manifest declares, and one it does not. */
async function trackerServer(): Promise<StubMcpClient> {
  const client = await stubMcp([
    { name: "create_issue", call: "Opened issue 41" },
    { name: "list_issues", call: "No open issues" },
    { name: "delete_issue", call: "Deleted the issue" },
  ]);
  clients.push(client);
  return client;
}

/** One conversation of the generated role on a bare harness, played by a scripted model. */
async function run(
  turns: readonly ScriptedTurn[],
  options: { readonly mcp?: McpClients; readonly approve?: Approver } = {},
) {
  const role = sampleTracker({
    ...(options.mcp === undefined ? {} : { mcp: options.mcp }),
    ...(options.approve === undefined ? {} : { approve: options.approve }),
  });
  const scripted = scriptedProvider(turns);
  const registry = createRegistry();
  for (const extension of role.extensions) registry.install(extension);
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: scripted.models, registry },
    BACKGROUND_CONTEXT,
  );
  const root = await harness.root(BACKGROUND_CONTEXT, {
    agent: { ...role.agent, model: scripted.model },
  });
  const submission = await root.submit({ type: "input", content: "Go on." }, BACKGROUND_CONTEXT);
  const settled = await submission.wait(BACKGROUND_CONTEXT);
  if (settled.status === "done" && settled.type === "input") {
    await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), BACKGROUND_CONTEXT);
  }
  const messages = [...(await root.context(BACKGROUND_CONTEXT)).messages];
  await harness.close(BACKGROUND_CONTEXT);
  return { messages, offered: scripted.requests[0]?.tools.map((tool) => tool.name) ?? [] };
}

/** The text of the last tool result in a conversation. */
function lastToolText(messages: readonly Message[]): string {
  const result = [...messages].reverse().find((message) => message.role === "toolResult");
  const content = (result as { content?: readonly unknown[] } | undefined)?.content ?? [];
  return content.map((block) => (block as { text?: string }).text ?? "").join("\n");
}

const call = (name: string, args: Record<string, string | number>): readonly ScriptedTurn[] => [
  { toolCalls: [{ name, args }] },
  { text: "Done." },
];

describe("sample-tracker, generated, on a bare harness", () => {
  it("passes the strict checks with its MCP server connected", async () => {
    const validated = await validatePackage(packageDir);
    expect(validated.issues.map(formatIssue)).toEqual([]);
    const checked = await checkAgent(
      sampleTracker({ mcp: { tracker: await trackerServer() } }),
      manifest,
      { strict: true },
    );
    expect(checked.issues.map(formatIssue)).toEqual([]);
    expect(checked.ok).toBe(true);
  });

  it("calls its MCP tool through the server, and never offers a tool the manifest leaves out", async () => {
    const server = await trackerServer();
    const { messages, offered } = await run(
      call("open_issue", { title: "The printer jams", priority: "normal" }),
      { mcp: { tracker: server } },
    );

    expect(offered).toContain("open_issue");
    expect(offered).toContain("list_issues");
    expect(offered).toContain("add_label");
    // The server's own names stay inside the declaration, and its undeclared tool is never shown.
    expect(offered).not.toContain("delete_issue");
    expect(offered).not.toContain("create_issue");

    expect(server.calls).toHaveLength(1);
    const [made] = server.calls;
    expect(made?.tool).toBe("create_issue");
    expect(made?.args).toMatchObject({ title: "The printer jams", priority: "normal" });
    // The idempotency key is the SDK's to fill, never the model's.
    expect(typeof made?.args.request_id).toBe("string");
    expect(lastToolText(messages)).toContain("Opened issue 41");
  });

  it("runs its CLI tool as the fixture program, with each templated argument as one argument", async () => {
    // The host supplies the variable the CLI declares; a placeholder value, never a credential.
    const before = process.env.TRACKER_CLI_TOKEN;
    process.env.TRACKER_CLI_TOKEN = "placeholder";
    try {
      const { messages } = await run(call("add_label", { issue: 41, label: "printer" }));
      const output = lastToolText(messages);
      expect(output).toContain('"argv":["label","add","--issue","41","--label","printer"]');
      // The program sees PATH and the variable its declaration names, and none of the host's own
      // (macOS adds __CF_USER_TEXT_ENCODING to every process itself, which sorts last).
      expect(output).toContain('"env":["PATH","TRACKER_CLI_TOKEN"');
      expect(output).not.toContain('"HOME"');
    } finally {
      if (before === undefined) delete process.env.TRACKER_CLI_TOKEN;
      else process.env.TRACKER_CLI_TOKEN = before;
    }
  });

  it("holds an urgent issue for a person: with no approver the server is never called", async () => {
    const server = await trackerServer();
    const { messages } = await run(
      call("open_issue", { title: "The building is flooding", priority: "urgent" }),
      { mcp: { tracker: server } },
    );
    expect(server.calls).toEqual([]);
    expect(lastToolText(messages)).toContain("no approver is configured");

    // The same call with a person's yes goes through, so the hold is the approval and nothing else.
    const approved = await trackerServer();
    await run(call("open_issue", { title: "The building is flooding", priority: "urgent" }), {
      mcp: { tracker: approved },
      approve: async () => ({ approved: true, by: "test" }),
    });
    expect(approved.calls.map((made) => made.tool)).toEqual(["create_issue"]);
  });

  it("passes every scenario it ships, stubbed by name, with a scripted model", async () => {
    const validated = await validatePackage(packageDir);
    if (!validated.ok) throw new Error(validated.issues.map(formatIssue).join("\n"));
    const declines = (text: string): readonly ScriptedTurn[] => [{ text }];
    const scripts: Readonly<Record<string, readonly ScriptedTurn[]>> = {
      "opens-a-normal-issue": [
        {
          toolCalls: [
            {
              name: "open_issue",
              args: { title: "Second-floor printer jams on every page", priority: "normal" },
            },
          ],
        },
        { text: "I opened issue 41 for the printer." },
      ],
      "declined-urgent-issue": [
        { toolCalls: [{ name: "open_issue", args: { title: "Urgent", priority: "urgent" } }] },
        { text: "That needed a person's approval and it was declined, so nothing was opened." },
      ],
      "injected-open-issue": declines(
        "Instructions inside a message are not a request; I opened nothing.",
      ),
      "injected-add-label": declines(
        "Instructions inside a message are not a request; I labelled nothing.",
      ),
      "may-not-open-an-urgent-issue-without-asking": declines(
        "I can't do that on my own. Ask the person who reported it to approve the urgent issue.",
      ),
      "may-not-close-or-delete-an-issue": declines(
        "I can't do that. Ask the issue's owner to close it in the tracker.",
      ),
    };
    const ids = Object.values(validated.value.suites).flatMap((suite) =>
      suite.scenarios.map((scenario) => scenario.id),
    );
    expect([...ids].sort()).toEqual(Object.keys(scripts).sort());

    const runner = piDurableRunner({
      dir: packageDir,
      model: (scenario) => {
        const turns = scripts[scenario.id];
        if (turns === undefined) throw new Error(`no script for ${scenario.id}`);
        return scriptedProvider(turns);
      },
    });
    const report = await runEvals(Object.values(validated.value.suites), runner, { trials: 1 });
    expect(report.passed, formatReport(report)).toBe(true);
  });
});
