/**
 * The generated sample-counts role's context plan, run. Not a test of this fixture directory:
 * role-factory's generate tests copy this file into the package the generator writes from
 * `ROLE_SPEC.md` (as `src/context.test.ts`, beside the generated `src/index.ts`) and run it there, so
 * every import below resolves the way it does for any role package in the repository.
 *
 * The plan the spec accepted — a 4,000-token prompt budget and the relevance filter — is checked the
 * way the SDK's own long-session test checks it: on a bare Pi Durable harness, with a stub engine and
 * a scripted model, a long session stays within the budget with the plan and exceeds it without.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import {
  type AgentManifest,
  checkAgent,
  type DefinedRole,
  defineRole,
  type Engine,
  formatIssue,
  stubEngine,
  validatePackage,
} from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import manifestJson from "../officehum.json" with { type: "json" };
import sampleCounts, { packageDir } from "./index.js";

const manifest = manifestJson as unknown as AgentManifest;
const context = BACKGROUND_CONTEXT;
const BUDGET = manifest.contextPlan?.promptBudgetTokens ?? 0;
/** Past the 20 tool calls the advisor's rule C6 reads as a long task. */
const ROUNDS = 30;
/** The round whose answer cites one of its findings, so its result must stay whole. */
const CITED = 4;
const FINDINGS = 12;

const findingId = (round: number, item: number) =>
  `count-R${round}:ITEM-${String(item).padStart(2, "0")}`;

/** An engine whose `count` answers a large, round-specific count: `--batch R<round>`. */
function countingEngine(): Engine {
  return stubEngine({
    count: (args) => {
      const round = Number(String(args[args.indexOf("--batch") + 1]).slice(1));
      return {
        findings: Array.from({ length: FINDINGS }, (_, index) => ({
          id: findingId(round, index + 1),
          description: `Item ${index + 1} in the count of batch R${round}`,
          quantity: 10 + index,
        })),
      };
    },
  });
}

function text(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((block) =>
      block.type === "text"
        ? block.text
        : block.type === "toolCall"
          ? `${block.name}:${JSON.stringify(block.arguments)}`
          : "",
    )
    .join("\n");
}

/** A request's size as the SDK counts tokens: characters ÷ 4, the prompt sections included. */
function requestTokens(messages: readonly Message[]): number {
  const all = messages
    .map((message) =>
      message.role === "system"
        ? [
            text(message),
            ...Object.values(message.sections ?? {}),
            JSON.stringify(message.toolsAdded ?? []),
          ].join("\n")
        : text(message),
    )
    .join("\n\n");
  return Math.ceil(all.length / 4);
}

/** The scripted model: counts the round's batch, then answers, citing a finding in round CITED. */
function script(messages: readonly Message[]): AssistantMessage {
  const last = messages.at(-1);
  if (last?.role === "user") {
    const round = Number(/Round (\d+)/.exec(text(last))?.[1]);
    return fauxAssistantMessage(
      [fauxToolCall("count_batch", { batch: `R${round}` }, { id: `call-${round}` })],
      { stopReason: "toolUse" },
    );
  }
  if (last?.role === "toolResult") {
    const round = Number(last.toolCallId.slice("call-".length));
    return fauxAssistantMessage(
      round === CITED
        ? `Item 3 has 12 in this batch (${findingId(round, 3)}).`
        : "Counted; nothing needs attention.",
    );
  }
  return fauxAssistantMessage("I am not sure what to do.");
}

function scriptedModels(requests: Message[][]) {
  const faux = fauxProvider({
    provider: "scripted",
    api: "scripted",
    models: [{ id: "scripted-1", contextWindow: 1_000_000 }],
  });
  const respond: FauxResponseFactory = async (request, _options, _state, model) => {
    faux.appendResponses([respond]);
    const messages = structuredClone(request.messages) as Message[];
    requests.push(messages);
    return { ...script(messages), provider: model.provider, model: model.id };
  };
  faux.setResponses([respond]);
  const models = createModels();
  models.setProvider(faux.provider);
  return models;
}

/** Runs a session of ROUNDS rounds and returns every request the model received. */
async function session(role: DefinedRole): Promise<Message[][]> {
  const requests: Message[][] = [];
  const registry = createRegistry();
  for (const extension of role.extensions) registry.install(extension);
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: scriptedModels(requests), registry },
    context,
  );
  try {
    const root = await harness.root(context, {
      agent: { ...role.agent, model: { provider: "scripted", modelId: "scripted-1" } },
    });
    harness.resume();
    for (let round = 1; round <= ROUNDS; round++) {
      const submission = await root.submit(
        { type: "input", content: `Round ${round}: count batch R${round}.` },
        context,
      );
      const settled = await submission.wait(context);
      expect(settled.status).toBe("done");
    }
  } finally {
    await harness.close(context);
  }
  return requests;
}

function toolResultText(messages: readonly Message[], callId: string): string {
  const found = messages.find(
    (message) => message.role === "toolResult" && message.toolCallId === callId,
  );
  if (found === undefined) throw new Error(`no result for ${callId}`);
  return text(found);
}

describe("sample-counts, generated with a context plan", () => {
  it("declares context_recall with its filter and passes the strict checks", async () => {
    expect(manifest.contextPlan).toEqual({
      promptBudgetTokens: 4000,
      historyFilter: { keepRecentRounds: 2, keepCitedIds: true, maxToolResultTokens: 200 },
    });
    expect(manifest.tools).toContainEqual({ name: "context_recall", replay: "safe" });
    const validated = await validatePackage(packageDir);
    expect(validated.issues.map(formatIssue)).toEqual([]);
    const checked = await checkAgent(sampleCounts({ engine: countingEngine() }), manifest, {
      strict: true,
    });
    expect(checked.issues.map(formatIssue)).toEqual([]);
    expect(checked.ok).toBe(true);
  });

  it("stays within its prompt budget over a long session, keeps the cited count, and would not without the plan", async () => {
    const on = await session(sampleCounts({ engine: countingEngine() }));
    const { contextPlan: _plan, ...bare } = manifest;
    const off = await session(
      defineRole({
        packageDir,
        manifest: { ...bare, tools: bare.tools.filter((tool) => tool.name !== "context_recall") },
        engine: countingEngine(),
      }),
    );
    expect(on).toHaveLength(ROUNDS * 2);
    const largestOn = Math.max(...on.map(requestTokens));
    const largestOff = Math.max(...off.map(requestTokens));
    console.info(
      `${ROUNDS} rounds, budget ${BUDGET}: largest request ${largestOn} tokens with the plan, ${largestOff} without`,
    );
    expect(largestOn).toBeLessThanOrEqual(BUDGET);
    expect(largestOff).toBeGreaterThan(BUDGET);

    const last = on.at(-1) ?? [];
    // Round 1 is old and never cited: a stub that names the call to recall it.
    expect(toolResultText(last, "call-1")).toMatch(
      /^\[context: count_batch result from .* omitted/,
    );
    expect(toolResultText(last, "call-1")).toContain('context_recall("call-1")');
    // The cited round stays whole.
    expect(toolResultText(last, `call-${CITED}`)).toContain(findingId(CITED, FINDINGS));
  });
});
