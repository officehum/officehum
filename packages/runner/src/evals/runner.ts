/**
 * The Pi Durable eval runner: runs one role's declared tools as stubs on a fresh in-memory harness
 * and records a trace the SDK grades.
 *
 * **It is deliberately a bare harness.** A role must pass its evals with nothing but Pi Durable and
 * the role's own extensions, so this runner installs the role's bundle and nothing else — no Office
 * Hum extension, no app client, no engine call, no board. That is the portability gate: something a role needs from Office Hum surfaces here as a failure, not as a passing
 * eval.
 *
 * A host can add to a trial through `TrialHost`: the office's eval mode is one, and lives
 * in the office. It is handed the trial at the points its own run would act — before the role loads
 * (the sender and approver), once the role is loaded (its board and ticket), when the harness is set
 * up, when the conversation exists, when the input is delivered and when the run settles — and this
 * runner does the rest exactly as it does with no host.
 *
 * **Emitted and executed are different facts, and the trace keeps them apart.** `calls` is what the
 * model put in its message, blocked calls included — that has always been its meaning and it does not
 * change. `executedCalls` says, per call, whether `execute` was reached, and when it was not, which
 * hook refused it and in what words. Without that, "nothing ran" and "the runner cannot see what ran"
 * produce the same trace.
 *
 * Every tool the manifest declares is replaced with `wrapTool`: the stub keeps the real name,
 * description and parameters and returns the scenario's text. A call to a declared tool the scenario
 * does not stub stops the trial. `read_skill` is not declared, so it is left alone and runs for real.
 * An approval the scenario does not script is never guessed: the trial stops. The role is handed a
 * verified sender as production would hand it one: the scenario's `from` as an outside contact (or a
 * host's, from its own record), and unknown when the scenario names nobody. Each trial opens its own
 * harness and conversation, so an index-based scripted provider must be rebuilt per trial — hence
 * the `model` factory rather than a single provider.
 *
 * A scenario with a `memory` block runs the role with the portable memory extension
 * (`./eval-memory.ts`), its seeded records written before the turn and every stored record in the
 * trace. The memory tools are not declared by the role, so they run for real.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { getSystemMessageText } from "@earendil-works/pi-ai/utils/text";
import {
  type AgentChange,
  type Conversation,
  defineExtension,
  type Extension,
  GenerationTask,
  type HookRegistration,
  hook,
  type InputEntry,
  type JsonObject,
  type ModelRef,
  type SettledSubmissionRecord,
  type ToolExecutionResult,
  type ToolHooks,
  type ToolRegistration,
  ToolTask,
  wrapTool,
} from "@earendil-works/pi-durable";
import {
  type AgentManifest,
  type AgentRunner,
  APPROVED_VALUE_ARG,
  type ApprovalRecord,
  type ApprovalRequest,
  type Approver,
  approvalValueProblem,
  argsMatch,
  type CompanyRecord,
  type Engine,
  type ExecutedCall,
  engineArgs,
  type Scenario,
  type SenderResolver,
  type Stub,
  scriptedDecision,
  type ToolPack,
  type Trace,
  valueProblemForApprover,
} from "@officehum/sdk";
import { type Office, openOffice, ROOT_KEY } from "../adapter/index.js";
import type { LoadedRole } from "../roles/load-role.js";
import { loadRole } from "../roles/load-role.js";
import { answerText } from "../roles/run-role.js";
import { SCRIPTED_PROVIDER_ID } from "../testing/scripted-model.js";
import { cappedModels, outputLimitError, usageTotal } from "./eval-cost.js";
import { bareEvalMemory, type EvalMemory } from "./eval-memory.js";
import { type EvalModel, modelJudge } from "./judge.js";

export type { EvalModel } from "./judge.js";

/** What a trial's model may need to know about the trial. */
export interface TrialContext {
  /** The id of the ticket the trial's conversation works, in office mode; the board makes it at random. */
  readonly ticketId?: string;
}

/** The extension this runner installs; distinct from any role or skill extension name. */
export const EVAL_EXTENSION_NAME = "officehum.evals";

/**
 * The positive control's sentence, exported so a test asserts the sentence and not a fragment.
 *
 * A run that executed nothing is not a defence: it is indistinguishable from a ledger that never saw
 * an execution. When the scenario expects calls, the runner fails the trial rather than let an empty
 * ledger look like a perfect one.
 */
export const EMPTY_LEDGER_ERROR =
  "the executed ledger is empty: no tool call's execute ran in this trial, so a pass here proves " +
  "nothing about what the office allowed";

/**
 * What a host adds to a trial. The office's eval mode is one: it binds a board and a
 * ticket and installs the office's real approval path, so a gated call can be refused and the refusal
 * observed. Each method is called at the point in the trial where the office's own run takes that
 * step; the runner does everything else as it does with no host.
 */
export interface TrialHost {
  /** Whether this host delivers `ticket` inputs; the bare harness has no board to deliver them from. */
  readonly deliversTickets: boolean;
  /** Called once per trial, before the role loads. `stop` ends the trial; the first reason wins. */
  begin(scenario: Scenario, trial: number, stop: (reason: string) => void): HostTrial;
}

/** A trial a host has begun: what the role is loaded with. */
export interface HostTrial {
  readonly sender: SenderResolver;
  readonly approve: Approver;
  /**
   * The host's side of the trial for the loaded role, or why the trial cannot run. The ledger records
   * what the host's own hooks refuse and answers its completion checks from the trial's record.
   */
  open(role: LoadedRole, ledger: TrialLedger): OpenedHostTrial | { readonly unrun: string };
}

/** The trial's record, as a host may add to it. */
export interface TrialLedger {
  /** The registrations with their refusals recorded in the ledger under `name`. */
  watched(registrations: readonly HookRegistration[], name: string): readonly HookRegistration[];
  /** The engine an `engine` completion check runs against: the role's tools are stubs here. */
  evidenceEngine(manifest: AgentManifest): Engine;
}

/** The host's side of a trial that runs. */
export interface OpenedHostTrial {
  /** What the trial's model factory is told. */
  readonly context: TrialContext;
  /** The role's extensions as the host runs them. */
  roleExtensions(extensions: readonly Extension[]): readonly Extension[];
  /** The trial's memory, or none; replaces the bare harness's choice. */
  memory(harness: Office, role: LoadedRole, scenario: Scenario): EvalMemory | undefined;
  /** Installs the host's own extension beside the role; returns the conversation's settings. */
  install(harness: Office, agent: AgentChange): AgentChange;
  /** Once the trial's conversation exists, before its input is submitted. */
  started(harness: Office, conversation: Conversation, settings: AgentChange): Promise<void>;
  /** What the model is handed for the scenario's input text. */
  delivery(text: string): { readonly content: string; readonly entry?: InputEntry };
  /** The approvals the host's store holds once the run has settled. */
  approvals(): readonly ApprovalRecord[];
  /** The host's last step once the agent is done (`stopped` when the trial was stopped); its error. */
  finish(stopped: string | undefined): string | undefined;
  /** The trace fields only the host knows. */
  traceExtras(): Pick<Trace, "tickets" | "ticketId">;
  /** Called before the trial's harness closes. */
  beforeClose(): void;
  /** Called after the trial's harness closes. */
  close(): void;
}

export interface PiDurableRunnerOptions {
  /** The role package directory to load and run. */
  readonly dir: string;
  /**
   * The model for one trial. Called once per trial — each trial is a fresh harness with a fresh
   * conversation, so an index-based scripted provider must be rebuilt rather than shared, or it runs
   * out partway through the suite. A live caller ignores the arguments and returns one runtime. With
   * a host it is called once the host's side is open, with its context (the office's ticket id), so
   * a script can reply to it.
   */
  readonly model: (scenario: Scenario, trial: number, context: TrialContext) => EvalModel;
  /** Overlay directories, lowest first, layered over the package for every trial. */
  readonly overlays?: readonly string[];
  /**
   * An installed office's own company (`officehum eval --company`): the role is given
   * `facts` as its `company` and runs with no demonstration data, and `read_company` runs for real.
   * Omitted: the sample company, on its demonstration data.
   */
  readonly company?: { readonly facts: CompanyRecord };
  /**
   * The model that grades `expect.reply.judged`, through `modelJudge`. A live caller
   * passes the model its trials run on unless told to use another. Omitted: the runner has no
   * judge, and every judged assertion is reported skipped.
   */
  readonly judge?: EvalModel;
  /**
   * The most output tokens, reasoning included, any request of a trial or of its judge asks for
   *. A provider that reserves balance for a request's largest possible cost reserves
   * this much output instead of the model's whole limit. A reply that ends at it is not graded: the
   * trace is errored with `errorSource: "output-limit"`. Omitted: the model's own limit, as in
   * production.
   */
  readonly maxOutputTokens?: number;
  /**
   * The tool packs the role is given, as an office gives them: built from its manifest,
   * so the tools it declares from them are offered. Like every declared tool they are stubs here, so
   * a pack's own code never runs. Pass the same ids to `runEvals` as `packs`, so a suite that needs a
   * pack runs only when it is given. Omitted: the role has no pack.
   */
  readonly packs?: (manifest: AgentManifest) => readonly ToolPack[];
  /** What a host adds to every trial. Omitted: the bare harness. */
  readonly host?: TrialHost;
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
    ...(options.judge === undefined
      ? {}
      : {
          judge: modelJudge({
            ...options.judge,
            models: cappedModels(options.judge.models, options.maxOutputTokens),
          }),
        }),
  };
}

/** One tool call as the model emitted it: the transcript's own id, name and arguments. */
interface EmittedCall {
  readonly id: string;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/**
 * What the harness actually did during one trial, keyed by the tool call's id.
 *
 * Two facts, recorded separately and never inferred from one another: a call whose `execute` began
 * (`ran`), and a refusal a hook this runner installed returned (`blocks`). A call in neither was
 * emitted and never ran — which, for a red-team suite, is most of the interesting result.
 */
interface Execution {
  readonly ran: Set<string>;
  readonly blocks: Map<string, { readonly hook: string; readonly text: string }>;
  /** The value a person approved that a call ran with, as the gate handed it to the stub. */
  readonly values: Map<string, NonNullable<ExecutedCall["approvedValue"]>>;
  /** Calls a running tool made through `executeTool()`: in an eval, `agent_reply`'s evidence checks. */
  readonly nested: Set<string>;
  /** Every stub the model's own calls reached, in order, and whether it answered with an error. */
  readonly answered: AnsweredCall[];
}

/** One of the model's own calls a stub answered. */
interface AnsweredCall {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly isError: boolean;
}

async function runTrial(
  options: PiDurableRunnerOptions,
  scenario: Scenario,
  trial: number,
): Promise<Trace> {
  const { host } = options;
  // A ticket is delivered by the relay, from a board. The bare harness has neither, so the trial
  // cannot run rather than silently grading an undelivered input; a host that delivers tickets does.
  if (scenario.input.kind !== "message" && host?.deliversTickets !== true) {
    return unrunTrace(
      `the ${scenario.input.type} ticket input needs office mode, where the relay delivers it; the ` +
        "bare harness has no board to deliver it from",
    );
  }

  // As an installed office (`--company`), no stub may carry the sample company the role
  // package ships: the trial would put it in front of the model as the office's own.
  if (options.company !== undefined) {
    const carried = sampleCompanyInStubs(options.dir, scenario);
    if (carried !== undefined) return unrunTrace(carried);
  }

  // The bare harness's approval ids, from the approver the scenario scripts. A host reads its own
  // store instead, so that an assertion about approvals is an assertion about its gate.
  const approvalsRequested: string[] = [];
  // Set once, by the approver, a host's observer, the stub of an unstubbed tool, or the turn guard;
  // the first reason wins.
  let stopped: string | undefined;
  let requestStop: (() => void) | undefined;
  const stopPromise = new Promise<void>((resolve) => {
    requestStop = resolve;
  });
  const stop = (reason: string): void => {
    stopped ??= reason;
    requestStop?.();
  };

  const hosted = host?.begin(scenario, trial, stop);
  const sender: SenderResolver = hosted?.sender ?? bareSender(scenario.input);

  const role = await loadRole(options.dir, {
    approve: hosted?.approve ?? scenarioApprover(scenario, approvalsRequested, stop),
    sender,
    // A scenario is written against the role's demonstration data: the approval facts readers read
    // it, and a role with a desk builds its demonstration desk only when asked. An installed office's
    // company has no demonstration data: the role is given the company, and no desk.
    ...(options.company === undefined ? { demo: true } : { company: options.company.facts }),
    ...(options.overlays === undefined ? {} : { overlays: options.overlays }),
    ...(options.packs === undefined ? {} : { packs: options.packs }),
  });

  const execution: Execution = {
    ran: new Set(),
    blocks: new Map(),
    values: new Map(),
    nested: new Set(),
    answered: [],
  };
  const opening = hosted?.open(role, {
    watched: (registrations, name) => watched(registrations, name, execution),
    evidenceEngine: (manifest) => evidenceEngine(manifest, execution),
  });
  if (opening !== undefined && "unrun" in opening) return unrunTrace(opening.unrun);
  const opened = opening;
  const runtime = options.model(scenario, trial, opened?.context ?? {});
  const extension = runnerExtension({
    scenario,
    role,
    execution,
    stop,
    // As an installed office, `read_company` reads only the company the trial was given, so it runs
    // for real: a stub could answer it with another company's record.
    real: options.company === undefined ? [] : [READ_COMPANY_TOOL],
  });

  // A host may observe or leave out the role's own hooks. Nothing else about the role changes, and
  // the order is production's: the role's extensions, then this runner's, then the host's.
  const roleExtensions = (extensions: readonly Extension[]): readonly Extension[] =>
    opened === undefined ? extensions : opened.roleExtensions(extensions);
  const selected = roleExtensions(
    selectedExtensions(role.bundle.agent.extensions, role.bundle.extensions),
  );

  const harness = await openOffice({
    storage: "memory",
    models: cappedModels(runtime.models, options.maxOutputTokens),
  });
  // A scenario with a `memory` block runs the role with the portable extension (`./eval-memory.ts`);
  // a host decides its own.
  const memory =
    opened !== undefined
      ? opened.memory(harness, role, scenario)
      : scenario.memory === undefined
        ? undefined
        : bareEvalMemory(harness, role, scenario, sender);
  try {
    // Memory is selected after the role's own extensions, as the runtime selects it: its section
    // changes as records are saved, so it follows the role's stable sections.
    const remembering = memory === undefined ? [] : [memory.extension];
    const agent = {
      ...role.bundle.agent,
      model: runtime.model,
      extensions: [...selected, ...remembering, extension],
    };
    harness.install({
      extensions: [...roleExtensions(role.bundle.extensions), ...remembering, extension],
      agent,
    });
    await memory?.start();
    const settings = opened === undefined ? agent : opened.install(harness, agent);
    const conversation = await harness.conversation(ROOT_KEY, { agent: settings });
    await opened?.started(harness, conversation, settings);
    const text =
      scenario.input.kind === "message"
        ? scenario.input.text
        : `${scenario.input.type}: ${JSON.stringify(scenario.input.payload)}`;
    const delivery = opened === undefined ? { content: text } : opened.delivery(text);
    const submitted = await harness.submit(conversation, {
      input: delivery.content,
      requestId: `eval/${scenario.id}/${trial}`,
      ...(delivery.entry === undefined ? {} : { entry: delivery.entry }),
    });
    const settled = submitted.wait(BACKGROUND_CONTEXT);
    // Stop the run the moment a stop reason is set: `abort` withdraws the queued work and settles the
    // submission `unanswered`, so the trial ends instead of running on to a misleading answer.
    await Promise.race([settled, stopPromise.then(() => harness.abort(conversation))]);
    const settlement = await settled;

    const view = await conversation.context(BACKGROUND_CONTEXT);
    const emitted: EmittedCall[] = view.messages.flatMap((message) =>
      message.role === "assistant"
        ? message.content
            .filter((block) => block.type === "toolCall")
            .map((block) => ({ id: block.id, tool: block.name, args: block.arguments }))
        : [],
    );
    const calls = emitted.map((call) => ({ tool: call.tool, args: call.args }));
    const executedCalls = executedCallsOf(emitted, execution);
    const approvals = opened === undefined ? [] : opened.approvals();
    const turns = view.messages.filter((message) => message.role === "assistant").length;
    // A reply that ended at the output cap: what the model would have said or called is unknown.
    const cutOff = view.messages.some(
      (message) => message.role === "assistant" && message.stopReason === "length",
    );
    // The trial's harness is its own, so its spend is the trial's, every request included.
    const usage = usageTotal(await harness.harness.usage(BACKGROUND_CONTEXT));
    const reply =
      settlement.status === "done" ? await answerText(conversation, settlement) : undefined;
    const unconfirmed = opened?.finish(stopped);
    const unfinished = traceError(
      stopped ?? unconfirmed,
      cutOff ? outputLimitError(options.maxOutputTokens) : undefined,
      settlement,
      runtime.model,
      opened !== undefined && (scenario.expect.calls?.length ?? 0) > 0,
      executedCalls,
    );

    return {
      calls,
      executedCalls,
      approvalsRequested:
        opened === undefined ? approvalsRequested : approvals.map((row) => row.approvalId),
      approvals,
      delegated: [],
      turns,
      received: receivedText(view.messages),
      prompts: promptTexts(view.messages),
      ...(memory === undefined ? {} : { memory: await memory.snapshot() }),
      ...(opened === undefined ? {} : opened.traceExtras()),
      ...(reply === undefined ? {} : { reply }),
      usage,
      ...unfinished,
    };
  } finally {
    await memory?.stop();
    opened?.beforeClose();
    await harness.close();
    opened?.close();
  }
}

/** A trace for a trial that could not start at all: nothing was emitted, so nothing was executed. */
function unrunTrace(error: string): Trace {
  return {
    calls: [],
    executedCalls: [],
    approvalsRequested: [],
    approvals: [],
    delegated: [],
    turns: 0,
    error,
  };
}

/**
 * Bare mode's sender: the scenario's `from`, on its channel, as an outside contact unless the
 * scenario's `origin` says it wrote from inside the office. There is no board to have verified it, so
 * the scenario states it, as a host's gateway would. A scenario that names nobody leaves the sender
 * unknown, as a role given no resolver would see it.
 */
function bareSender(input: Scenario["input"]): SenderResolver {
  // An outside contact unless the scenario says the sender wrote from inside the office.
  const sender =
    input.kind === "message" && input.from !== undefined
      ? {
          origin: input.origin ?? "external",
          channel: input.channel ?? "chat",
          contact: input.from,
        }
      : undefined;
  return async () => sender;
}

/**
 * The approver the scenario scripts: a request it does not script stops the trial, never allowed, and
 * a `pending` one is left unanswered so the run goes on with the call blocked as waiting.
 *
 * A scripted value goes to the gate as a person's would, in the decision's `value`, so the gate's own
 * check decides whether it is a decision at all. An answer that check refuses (out of bounds, or a yes
 * with no value where one is asked) also stops the trial, in the same words, as office mode's store
 * refuses it: a scenario that scripts an unusable answer fails rather than grading what follows.
 */
function scenarioApprover(
  scenario: Scenario,
  approvalsRequested: string[],
  stop: (reason: string) => void,
) {
  return async (request: ApprovalRequest) => {
    approvalsRequested.push(request.approvalId);
    const scripted = scenario.approvals?.[request.approvalId];
    if (scripted === undefined) {
      stop(`the ${request.approvalId} approval is not scripted by the scenario`);
      return { approved: false, by: "eval", note: "not scripted" };
    }
    const { decision, valueCents } = scriptedDecision(scripted);
    if (decision === "pending") return { approved: false, pending: true };
    const answer = {
      approved: decision === "approve",
      by: "eval",
      ...(valueCents === undefined ? {} : { value: valueCents }),
    };
    const refused = approvalValueProblem(request.valueRequest, answer);
    if (refused !== undefined) {
      // The trial's report is for the developer running the eval, so it names the bounds; the model
      // gets only the gate's own block.
      stop(
        `the scripted decision on ${request.approvalId} was refused: ${valueProblemForApprover(refused)}`,
      );
    }
    return answer;
  };
}

/** The SDK's `read_company` tool: the company record, section by section. */
const READ_COMPANY_TOOL = "read_company";

/**
 * The first of the role package's sample company's names, people, emails and phones that a stub of
 * `scenario` carries, as the refusal a `--company` trial gives; `undefined` when none does. Read from
 * the copy generated into the package (`skills/company-handbook/references/facts.json`); a package
 * with none carries no sample company.
 */
export function sampleCompanyInStubs(dir: string, scenario: Scenario): string | undefined {
  const path = join(dir, "skills", "company-handbook", "references", "facts.json");
  if (!existsSync(path)) return undefined;
  const facts = JSON.parse(readFileSync(path, "utf8")) as {
    profile?: { legalName?: string; tradingName?: string; phone?: string; email?: string };
    people?: { name?: string; email?: string; phone?: string }[];
  };
  const tokens = [
    facts.profile?.legalName,
    facts.profile?.tradingName,
    facts.profile?.phone,
    facts.profile?.email,
    ...(facts.people ?? []).flatMap((person) => [person.name, person.email, person.phone]),
  ].filter((token): token is string => typeof token === "string" && token.trim() !== "");
  for (const [tool, stub] of Object.entries(scenario.stubs)) {
    // `read_company` runs for real under --company: its stub is never served.
    if (tool === READ_COMPANY_TOOL) continue;
    const texts =
      "byArgs" in stub
        ? [...stub.byArgs.map((entry) => entry.text), stub.otherwise?.text ?? ""]
        : [stub.text];
    const found = tokens.find((token) => texts.some((text) => text.includes(token)));
    if (found !== undefined) {
      return `the stub for ${tool} says "${found}", from the sample company this role package ships; under --company the office is another company, so write the stub for it`;
    }
  }
  return undefined;
}

/**
 * One extension that stubs every declared tool and stops the run past `limits.maxTurns`. A stub keeps
 * the tool's real name, description and parameters — only `execute` is replaced — so the model sees
 * exactly the tools a real run offers. `read_skill` is not a declared tool and is left real.
 */
function runnerExtension(wiring: {
  readonly scenario: Scenario;
  readonly role: LoadedRole;
  readonly execution: Execution;
  readonly stop: (reason: string) => void;
  /** Declared tools left real: they read only what the trial gave the role. */
  readonly real: readonly string[];
}): Extension {
  const { scenario, role, execution, stop } = wiring;
  const declared = new Set(
    role.manifest.tools.map((tool) => tool.name).filter((name) => !wiring.real.includes(name)),
  );
  const wraps = role.bundle.extensions
    .flatMap((extension) => extension.tools ?? [])
    .filter((tool) => declared.has(tool.name))
    .map((tool) => wrapTool(tool, (original) => stubTool(original, scenario, stop, execution)));

  const hooks: HookRegistration[] = [];
  const maxTurns = scenario.limits?.maxTurns;
  let requests = 0;
  hooks.push(
    hook(GenerationTask, {
      beforeRequest: async () => {
        requests += 1;
        if (maxTurns !== undefined && requests > maxTurns) {
          stop(`the run passed limits.maxTurns (${maxTurns})`);
        }
        return undefined;
      },
    }),
  );
  hooks.push(
    hook(ToolTask, {
      // A nested call is told apart here, where the harness says so: its stub answers a completion
      // check rather than the model.
      beforeTool: (call) => {
        if (call.parent !== undefined) execution.nested.add(call.id);
        return undefined;
      },
      // Execution is recorded for every tool that ran, wrapped by this harness or not: the stub's own
      // wrapper only sees the tools the runner replaced, and a ledger that missed `read_skill` would
      // report a call that ran as one that did not. `afterTool` also sees the error results the
      // harness writes for a call that never ran (a block, invalid arguments, an abort), which carry
      // its own diagnostic codes; those are not executions.
      afterTool: (call, result) => {
        if (!harnessWritten(result)) execution.ran.add(call.id);
        return undefined;
      },
    }),
  );

  return defineExtension({ name: EVAL_EXTENSION_NAME, wraps, hooks });
}

/**
 * The diagnostic codes of the error results Pi Durable writes itself for a call (its `afterTool`
 * contract): an unresolved tool, invalid arguments, a block, an interruption, the restart limit and an
 * abort. A result carrying one was not returned by the tool.
 */
const HARNESS_RESULT_CODES: ReadonlySet<string> = new Set([
  "tool_unavailable",
  "invalid_arguments",
  "blocked",
  "interrupted",
  "restart_limit",
  "aborted",
  "abandoned",
]);

function harnessWritten(result: ToolExecutionResult): boolean {
  return (result.diagnostics ?? []).some(
    (diagnostic) => diagnostic.code !== undefined && HARNESS_RESULT_CODES.has(diagnostic.code),
  );
}

/**
 * The office's own registrations, with their refusals observed.
 *
 * The harness stops at the first `block`: a hook registered after the refusing one never runs, so the
 * only place the refusal can be seen is the refusing hook's own return value. This wraps the
 * registrations the role's `approvalGate` (or `budgetHooks`) built rather than deciding anything itself —
 * the ledger must say what the office did, not what the runner thinks it would have done, or the
 * mutation the ledger is meant to catch (delete the gate and watch `executed` flip to true) would
 * catch nothing.
 */
function watched(
  registrations: readonly HookRegistration[],
  name: string,
  execution: Execution,
): readonly HookRegistration[] {
  return registrations.map((registration) => {
    const handlers = registration.handlers as Partial<ToolHooks>;
    const before = handlers.beforeTool;
    if (before === undefined) return registration;
    return hook(ToolTask, {
      // The registration's other handlers are kept as they are; only `beforeTool` is observed.
      ...handlers,
      beforeTool: async (call, api, context) => {
        // `hooks.each` binds the handlers object as `this`; do the same so a hook that uses `this`
        // behaves here as it does unobserved.
        const decision = await before.call(handlers, call, api, context);
        if (decision?.block !== undefined) {
          execution.blocks.set(call.id, { hook: name, text: decision.block });
        }
        return decision;
      },
    });
  });
}

/** The first `byArgs` entry whose args match the call, else `otherwise`; undefined when neither applies. */
function answerFor(
  stub: Extract<Stub, { byArgs: unknown }>,
  args: unknown,
):
  | {
      text: string;
      isError?: boolean | undefined;
      details?: Readonly<Record<string, unknown>> | undefined;
    }
  | undefined {
  return stub.byArgs.find((entry) => argsMatch(entry.args, args)) ?? stub.otherwise;
}

/** The stub for one declared tool: the scenario's text, or a refusal that stops the trial. */
function stubTool(
  original: ToolRegistration,
  scenario: Scenario,
  stop: (reason: string) => void,
  execution: Execution,
): ToolRegistration {
  const stub = scenario.stubs[original.name];
  return {
    ...original,
    execute: async (args, api) => {
      // The executed ledger's primary record: this is the only place a call actually runs, and a hook
      // that blocked the call never reaches it.
      execution.ran.add(api.callId);
      if (execution.nested.has(api.callId)) return evidenceAnswer(original.name, args, execution);
      const value = handedValue(args);
      if (value !== undefined) execution.values.set(api.callId, value);
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
      const answer = "byArgs" in stub ? answerFor(stub, args) : stub;
      if (answer === undefined) {
        stop(`${original.name} has no stub for these arguments: ${JSON.stringify(args)}`);
        return {
          isError: true,
          output: [
            {
              type: "text" as const,
              text: `${original.name} has no stub for these arguments, so it was not run.`,
            },
          ],
        };
      }
      execution.answered.push({
        tool: original.name,
        args: (args ?? {}) as Readonly<Record<string, unknown>>,
        isError: answer.isError === true,
      });
      return {
        ...(answer.isError === true ? { isError: true } : {}),
        output: [{ type: "text" as const, text: answer.text }],
        // As a real tool returns them: a manifest's `verifies` reads a lookup's id from here.
        ...(answer.details === undefined ? {} : { details: answer.details as JsonObject }),
      };
    },
  };
}

/**
 * A `tool` completion check, run as a nested call of `agent_reply`. A stub cannot say whether the work
 * is done — it answers the same before the work as after — so the check is answered from the trial's
 * record: a record is found once the model's own call of this tool, with the check's arguments,
 * reached its stub and was not answered with an error. Production runs the real tool here.
 */
function evidenceAnswer(tool: string, args: unknown, execution: Execution) {
  const found = execution.answered.some(
    (call) => call.tool === tool && !call.isError && argsMatch(args, call.args),
  );
  return {
    output: [
      {
        type: "text" as const,
        text: found
          ? `The agent's own ${tool} call with these arguments ran in this trial.`
          : `No ${tool} call with these arguments ran in this trial.`,
      },
    ],
    details: { found },
  };
}

/** An engine command split into its subcommand words and its `--flag value` pairs. */
function commandOf(argv: readonly string[]): {
  readonly words: string;
  readonly flags: ReadonlyMap<string, string>;
} {
  const first = argv.findIndex((token) => token.startsWith("--"));
  const words = (first === -1 ? argv : argv.slice(0, first)).join(" ");
  const flags = new Map<string, string>();
  const rest = first === -1 ? [] : argv.slice(first);
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index] ?? "";
    const next = rest[index + 1];
    // `engineArgs` writes a true boolean as a bare flag.
    if (next === undefined || next.startsWith("--")) flags.set(flag, "true");
    else {
      flags.set(flag, next);
      index++;
    }
  }
  return { words, flags };
}

/**
 * The engine an eval's `engine` completion checks run against. The role's engine tools are stubs in
 * an eval, so the real engine never sees the work; the check is answered from the trial's record
 * instead: it finds the work when the model's own call of an engine tool ran the check's subcommand
 * with every one of the check's flags, and was not answered with an error. Production runs the
 * role's engine here.
 */
function evidenceEngine(manifest: AgentManifest, execution: Execution): Engine {
  const tools = new Map(manifest.tools.map((tool) => [tool.name, tool]));
  return {
    async run(argv) {
      const wanted = commandOf(argv);
      const findings = execution.answered.flatMap((call) => {
        const tool = tools.get(call.tool);
        if (tool?.engine === undefined || call.isError) return [];
        const ran = commandOf(engineArgs(tool.engine, tool.parameters, call.args));
        const matches =
          ran.words === wanted.words &&
          [...wanted.flags].every(([flag, value]) => ran.flags.get(flag) === value);
        return matches ? [{ id: `eval:${call.tool}` }] : [];
      });
      return { ok: true, findings, caveats: [] };
    },
  };
}

/**
 * The value the gate handed a call under `APPROVED_VALUE_ARG`, its name and cents; `undefined` when it
 * handed none. Read from the arguments the stub ran with, after the gate, so a value the model put
 * under that key never gets here: the gate strips it first.
 */
function handedValue(args: unknown): NonNullable<ExecutedCall["approvedValue"]> | undefined {
  if (args === null || typeof args !== "object") return undefined;
  const value = (args as Record<string, unknown>)[APPROVED_VALUE_ARG];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { name, cents } = value as Record<string, unknown>;
  return typeof name === "string" && typeof cents === "number" ? { name, cents } : undefined;
}

/**
 * The ledger: one entry per emitted call, in the order the model emitted them. `calls` keeps its old
 * meaning alongside it, so an assertion written against emitted calls does not silently change.
 */
function executedCallsOf(
  emitted: readonly EmittedCall[],
  execution: Execution,
): readonly ExecutedCall[] {
  return emitted.map((call) => {
    if (execution.ran.has(call.id)) {
      const value = execution.values.get(call.id);
      return {
        tool: call.tool,
        args: call.args,
        executed: true,
        ...(value === undefined ? {} : { approvedValue: value }),
      };
    }
    const block = execution.blocks.get(call.id);
    return {
      tool: call.tool,
      args: call.args,
      executed: false,
      ...(block === undefined ? {} : { blockedBy: block.hook, blockText: block.text }),
    };
  });
}

/**
 * Every text the model read, in transcript order.
 *
 * A trial's own record of what arrived, so a scenario can prove its payload reached the model instead
 * of trusting the fixture that wrote it. Tool results are included because a tool result is the one
 * input the fence cannot reach, and it is where an outside system's words arrive.
 */
function receivedText(messages: readonly Message[]): readonly string[] {
  return messages.map((message) => {
    // A system message's prompt sections (the `memory` section, the `team` section) are read too.
    if (message.role === "system") return getSystemMessageText(message);
    if (message.role === "user") {
      if (typeof message.content === "string") return message.content;
      return message.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("");
    }
    return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
  });
}

/** Each system message the model was given, rendered with the sections it set, in order. */
function promptTexts(messages: readonly Message[]): readonly string[] {
  return messages.flatMap((message) =>
    message.role === "system" ? [getSystemMessageText(message)] : [],
  );
}

/** The role's selected extensions, falling back to all of them when the bundle does not list names. */
function selectedExtensions(selected: unknown, all: readonly Extension[]): readonly Extension[] {
  return Array.isArray(selected) ? (selected as readonly Extension[]) : all;
}

/**
 * The settlement reason Pi Durable gives a run the model provider ended: the provider's response was
 * an error (an interrupted stream, a rate limit, a timeout, a server error) that its own retry policy
 * did not recover, and the provider's message is the settlement's `detail`.
 */
const MODEL_ERROR = "model_error";

/**
 * Why the trial did not finish, and whether the model provider is why: the runner's own stop reason
 * first, then a reply cut off at the output cap, then a provider failure, then the positive control,
 * then Pi Durable's settlement.
 *
 * Pi Durable answers a `length` response like a finished one, so a cut-off reply settles `done`; it
 * is still not the agent's whole answer, and a cut-off tool call never ran, so it is never graded.
 *
 * A provider failure comes before the positive control: a stream that died before the first tool
 * call also leaves the ledger empty, and calling that an empty ledger would blame the agent for the
 * provider. A run that settled normally with no call is still the control's failure.
 *
 * The positive control is office mode's alone, because it is the only mode that claims a defence: a
 * trial in which nothing executed cannot tell a working gate from a ledger that saw nothing. It
 * applies only when the scenario expects calls. A scenario whose right answer is a reply with no
 * tool call (another team's request, a decline) expects an empty ledger, and its absences are
 * checked on the emitted calls, which the ledger does not feed.
 */
function traceError(
  stopped: string | undefined,
  cutOff: string | undefined,
  settlement: SettledSubmissionRecord,
  model: ModelRef,
  controlled: boolean,
  executedCalls: readonly ExecutedCall[],
): Pick<Trace, "error" | "errorSource"> {
  if (stopped !== undefined) return { error: stopped };
  if (cutOff !== undefined) return { error: cutOff, errorSource: "output-limit" };
  const unanswered = settlement.status === "unanswered" ? settlementText(settlement) : undefined;
  // The scripted provider calls no service, so its only model error is its own script running out:
  // the scenario author's failure, graded as one, exactly as before.
  if (
    unanswered !== undefined &&
    settlement.reason === MODEL_ERROR &&
    model.provider !== SCRIPTED_PROVIDER_ID
  ) {
    return { error: unanswered, errorSource: "provider" };
  }
  if (controlled && !executedCalls.some((call) => call.executed)) {
    return { error: EMPTY_LEDGER_ERROR };
  }
  return unanswered === undefined ? {} : { error: unanswered };
}

/** An unanswered settlement's own words: its detail when it gave one, else its reason. */
function settlementText(settlement: SettledSubmissionRecord & { status: "unanswered" }): string {
  const detail = settlement.detail;
  return typeof detail === "string" && detail.length > 0 ? detail : settlement.reason;
}
