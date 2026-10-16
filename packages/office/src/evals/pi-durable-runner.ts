/**
 * The Pi Durable eval runner: runs one role's declared tools as stubs on a fresh in-memory office
 * and records a trace the SDK grades.
 *
 * It is deliberately a *bare* harness. A role must pass its evals with nothing but Pi Durable and
 * the role's own extensions, so this runner installs the role's bundle and nothing else — no Office
 * Hum extension, no app client, no engine call. That is the portability gate (epic RASF-3065):
 * something a role needs from Office Hum surfaces here as a failure, not as a passing eval.
 *
 * Every tool the manifest declares is replaced with `wrapTool`: the stub keeps the real name,
 * description and parameters and returns the scenario's text. A call to a declared tool the scenario
 * does not stub stops the trial. `read_skill` is not declared, so it is left alone and runs for real.
 * An approval the scenario does not script is never guessed: the action is blocked and the trial
 * stops. Each trial opens its own office and conversation, so an index-based scripted provider must
 * be rebuilt per trial — hence the `model` factory rather than a single provider.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import {
  AssistantEntry,
  type Conversation,
  defineExtension,
  type Extension,
  GenerationTask,
  hook,
  type ModelRef,
  type SettledSubmissionRecord,
  type ToolRegistration,
  wrapTool,
} from "@earendil-works/pi-durable";
import type { AgentRunner, ApprovalRequest, Scenario, Trace } from "@officehum/sdk";
import { openOffice, ROOT_KEY } from "../adapter/index.js";
import type { LoadedRole } from "../roles/load-role.js";
import { loadRole } from "../roles/load-role.js";

/** The catalogue and the model ref one trial runs under. */
export interface EvalModel {
  readonly models: Models;
  readonly model: ModelRef;
}

/** The extension this runner installs; distinct from any role or skill extension name. */
export const EVAL_EXTENSION_NAME = "officehum.evals";

export interface PiDurableRunnerOptions {
  /** The role package directory to load and run. */
  readonly dir: string;
  /**
   * The model for one trial. Called once per trial — each trial is a fresh office with a fresh
   * conversation, so an index-based scripted provider must be rebuilt rather than shared, or it runs
   * out partway through the suite. A live caller ignores the arguments and returns one runtime.
   */
  readonly model: (scenario: Scenario, trial: number) => EvalModel;
  /** Overlay directories, lowest first, layered over the package for every trial. */
  readonly overlays?: readonly string[];
}

/**
 * Builds the SDK's `AgentRunner` over one role package. Hand it to `runEvals` with the package's
 * validated suites.
 *
 * ```ts
 * const runner = piDurableRunner({ dir, model: () => scriptedProvider(turns) });
 * const report = await runEvals(Object.values(pkg.suites), runner);
 * ```
 */
export function piDurableRunner(options: PiDurableRunnerOptions): AgentRunner {
  return {
    async run(scenario, trial): Promise<Trace> {
      return await runTrial(options, scenario, trial);
    },
  };
}

async function runTrial(
  options: PiDurableRunnerOptions,
  scenario: Scenario,
  trial: number,
): Promise<Trace> {
  // A ticket needs the Office extension to deliver it. The bare harness does not load one, so the
  // trial cannot run rather than silently grading an undelivered input.
  if (scenario.input.kind !== "message") {
    return {
      calls: [],
      approvalsRequested: [],
      delegated: [],
      turns: 0,
      error:
        `the ${scenario.input.type} ticket input needs the Office extension, which the bare eval ` +
        "harness does not load",
    };
  }

  const approvalsRequested: string[] = [];
  // Set once, by the approver, the stub of an unstubbed tool, or the turn guard; the first reason wins.
  let stopped: string | undefined;
  let requestStop: (() => void) | undefined;
  const stopPromise = new Promise<void>((resolve) => {
    requestStop = resolve;
  });
  const stop = (reason: string): void => {
    stopped ??= reason;
    requestStop?.();
  };

  const runtime = options.model(scenario, trial);
  const role = await loadRole(options.dir, {
    approve: scenarioApprover(scenario, approvalsRequested, stop),
    ...(options.overlays === undefined ? {} : { overlays: options.overlays }),
  });

  const stub = stubExtension(scenario, role, stop);
  const agent = {
    ...role.bundle.agent,
    model: runtime.model,
    extensions: [...selectedExtensions(role.bundle.agent.extensions, role.bundle.extensions), stub],
  };
  const bundle = { extensions: [...role.bundle.extensions, stub], agent };

  const office = await openOffice({ storage: "memory", models: runtime.models });
  try {
    office.install(bundle);
    const conversation = await office.conversation(ROOT_KEY, { agent });
    const submitted = await office.submit(conversation, {
      input: scenario.input.text,
      requestId: `eval/${scenario.id}/${trial}`,
    });
    const settled = submitted.wait(BACKGROUND_CONTEXT);
    // Stop the run the moment a stop reason is set: `abort` withdraws the queued work and settles the
    // submission `unanswered`, so the trial ends instead of running on to a misleading answer.
    await Promise.race([settled, stopPromise.then(() => office.abort(conversation))]);
    const settlement = await settled;

    const view = await conversation.context(BACKGROUND_CONTEXT);
    const calls = view.messages.flatMap((message) =>
      message.role === "assistant"
        ? message.content
            .filter((block) => block.type === "toolCall")
            .map((block) => ({ tool: block.name, args: block.arguments }))
        : [],
    );
    const turns = view.messages.filter((message) => message.role === "assistant").length;
    const reply =
      settlement.status === "done" ? await answerText(conversation, settlement) : undefined;
    const error = traceError(stopped, settlement);

    return {
      calls,
      approvalsRequested,
      delegated: [],
      turns,
      ...(reply === undefined ? {} : { reply }),
      ...(error === undefined ? {} : { error }),
    };
  } finally {
    await office.close();
  }
}

/** The approver the scenario scripts: a request it does not script stops the trial, never allowed. */
function scenarioApprover(
  scenario: Scenario,
  approvalsRequested: string[],
  stop: (reason: string) => void,
) {
  return async (request: ApprovalRequest) => {
    approvalsRequested.push(request.approvalId);
    const decision = scenario.approvals?.[request.approvalId];
    if (decision === undefined) {
      stop(`the ${request.approvalId} approval is not scripted by the scenario`);
      return { approved: false, by: "eval", note: "not scripted" };
    }
    return { approved: decision === "approve", by: "eval" };
  };
}

/**
 * One extension that stubs every declared tool and stops the run past `limits.maxTurns`. A stub keeps
 * the tool's real name, description and parameters — only `execute` is replaced — so the model sees
 * exactly the tools a real run offers. `read_skill` is not a declared tool and is left real.
 */
function stubExtension(scenario: Scenario, role: LoadedRole, stop: (reason: string) => void) {
  const declared = new Set(role.manifest.tools.map((tool) => tool.name));
  const wraps = role.bundle.extensions
    .flatMap((extension) => extension.tools ?? [])
    .filter((tool) => declared.has(tool.name))
    .map((tool) => wrapTool(tool, (original) => stubTool(original, scenario, stop)));

  const maxTurns = scenario.limits?.maxTurns;
  let requests = 0;
  const guard = hook(GenerationTask, {
    beforeRequest: async () => {
      requests += 1;
      if (maxTurns !== undefined && requests > maxTurns) {
        stop(`the run passed limits.maxTurns (${maxTurns})`);
      }
      return undefined;
    },
  });

  return defineExtension({ name: EVAL_EXTENSION_NAME, wraps, hooks: [guard] });
}

/** The stub for one declared tool: the scenario's text, or a refusal that stops the trial. */
function stubTool(
  original: ToolRegistration,
  scenario: Scenario,
  stop: (reason: string) => void,
): ToolRegistration {
  const stub = scenario.stubs[original.name];
  return {
    ...original,
    execute: async () => {
      if (stub === undefined) {
        stop(`${original.name} is declared but the scenario does not stub it`);
        return {
          isError: true,
          output: [
            {
              type: "text" as const,
              text: `${original.name} is not stubbed for this scenario, so it was not run.`,
            },
          ],
        };
      }
      return {
        ...(stub.isError === true ? { isError: true } : {}),
        output: [{ type: "text" as const, text: stub.text }],
      };
    },
  };
}

/** The role's selected extensions, falling back to all of them when the bundle does not list names. */
function selectedExtensions(selected: unknown, all: readonly Extension[]): readonly Extension[] {
  return Array.isArray(selected) ? (selected as readonly Extension[]) : all;
}

/** The final answer text, read the way `openRoleRun` reads it: through the committed assistant entry. */
async function answerText(
  conversation: Conversation,
  settlement: SettledSubmissionRecord,
): Promise<string | undefined> {
  if (settlement.status !== "done" || settlement.type !== "input") return undefined;
  const entry = await conversation.commit(
    (transaction) => transaction.entry(AssistantEntry, settlement.answer),
    BACKGROUND_CONTEXT,
  );
  const message = entry?.model?.find((item) => item.role === "assistant");
  const text = message?.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  return text === undefined ? undefined : text;
}

/** Why the trial did not finish: the runner's own stop reason first, then Pi Durable's settlement. */
function traceError(
  stopped: string | undefined,
  settlement: SettledSubmissionRecord,
): string | undefined {
  if (stopped !== undefined) return stopped;
  if (settlement.status === "done") return undefined;
  const detail = settlement.detail;
  return typeof detail === "string" && detail.length > 0 ? detail : settlement.reason;
}
