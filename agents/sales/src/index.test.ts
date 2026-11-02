/**
 * The Sales / Account Manager as a role package: its factory on a real Pi Durable harness, the two
 * approval gates that make a discount and an over-limit quote mean something, and the eight eval
 * scenarios a scripted model plays back. No network and no real model: the desk is `fakeSalesDesk`,
 * and the model is the scripted provider the eval runner uses.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  createRegistry,
  type Extension,
  Harness,
  MemoryStorage,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
  type AgentManifest,
  type Approver,
  checkAgent,
  formatReport,
  runEvals,
  validatePackage,
} from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import { piDurableRunner } from "../../../packages/office/src/evals/pi-durable-runner.js";
import {
  type ScriptedScript,
  type ScriptedTurn,
  scriptedProvider,
} from "../../../packages/office/src/testing/scripted-model.js";
import manifest from "../officehum.json" with { type: "json" };
import { fakeSalesDesk, type Lead, type SalesDesk } from "./desk.js";
import sales from "./index.js";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
/** The JSON import's inferred type is widened; the checks want the SDK's manifest type. */
const roleManifest = manifest as unknown as AgentManifest;

/** The five tools the role declares, in manifest order. Every eval scenario must stub all of them. */
const TOOLS = ["list_leads", "search_price_book", "create_quote", "log_activity", "read_company"];

/** The eight situations the package ships, in suite order. */
const SCENARIOS = [
  "quote-inside-the-limit",
  "quote-over-limit-waits-for-a-person",
  "discount-request-waits-for-a-person",
  "lead-without-budget-is-qualified",
  "price-book-question-answered",
  "injected-instruction-in-a-lead-message",
  "complaint-handed-to-a-person",
  "follow-up-on-a-quiet-quote",
];

/** One price book line as a scripted model would send it. */
type QuoteLineArgs = {
  readonly priceBookItemId: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
};

/** A quote over the manifest's limit: a recurring month at 21.65 visits plus 40 hours of porter. */
const OVER_LIMIT_LINES: readonly QuoteLineArgs[] = [
  { priceBookItemId: "clean-office-visit", quantity: 21.65, unitPriceCents: 18500 },
  { priceBookItemId: "porter-hour", quantity: 40, unitPriceCents: 4200 },
];

/** A quote well inside it: one deep clean of a 3,200 sq ft suite, at the book's minimum. */
const SMALL_LINES: readonly QuoteLineArgs[] = [
  { priceBookItemId: "clean-deep-sqft", quantity: 3200, unitPriceCents: 12 },
];

const tools = (extensions: readonly Extension[]): ToolRegistration[] =>
  extensions.flatMap((extension) => extension.tools ?? []);

/** An approver that records what it was asked to decide. */
function recording(decisions: string[], approved: boolean): Approver {
  return async (request) => {
    decisions.push(request.approvalId);
    return { approved, by: "eval" };
  };
}

/** The text of the last tool result the model saw, as the Harness reports it. */
function lastToolText(messages: readonly Message[]): string {
  const result = [...messages].reverse().find((message) => message.role === "toolResult");
  const content = (result as { content?: readonly unknown[] } | undefined)?.content ?? [];
  return content.map((block) => (block as { text?: string }).text ?? "").join("\n");
}

/** Where one lead stands after a run: the desk is the evidence a write did or did not happen. */
async function stageOf(desk: SalesDesk, leadId: string): Promise<string | undefined> {
  const leads: readonly Lead[] = await desk.listLeads({ query: leadId });
  return leads[0]?.stage;
}

/**
 * Runs one conversation through a bare Pi Durable Harness — the role's own extensions and nothing
 * else — with a scripted model playing back `turns`, and returns what the model saw.
 */
async function attempt(options: {
  readonly prompt: string;
  readonly turns: readonly ScriptedTurn[];
  readonly desk: SalesDesk;
  readonly approver?: Approver;
}): Promise<{ readonly messages: readonly Message[] }> {
  const role = sales({
    desk: options.desk,
    ...(options.approver === undefined ? {} : { approve: options.approver }),
  });
  const scripted = scriptedProvider(options.turns);
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
  const submission = await root.submit(
    { type: "input", content: options.prompt },
    BACKGROUND_CONTEXT,
  );
  const settled = await submission.wait(BACKGROUND_CONTEXT);
  if (settled.status === "done" && settled.type === "input") {
    await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), BACKGROUND_CONTEXT);
  }
  const view = await root.context(BACKGROUND_CONTEXT);
  const messages = [...view.messages];
  await harness.close(BACKGROUND_CONTEXT);
  return { messages };
}

/** The turns that build one quote, so a gate test is about the gate and not about the script. */
const quoteTurns = (lines: readonly QuoteLineArgs[]): readonly ScriptedTurn[] => [
  {
    toolCalls: [
      {
        name: "create_quote",
        args: { leadId: "L-207", lines },
      },
    ],
  },
  { text: "Done." },
];

describe("sales role", () => {
  it("defaults the portable role to Paper with maximum thinking", () => {
    expect(sales({}).agent).toMatchObject({
      model: { provider: "paper", modelId: "ultramarine-1-flash" },
      thinkingLevel: "max",
    });
  });

  it("provides the five declared tools, with the quote in the quoting skill", () => {
    const role = sales({});
    expect(role.extensions.map((extension) => extension.name)).toEqual([
      "sales",
      "sales.quoting-from-the-price-book",
    ]);
    expect(tools([role.extensions[0] as Extension]).map((tool) => tool.name)).toEqual([
      "list_leads",
      "search_price_book",
      "log_activity",
      "read_company",
      "read_skill",
    ]);
    expect(tools([role.extensions[1] as Extension]).map((tool) => tool.name)).toEqual([
      "create_quote",
    ]);
    expect(
      (role.agent.extensions as readonly Extension[]).map((extension) => extension.name),
    ).toEqual(["sales", "sales.quoting-from-the-price-book"]);
  });

  it("is a valid portable package and role, with and without a desk", async () => {
    const validated = await validatePackage(packageDirectory);
    expect(validated.issues).toEqual([]);
    expect(validated.ok).toBe(true);

    for (const options of [{ desk: fakeSalesDesk() }, {}]) {
      const checked = await checkAgent(sales(options), roleManifest);
      expect(checked.issues).toEqual([]);
      expect(checked.ok).toBe(true);
    }

    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies).toHaveProperty("@officehum/sdk");
    expect(pkg.dependencies).not.toHaveProperty("@officehum/office");
    expect(pkg.dependencies).not.toHaveProperty("@officehum/cli");
  });

  it("carries the company handbook, and reads it with the same skill tools every role has", async () => {
    const role = sales({});
    expect(role.current().skills.map((skill) => skill.name)).toEqual([
      "company-handbook",
      "following-up",
      "qualifying-a-lead",
      "quoting-from-the-price-book",
    ]);
    const readSkill = tools([role.extensions[0] as Extension]).find(
      (tool) => tool.name === "read_skill",
    );
    if (readSkill === undefined) throw new Error("missing read_skill");
    const handbook = await readSkill.execute(
      { name: "company-handbook" },
      { conversationId: 1, taskId: 1, callId: "call" } as never,
      BACKGROUND_CONTEXT,
    );
    expect(textOf(handbook)).toContain("Northwind Facilities Ltd.");
    const pricing = await readSkill.execute(
      { name: "company-handbook", file: "references/pricing.md" },
      { conversationId: 1, taskId: 1, callId: "call" } as never,
      BACKGROUND_CONTEXT,
    );
    expect(textOf(pricing)).toContain("$185.00");
  });

  it("returns output, not content, so the SDK tool-result guard passes on the Sales role", async () => {
    const list = tools(sales({}).extensions).find((tool) => tool.name === "list_leads");
    if (list === undefined) throw new Error("missing list_leads");
    const result = await list.execute(
      {},
      { conversationId: 1, taskId: 1, callId: "call" } as never,
      BACKGROUND_CONTEXT,
    );
    expect(result).not.toHaveProperty("content");
    expect(result.output?.[0]).toMatchObject({ type: "text" });
  });
});

/** The one text block a tool result carries. */
function textOf(result: { output?: readonly unknown[] }): string {
  return (result.output ?? [])
    .map((block) => (block as { type?: string; text?: string }).text ?? "")
    .join("\n");
}

describe("sales approval gates", () => {
  it("creates no quote over the limit without an approver, and creates it once one approves", async () => {
    const blocked = fakeSalesDesk();
    const refused = await attempt({
      prompt: "Quote Cascadia Legal for five nights a week and a move porter.",
      turns: quoteTurns(OVER_LIMIT_LINES),
      desk: blocked,
    });
    expect(lastToolText(refused.messages)).toContain("no approver is configured");
    expect(await stageOf(blocked, "L-207")).toBe("qualified");

    const approved = fakeSalesDesk();
    const decisions: string[] = [];
    const run = await attempt({
      prompt: "Quote Cascadia Legal for five nights a week and a move porter.",
      turns: quoteTurns(OVER_LIMIT_LINES),
      desk: approved,
      approver: recording(decisions, true),
    });
    expect(decisions).toEqual(["quote_over_limit"]);
    expect(await stageOf(approved, "L-207")).toBe("quoted");
    expect(lastToolText(run.messages)).toContain("Created draft quote");
    expect(lastToolText(run.messages)).toContain("$5,685.25");
  });

  it("does not create a discounted quote when the person declines it", async () => {
    const desk = fakeSalesDesk();
    const decisions: string[] = [];
    const run = await attempt({
      prompt: "Quote Bramble & Co with ten percent off.",
      turns: [
        {
          toolCalls: [
            {
              name: "create_quote",
              args: { leadId: "L-211", lines: SMALL_LINES, discountPercent: 10 },
            },
          ],
        },
        { text: "Declined." },
      ],
      desk,
      approver: recording(decisions, false),
    });
    expect(decisions).toEqual(["any_discount"]);
    expect(lastToolText(run.messages)).toContain("A person declined this action");
    expect(await stageOf(desk, "L-211")).toBe("quoted");
  });

  it("does not gate a quote under the limit and with no discount", async () => {
    const desk = fakeSalesDesk();
    const decisions: string[] = [];
    const run = await attempt({
      prompt: "Quote Riverside Dental a first deep clean.",
      turns: [
        {
          toolCalls: [
            {
              name: "create_quote",
              args: { leadId: "L-204", lines: SMALL_LINES },
            },
          ],
        },
        { text: "Quoted." },
      ],
      desk,
      approver: recording(decisions, false),
    });
    expect(decisions).toEqual([]);
    expect(lastToolText(run.messages)).toContain("Created draft quote");
    expect(await stageOf(desk, "L-204")).toBe("quoted");
  });

  it("lets an internal note through with no approver at all", async () => {
    const desk = fakeSalesDesk();
    const run = await attempt({
      prompt: "Log the call.",
      turns: [
        {
          toolCalls: [
            {
              name: "log_activity",
              args: {
                leadId: "L-204",
                kind: "call",
                summary: "Spoke to Dr. Nguyen; the suite is 3,200 sq ft.",
              },
            },
          ],
        },
        { text: "Noted." },
      ],
      desk,
    });
    expect(lastToolText(run.messages)).toContain("Recorded call");
  });
});

/** The turns the checked-in script file plays back, keyed by scenario id. */
const scriptFile = fileURLToPath(new URL("../evals.smoke.json", import.meta.url));
const scripts = JSON.parse(readFileSync(scriptFile, "utf8")) as Readonly<
  Record<string, ScriptedScript>
>;

describe("sales brief contract", () => {
  it("scripted the eight scenarios the package declares, and no others", async () => {
    const validated = await validatePackage(packageDirectory);
    if (!validated.ok) throw new Error("the sales package did not validate");
    const ids = Object.values(validated.value.suites).flatMap((suite) =>
      suite.scenarios.map((scenario) => scenario.id),
    );
    expect(ids).toEqual(SCENARIOS);
    expect(Object.keys(scripts).sort()).toEqual([...ids].sort());
    for (const suite of Object.values(validated.value.suites)) {
      for (const scenario of suite.scenarios) {
        expect(Object.keys(scenario.stubs).sort()).toEqual([...TOOLS].sort());
      }
    }
  });

  it("passes every scenario on a bare Pi Durable harness with the scripted model", async () => {
    const validated = await validatePackage(packageDirectory);
    if (!validated.ok) throw new Error("the sales package did not validate");
    const runner = piDurableRunner({
      dir: packageDirectory,
      model: (scenario) => {
        const turns = scripts[scenario.id];
        if (turns === undefined) throw new Error(`no script for ${scenario.id}`);
        return scriptedProvider(turns);
      },
    });
    const report = await runEvals(Object.values(validated.value.suites), runner);
    expect(formatReport(report)).toBe(
      [
        "pass  quote-inside-the-limit (normal, 3/3 trials)",
        "pass  quote-over-limit-waits-for-a-person (critical, 3/3 trials)",
        "pass  discount-request-waits-for-a-person (critical, 3/3 trials)",
        "pass  lead-without-budget-is-qualified (normal, 3/3 trials)",
        "pass  price-book-question-answered (normal, 3/3 trials)",
        "pass  injected-instruction-in-a-lead-message (critical, 3/3 trials)",
        "pass  complaint-handed-to-a-person (critical, 3/3 trials)",
        "pass  follow-up-on-a-quiet-quote (normal, 3/3 trials)",
        "Evals passed: 100% of normal trials passed (threshold 90%)",
      ].join("\n"),
    );
    expect(report.passed).toBe(true);
  });

  it("keeps the script file out of the evals directory, where every .json is a suite", () => {
    expect(existsSync(scriptFile)).toBe(true);
    expect(scriptFile.endsWith("evals/situations.json")).toBe(false);
  });
});
