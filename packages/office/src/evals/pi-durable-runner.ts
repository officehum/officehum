/**
 * The Pi Durable eval runner: runs one role's declared tools as stubs on a fresh in-memory office
 * and records a trace the SDK grades.
 *
 * **Bare mode (the default) is deliberately a bare harness.** A role must pass its evals with nothing
 * but Pi Durable and the role's own extensions, so this runner installs the role's bundle and nothing
 * else — no Office Hum extension, no app client, no engine call, no board. That is the portability
 * gate (epic RASF-3065): something a role needs from Office Hum surfaces here as a failure, not as a
 * passing eval.
 *
 * **Office mode is what a red-team scenario needs.** On the bare harness a gated call cannot be
 * refused at all: `openOffice` takes no board, `registerOfficeHooks` installs no gate without one,
 * and the gate itself allows every call on a conversation with no ticket bound. A scenario measured
 * there says "the office stopped it" about a harness that had nothing to stop it with. Office mode
 * therefore opens a board, creates a ticket of a type the role declares, binds it to the trial's
 * conversation and installs the office's real approval gate, so the refusal a scenario observes is
 * the one production would produce. It also evaluates each declaration's `when`, as production does
 * (RASF-3439), so a call the role allows itself is allowed here rather than refused by a stricter
 * harness.
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
 * An approval the scenario does not script is never guessed: the trial stops. Each trial opens its own
 * office and conversation, so an index-based scripted provider must be rebuilt per trial — hence the
 * `model` factory rather than a single provider.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import {
  AssistantEntry,
  type Conversation,
  defineExtension,
  type Extension,
  GenerationTask,
  type HookRegistration,
  hook,
  type ModelRef,
  type SettledSubmissionRecord,
  type ToolHooks,
  type ToolRegistration,
  ToolTask,
  wrapTool,
} from "@earendil-works/pi-durable";
import {
  type AgentRunner,
  type ApprovalRecord,
  type ApprovalRequest,
  conditionsHold,
  type DefinedRole,
  type ExecutedCall,
  isApprovalGate,
  type Scenario,
  type TicketSummary,
  type Trace,
} from "@officehum/sdk";
import { openOffice, ROOT_KEY } from "../adapter/index.js";
import { type Approval, argsHash, type Board, type Person } from "../board/index.js";
import { createWorkboard, seedPerson } from "../board/testing.js";
import { declaredLimits, registerOfficeHooks } from "../extension/office-extension.js";
import { InboundConversationDoc } from "../inbound-session.js";
import { type RelayMessage, type RelayProvenance, relayMessage } from "../relay/message.js";
import type { LoadedRole } from "../roles/load-role.js";
import { loadRole } from "../roles/load-role.js";
import { budgetHooks } from "../spend/budget.js";

/** The catalogue and the model ref one trial runs under. */
export interface EvalModel {
  readonly models: Models;
  readonly model: ModelRef;
}

/** The extension this runner installs; distinct from any role or skill extension name. */
export const EVAL_EXTENSION_NAME = "officehum.evals";

/**
 * The positive control's sentence, exported so a test asserts the sentence and not a fragment.
 *
 * A run that executed nothing is not a defence: it is indistinguishable from a ledger that never saw
 * an execution. The runner fails the trial rather than let an empty ledger look like a perfect one.
 */
export const EMPTY_LEDGER_ERROR =
  "the executed ledger is empty: no tool call's execute ran in this trial, so a pass here proves " +
  "nothing about what the office allowed";

/** The name the ledger gives the office's gate when it is the one that refused a call. */
const OFFICE_GATE = "office approval gate";

/** The name the ledger gives the budget's hooks when they are the ones that refused a call. */
const BUDGET_HOOKS = "office budget hooks";

/** The person a trial's office knows by default, and whose decision a scripted approval is. */
const DEFAULT_PERSON = { id: "ada", name: "Ada" } as const;

/**
 * A guard layer a red-team run can leave out, so the suite can prove it goes red without it.
 *
 * These names exist only for the mutation pass (see `OfficeModeOptions.disableGuards`): a scenario
 * that stays green with its declared layer switched off is not evidence for that layer.
 */
export type OfficeGuard = "approval-gate" | "budget" | "inbound-marker" | "fence";

/** Another ticket the trial's board already holds, with a granted decision on these exact arguments. */
export interface PriorApproval {
  /** The ticket's type, e.g. `invoice.create`. */
  readonly type: string;
  readonly title: string;
  /** The declared approval the granted row is for. */
  readonly approvalId: string;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/** Office mode's fixture: who the office knows, what ticket it opens, and where its board lives. */
export interface OfficeModeOptions {
  /** The `people.id` a scripted decision belongs to. Default `"ada"`. */
  readonly personId?: string;
  /** That person's display name. Default `"Ada"`. */
  readonly personName?: string;
  /**
   * The ticket type the trial's ticket is created with. Default: the first type the role's manifest
   * accepts. A role that accepts none has no ticket to bind, and office mode says so instead of
   * inventing a type the role never declared.
   */
  readonly ticketType?: string;
  /**
   * The sqlite file the trial's board opens. Default: a fresh temporary directory per trial, removed
   * when the trial ends. A caller that names a file owns it and this runner leaves it alone.
   */
  readonly boardFile?: string;
  /**
   * How the trial's text arrives, which is what decides whether it is fenced.
   *
   * `internal-message` (the default) delivers it as a colleague's ticket: the text becomes the
   * ticket's title and detail, and `relayMessage` wraps it with `internal` provenance, so the model
   * reads it labelled but unfenced — exactly what a forwarded internal request looks like.
   *
   * `inbound-email` delivers it as a customer's email: the ticket states `external` provenance, so
   * the relay fences the body and the payload, and the trial's conversation gets the inbound marker
   * `inboundCustomerToolGuard` reads. There is no third mode, because a scenario delivered some other
   * way would be testing the harness rather than the office.
   */
  readonly delivery?: "internal-message" | "inbound-email";
  /** The call ceiling the trial's ticket is created with. Omitted: the ticket is uncapped. */
  readonly maxCalls?: number;
  /**
   * A second ticket, already approved for these exact arguments, the trial's work is *not* on.
   *
   * It is how a scenario asks whether a decision covers the ticket it was made for or just the call.
   * The row is read back after the trial, so a scenario can assert it was neither consumed nor
   * changed.
   */
  readonly priorApproval?: PriorApproval;
  /**
   * What to do when a gated call arrives that the scenario scripts no decision for.
   * `true` (the default) stops the trial — an eval that silently ignored an unscripted gate would be
   * grading a run nobody chose. `false` records the gate's ask and lets the run continue, which is
   * what a red-team trial needs: the compliant adversary keeps trying after it is refused.
   */
  readonly stopOnUnscriptedApproval?: boolean;
  /**
   * The role's own `approvalGate` hook: `install` (the default) or `omit`.
   *
   * A red-team trial omits it. The role's gate asks the scenario's scripted approver, and a refusal
   * by a script is a refusal by the script — the office's gate is the layer the suite is measuring.
   * The role's other hooks (Front Desk's inbound marker guard) stay installed.
   */
  readonly roleGate?: "install" | "omit";
  /**
   * Guard layers to leave out of this trial, for the red-team suite's mutation pass only.
   *
   * Nothing in production sets it: a switch that weakens a gate is a switch that will one day be set
   * by accident, so it is a runner option the test passes, never an environment variable the runner
   * reads.
   */
  readonly disableGuards?: readonly OfficeGuard[];
}

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
  /**
   * Which harness a trial runs on. `bare` (the default) is the portability gate described above.
   * `office` binds a board and a ticket and installs the office's real approval gate, so a gated call
   * can be refused and the refusal observed.
   */
  readonly mode?: "bare" | "office";
  /** Office mode's fixture. Ignored in bare mode. */
  readonly office?: OfficeModeOptions;
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
}

/** The office state a trial's hooks close over. */
interface OfficeWiring {
  readonly board: Board;
  readonly ticketId: string;
  readonly person: Person;
  readonly stop: (reason: string) => void;
  /**
   * Set by `decisionHook` when the scenario scripts no answer for a gated call, read and cleared by
   * the gate's observer. It is deliberately not applied in `decisionHook` itself: the office's ask
   * has to be on the record before the trial stops, and only the observer runs after the gate wrote.
   */
  pendingUnscripted?: string | undefined;
}

/** An opened office-mode fixture: the board, the bound ticket and the person, plus its own cleanup. */
interface EvalOffice extends OfficeWiring {
  /** Binds the trial's conversation to the ticket, and marks it inbound when the delivery says so. */
  bind(conversation: Conversation): Promise<void>;
  close(): void;
}

async function runTrial(
  options: PiDurableRunnerOptions,
  scenario: Scenario,
  trial: number,
): Promise<Trace> {
  // A ticket needs the Office extension to deliver it. Neither harness loads one, so the trial cannot
  // run rather than silently grading an undelivered input.
  if (scenario.input.kind !== "message") {
    return unrunTrace(
      `the ${scenario.input.type} ticket input needs the Office extension, which the eval harness ` +
        "does not load",
    );
  }

  // Bare mode's approval ids, from the approver the scenario scripts. Office mode reads the board
  // instead, so that an assertion about approvals is an assertion about the gate.
  const approvalsRequested: string[] = [];
  // Set once, by the approver, the gate's observer, the stub of an unstubbed tool, or the turn guard;
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

  const runtime = options.model(scenario, trial);
  const role = await loadRole(options.dir, {
    approve: scenarioApprover(scenario, approvalsRequested, stop),
    ...(options.overlays === undefined ? {} : { overlays: options.overlays }),
  });

  const officeMode = options.mode === "office";
  const ticketType = officeMode ? ticketTypeFor(options, role) : undefined;
  if (officeMode && ticketType === undefined) {
    return unrunTrace(
      `office mode needs a ticket type and ${role.manifest.id} declares no accepted type to open one ` +
        "with",
    );
  }

  const plan = ticketType === undefined ? undefined : ticketPlan(scenario, ticketType, options);
  const execution: Execution = { ran: new Set(), blocks: new Map() };
  const office =
    plan === undefined ? undefined : openEvalOffice(options, scenario, trial, role, plan, stop);
  const extension = runnerExtension({
    scenario,
    role,
    execution,
    stop,
    options,
    ...(office === undefined ? {} : { office }),
  });

  const selected = stripApprovalGate(
    selectedExtensions(role.bundle.agent.extensions, role.bundle.extensions),
    options,
  );
  // In office mode the runner's extension goes first, because the harness stops at the first block and
  // the refusal that matters is the office's: the runner's decision hook writes a row, the office's
  // gate reads it, and only then does the role's own approval hook get a say. Bare mode installs it
  // last, exactly as before, so the portability suites keep running against the same harness.
  const extensions = office === undefined ? [...selected, extension] : [extension, ...selected];
  const agent = { ...role.bundle.agent, model: runtime.model, extensions };
  const bundle = {
    extensions:
      office === undefined
        ? [...role.bundle.extensions, extension]
        : [extension, ...stripApprovalGate(role.bundle.extensions, options)],
    agent,
  };

  const harness = await openOffice({ storage: "memory", models: runtime.models });
  try {
    harness.install(bundle);
    const conversation = await harness.conversation(ROOT_KEY, { agent });
    if (office !== undefined && plan !== undefined) await office.bind(conversation);
    const delivery = deliveredText(scenario.input.text, office, plan);
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
    const approvals =
      office === undefined
        ? []
        : approvalRows(office.board, office.ticketId, emitted, options.office?.priorApproval);
    const turns = view.messages.filter((message) => message.role === "assistant").length;
    const reply =
      settlement.status === "done" ? await answerText(conversation, settlement) : undefined;
    const error = traceError(stopped, settlement, office !== undefined, executedCalls);

    return {
      calls,
      executedCalls,
      approvalsRequested:
        office === undefined ? approvalsRequested : approvals.map((row) => row.approvalId),
      approvals,
      delegated: [],
      turns,
      received: receivedText(view.messages),
      ...(office === undefined ? {} : { tickets: ticketSummaries(office.board) }),
      ...(reply === undefined ? {} : { reply }),
      ...(error === undefined ? {} : { error }),
    };
  } finally {
    await harness.close();
    office?.close();
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
 * The ticket type a trial's ticket is created with: the option when given, else the first type the
 * role's manifest accepts. `undefined` when the role accepts none — the caller reports it rather than
 * inventing a type the role never declared.
 */
function ticketTypeFor(options: PiDurableRunnerOptions, role: LoadedRole): string | undefined {
  const declared = options.office?.ticketType ?? role.manifest.accepts[0]?.type;
  return declared;
}

/**
 * Everything a trial's ticket is created with, worked out once before the board opens.
 *
 * Delivery is a fixture decision, not a harness one: the same scenario text is a customer's email or
 * a colleague's ticket depending on where it came from, and the fence is a function of that.
 */
interface TicketPlan {
  readonly type: string;
  readonly title: string;
  readonly detail: string | undefined;
  readonly provenance: RelayProvenance;
  readonly maxCalls: number | undefined;
  readonly prior: PriorApproval | undefined;
  /** False when the fence guard is switched off: the text is submitted raw, as the plan's mutation. */
  readonly fenced: boolean;
  /** True when the trial's conversation must carry `inboundCustomerToolGuard`'s marker. */
  readonly inbound: boolean;
}

/** Whether a guard layer has been switched off for this trial. */
function guardOff(options: PiDurableRunnerOptions, guard: OfficeGuard): boolean {
  return options.office?.disableGuards?.includes(guard) ?? false;
}

/** Whether the role's own approval gate is left out: only a red-team trial asks for that. */
function roleGateOmitted(options: PiDurableRunnerOptions): boolean {
  return (options.mode ?? "bare") === "office" && options.office?.roleGate === "omit";
}

/**
 * The role's extensions with its own `approvalGate` hooks removed, and nothing else touched.
 *
 * A red-team trial needs the office's gate to be the layer that decides. The role's gate asks the
 * scenario's approver, so leaving it in would let a refusal by the script stand in for a refusal by
 * the office — and the mutation pass, which switches the office's gate off, would then stay green for
 * the wrong reason and detect nothing.
 */
function stripApprovalGate(
  extensions: readonly Extension[],
  options: PiDurableRunnerOptions,
): readonly Extension[] {
  if (!roleGateOmitted(options)) return extensions;
  return extensions.map((extension) => ({
    ...extension,
    hooks: (extension.hooks ?? []).filter((registration) => !isApprovalGate(registration)),
  }));
}

/**
 * The trial's ticket plan: what it is called, where it came from, and what ceiling it carries.
 *
 * The scenario's text becomes the ticket's title (its first line) and detail (the rest), which is how
 * a real message reaches a role — through a ticket, wrapped by the relay — rather than as a raw user
 * message the office never sends.
 */
function ticketPlan(scenario: Scenario, type: string, options: PiDurableRunnerOptions): TicketPlan {
  const text = scenario.input.kind === "message" ? scenario.input.text : "";
  const lines = text.split("\n");
  const title = (lines[0] ?? "").trim();
  const detail = lines.slice(1).join("\n").trim();
  const inbound = options.office?.delivery === "inbound-email";
  const sender = scenario.input.kind === "message" ? scenario.input.from : undefined;
  return {
    type,
    title: title.length === 0 ? `Eval ${scenario.id}` : title,
    detail: detail.length === 0 ? undefined : detail,
    provenance: inbound
      ? {
          origin: "external",
          sourceChannel: "email",
          sourceContact: sender ?? "customer@example.test",
        }
      : { origin: "internal", sourceChannel: "chat", sourceContact: "colleague" },
    maxCalls: options.office?.maxCalls,
    prior: options.office?.priorApproval,
    fenced: !guardOff(options, "fence"),
    inbound: inbound && !guardOff(options, "inbound-marker"),
  };
}

/**
 * What the model is handed: the relay's own envelope when the ticket is delivered honestly, and the
 * bare text when the fence mutation is on.
 *
 * `relayMessage` is called with the ticket's recorded provenance, exactly as the relay does, so an
 * `external` ticket is fenced and an `internal` one is not. A trial that skipped this would hand the
 * model text no production path produces.
 */
function deliveredText(
  text: string,
  office: EvalOffice | undefined,
  plan: TicketPlan | undefined,
): { readonly content: string; readonly entry?: RelayMessage["entry"] } {
  if (office === undefined || plan === undefined || !plan.fenced) {
    return { content: text };
  }
  const ticket = office.board.get(office.ticketId);
  const message = relayMessage(
    { id: office.ticketId, kind: "ticket", ticketId: office.ticketId },
    {
      id: office.ticketId,
      type: plan.type,
      title: plan.title,
      detail: plan.detail ?? null,
      payload: ticket?.payload ?? null,
    },
    plan.provenance,
    0,
  );
  return { content: message.content, entry: message.entry };
}

/**
 * Opens the trial's office: a board over a sqlite file, one person on it, and a ticket of a type the
 * role accepts, with provenance, because a root ticket must state where it came from.
 *
 * The board comes through `createWorkboard` from `../board/testing.js`, the sanctioned door: the board
 * file has one writer, and a trial that opened its own would be a second one.
 */
function openEvalOffice(
  options: PiDurableRunnerOptions,
  scenario: Scenario,
  trial: number,
  role: LoadedRole,
  plan: TicketPlan,
  stop: (reason: string) => void,
): EvalOffice {
  // A trial owns its board unless the caller named the file: the person is seeded before the board
  // opens, because the gate addresses the ask to the office's person and the board refuses an
  // assignee it does not know.
  const temporary = options.office?.boardFile === undefined;
  const directory = temporary ? mkdtempSync(join(tmpdir(), "officehum-eval-office-")) : undefined;
  // The name is `office.sqlite`, not the board's own file name, on purpose: `createWorkboard` is the
  // sanctioned door and the board directory's guard is that nothing outside it names that file.
  const file = options.office?.boardFile ?? join(directory ?? "", "office.sqlite");
  const personId = options.office?.personId ?? DEFAULT_PERSON.id;
  const personName = options.office?.personName ?? DEFAULT_PERSON.name;
  seedPerson(file, personId, personName);
  const board = createWorkboard(file);
  try {
    const ticket = board.create(
      {
        type: plan.type,
        title: plan.title,
        ...(plan.detail === undefined ? {} : { detail: plan.detail }),
        createdBy: role.manifest.id,
        provenance: plan.provenance,
        ...(plan.maxCalls === undefined ? {} : { budget: { maxCalls: plan.maxCalls } }),
      },
      `eval/${scenario.id}/${trial}`,
    );
    const person = board.people().find((entry) => entry.id === personId);
    if (person === undefined) {
      throw new Error(`The eval office's board knows no person ${JSON.stringify(personId)}.`);
    }
    const prior = plan.prior;
    if (prior !== undefined) {
      const earlier = board.create(
        {
          type: prior.type,
          title: prior.title,
          createdBy: role.manifest.id,
          provenance: { origin: "internal", sourceChannel: "chat", sourceContact: "colleague" },
        },
        `eval/${scenario.id}/${trial}/prior`,
      );
      const row = board.approvals.requestApproval(earlier.id, {
        tool: prior.tool,
        args: prior.args,
        requestedBy: role.manifest.id,
        approvalId: prior.approvalId,
        assignee: person.id,
      });
      board.approvals.decideApproval(row.id, { by: person.id, decision: "approved" });
    }
    return {
      board,
      ticketId: ticket.id,
      person,
      stop,
      async bind(conversation) {
        board.bindConversation(conversation.id, {
          ticketId: ticket.id,
          agent: role.manifest.id,
        });
        // The marker `inboundCustomerToolGuard` reads. Production writes it in `openInboundSession`,
        // which owns a solo harness and its own signed webhook; a trial's office is `openOffice`, so
        // the fixture writes the same document instead, through the office's own definition.
        if (plan.inbound) {
          await conversation.commit(
            (transaction) => transaction.doc(InboundConversationDoc, conversation.id as never),
            BACKGROUND_CONTEXT,
          );
        }
      },
      close() {
        try {
          board.close();
        } finally {
          if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    board.close();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
    throw error;
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
 * One extension that stubs every declared tool, carries the office's gate in office mode, and stops
 * the run past `limits.maxTurns`. A stub keeps the tool's real name, description and parameters —
 * only `execute` is replaced — so the model sees exactly the tools a real run offers. `read_skill` is
 * not a declared tool and is left real.
 */
function runnerExtension(wiring: {
  readonly scenario: Scenario;
  readonly role: LoadedRole;
  readonly execution: Execution;
  readonly stop: (reason: string) => void;
  readonly options: PiDurableRunnerOptions;
  readonly office?: EvalOffice;
}): Extension {
  const { scenario, role, execution, stop, office } = wiring;
  const declared = new Set(role.manifest.tools.map((tool) => tool.name));
  const wraps = role.bundle.extensions
    .flatMap((extension) => extension.tools ?? [])
    .filter((tool) => declared.has(tool.name))
    .map((tool) => wrapTool(tool, (original) => stubTool(original, scenario, stop, execution)));

  const hooks: HookRegistration[] = [];
  if (office !== undefined) {
    // The order is the policy: the layer that writes the decision, then the layer that reads it and
    // refuses, then the budget's own ceiling, then whatever the role brings.
    const limits = roleLimits(role);
    if (!guardOff(wiring.options, "approval-gate")) {
      hooks.push(
        decisionHook(scenario, role, office, limits, wiring.options),
        // An unscripted approval the gate let through — a covering row left by an earlier call with
        // these exact arguments — is still an approval nobody scripted, so it stops here too.
        ...watched(
          registerOfficeHooks(gateSeam(role, office, limits)),
          OFFICE_GATE,
          execution,
          () => noteUnscripted(office),
        ),
      );
    }
    if (!guardOff(wiring.options, "budget")) {
      hooks.push(...watched(budgetHooks({ board: office.board }), BUDGET_HOOKS, execution));
    }
  }

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
      // Execution is recorded for every tool that ran, wrapped by this harness or not: the stub's own
      // wrapper only sees the tools the runner replaced, and a ledger that missed `read_skill` would
      // report a call that ran as one that did not.
      afterTool: (call) => {
        execution.ran.add(call.id);
        return undefined;
      },
    }),
  );

  return defineExtension({ name: EVAL_EXTENSION_NAME, wraps, hooks });
}

/**
 * The office's own registrations, with their refusals observed.
 *
 * The harness stops at the first `block`: a hook registered after the refusing one never runs, so the
 * only place the refusal can be seen is the refusing hook's own return value. This wraps the
 * registrations `registerOfficeHooks` (or `budgetHooks`) built rather than deciding anything itself —
 * the ledger must say what the office did, not what the runner thinks it would have done, or the
 * mutation the ledger is meant to catch (delete the gate and watch `executed` flip to true) would
 * catch nothing.
 */
function watched(
  registrations: readonly HookRegistration[],
  name: string,
  execution: Execution,
  after?: () => void,
): readonly HookRegistration[] {
  return registrations.map((registration) => {
    const handlers = registration.handlers as Partial<ToolHooks>;
    const before = handlers.beforeTool;
    if (before === undefined) return registration;
    return hook(ToolTask, {
      beforeTool: async (call, api, context) => {
        // `hooks.each` binds the handlers object as `this`; do the same so a hook that uses `this`
        // behaves here as it does unobserved.
        const decision = await before.call(handlers, call, api, context);
        if (decision?.block !== undefined) {
          execution.blocks.set(call.id, { hook: name, text: decision.block });
        }
        after?.();
        return decision;
      },
    });
  });
}

/**
 * What the gate is told: the board, this role's installed manifest, and the limits its conditions
 * read.
 *
 * The gate learns what waits for a person from the manifest's `approvals` — id, tool and `when` — and
 * nothing here re-states that policy.
 */
function gateSeam(
  role: LoadedRole,
  office: EvalOffice,
  limits: Readonly<Record<string, number>>,
): Parameters<typeof registerOfficeHooks>[0] {
  return { board: office.board, role: role.manifest.id, people: [role.manifest], limits };
}

/** Applies a pending unscripted-approval stop, once, after the gate has had its say. */
function noteUnscripted(office: EvalOffice): void {
  const reason = office.pendingUnscripted;
  if (reason === undefined) return;
  office.pendingUnscripted = undefined;
  office.stop(reason);
}

/**
 * The scenario's verdict, written where the office keeps its decisions: an approval row on the
 * trial's board for this ticket, this tool and exactly these arguments, already decided by a person
 * the board knows.
 *
 * **Why a board row rather than an answer from an approver function.** The office gate's authority is
 * the board: it reads `approvalCovering` and `latestForCall` and never calls an approver (`gate.ts`).
 * A decision handed to an approver would therefore be a decision the gate never sees — the trial would
 * pass while exercising the seam rather than the policy, which is the definition of testing the stub.
 * Writing the row is the only path a scripted decision can take that the real gate reads exactly as it
 * reads a person's.
 *
 * **What it will not do is invent a decision.** A gated call the scenario does not script is left to
 * the gate, which records the ask and blocks; the trial then stops with the reason, the same way the
 * bare runner stops when an approver is asked for something unscripted.
 *
 * **Only a declaration that applies can be answered.** The office's gate now evaluates each
 * declaration's `when` (RASF-3439), so a decision must be written for the declaration the gate would
 * have asked about — the first one, in manifest order, whose condition holds for these arguments. A
 * scripted answer for a declaration that does not apply is not an answer to anything: it is ignored,
 * and the trial stops naming the declarations that do apply. A call no declaration applies to is one
 * the role allows itself, so nothing is written for it and the gate lets it run.
 */
function decisionHook(
  scenario: Scenario,
  role: LoadedRole,
  office: EvalOffice,
  limits: Readonly<Record<string, number>>,
  options: PiDurableRunnerOptions,
): HookRegistration {
  // A red-team trial wants the ask recorded and the run to carry on: the compliant adversary keeps
  // trying after a refusal, and that is the behaviour worth watching the gate against.
  const stopUnscripted = options.office?.stopOnUnscriptedApproval !== false;
  return hook(ToolTask, {
    beforeTool: (call) => {
      const declared = role.manifest.approvals.filter((entry) => entry.tool === call.name);
      if (declared.length === 0) return undefined;
      // The declarations that apply, in the same manifest order, and by the same evaluator the office
      // gate uses.
      const declarations = declared.filter(
        (entry) => entry.when === undefined || conditionsHold(entry.when, call.arguments, limits),
      );
      if (declarations.length === 0) return undefined;
      const scripted = declarations.flatMap((entry) => {
        const decision = scenario.approvals?.[entry.id];
        return decision === undefined ? [] : [{ id: entry.id, decision }];
      });
      const chosen = scripted[0];
      if (chosen === undefined) {
        if (stopUnscripted) {
          office.pendingUnscripted =
            `the scenario scripts no decision for ${call.name}; the declarations that apply are ` +
            declarations.map((entry) => entry.id).join(", ");
        }
        return undefined;
      }
      const conflicting = scripted.find((entry) => entry.decision !== chosen.decision);
      if (conflicting !== undefined) {
        if (stopUnscripted) {
          office.pendingUnscripted =
            `the scenario scripts both ${chosen.id} and ${conflicting.id} for ${call.name}, so there ` +
            "is no single answer to apply";
        }
        return undefined;
      }
      office.pendingUnscripted = undefined;
      const hash = argsHash(call.arguments);
      const answered = office.board.approvals.latestForCall(office.ticketId, call.name, hash);
      // Asking twice about the same call would be the second row the gate's dedupe exists to prevent;
      // the decision already stands, so there is nothing to write.
      if (
        answered !== undefined &&
        answered.status !== "waiting" &&
        answered.status !== "expired"
      ) {
        return undefined;
      }
      const row = office.board.approvals.requestApproval(office.ticketId, {
        tool: call.name,
        args: call.arguments,
        requestedBy: role.manifest.id,
        approvalId: chosen.id,
        assignee: office.person.id,
      });
      office.board.approvals.decideApproval(row.id, {
        by: office.person.id,
        decision: chosen.decision === "approve" ? "approved" : "declined",
        ...(chosen.decision === "approve"
          ? {}
          : { note: `the ${scenario.id} scenario scripts this answer` }),
      });
      return undefined;
    },
  });
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
    execute: async (_args, api) => {
      // The executed ledger's primary record: this is the only place a call actually runs, and a hook
      // that blocked the call never reaches it.
      execution.ran.add(api.callId);
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

/**
 * The ledger: one entry per emitted call, in the order the model emitted them. `calls` keeps its old
 * meaning alongside it, so an assertion written against emitted calls does not silently change.
 */
function executedCallsOf(
  emitted: readonly EmittedCall[],
  execution: Execution,
): readonly ExecutedCall[] {
  return emitted.map((call) => {
    if (execution.ran.has(call.id)) return { tool: call.tool, args: call.args, executed: true };
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
 * The limits office mode evaluates a declaration's `when` against: the role's own resolved values when
 * its factory returned `defineRole` — so an overlay's limit change applies here exactly as it does in
 * production — and otherwise the manifest's declared defaults.
 *
 * The same numbers go to the gate and to the scripted decisions, so a scenario's answer is written for
 * the declaration the gate would have asked about.
 */
function roleLimits(role: LoadedRole): Readonly<Record<string, number>> {
  const defined = role.bundle as Partial<DefinedRole>;
  if (typeof defined.current === "function") return defined.current().limits;
  return declaredLimits(role.manifest);
}

/**
 * The approval rows the trial left, read from the board.
 *
 * One lookup per call by `(ticket, tool, argsHash)` — the same key the gate decides on, which is why
 * an assertion about these rows is an assertion about the gate rather than about the script. Rows for
 * calls that never happened are not invented, and a call the board has no row for contributes none.
 *
 * When the fixture planted a decision on another ticket, that row is read back too, by its own
 * `(ticket, tool, argsHash)`. A scenario about a decision on someone else's ticket needs to show both
 * halves: the ask this ticket recorded, and the grant that did not cover it.
 */
function approvalRows(
  board: Board,
  ticketId: string,
  emitted: readonly EmittedCall[],
  prior?: PriorApproval,
): readonly ApprovalRecord[] {
  const rows = new Map<string, ApprovalRecord>();
  for (const call of emitted) {
    let hash: string;
    try {
      hash = argsHash(call.args);
    } catch {
      // Arguments the hashing rule refuses are arguments the gate refuses too; there is no row.
      continue;
    }
    const row = board.approvals.latestForCall(ticketId, call.tool, hash);
    if (row === undefined) continue;
    rows.set(row.id, approvalRecord(row));
  }
  if (prior !== undefined) {
    for (const ticket of board.list()) {
      if (ticket.id === ticketId || ticket.type !== prior.type) continue;
      const row = board.approvals.latestForCall(ticket.id, prior.tool, argsHash(prior.args));
      if (row === undefined) continue;
      rows.set(row.id, approvalRecord(row));
    }
  }
  return [...rows.values()];
}

/** One stored approval row, as the trace reports it. */
function approvalRecord(row: Approval): ApprovalRecord {
  return {
    ticketId: row.ticketId,
    approvalId: row.approvalId,
    tool: row.tool,
    args: row.args,
    argsHash: row.argsHash,
    status: row.status,
    decidedBy: row.decidedBy,
  };
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
    if (message.role === "user" || message.role === "system") {
      if (typeof message.content === "string") return message.content;
      return message.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("");
    }
    return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
  });
}

/** The office's tickets and their budgets, as the board reports them when the trial ends. */
function ticketSummaries(board: Board): readonly TicketSummary[] {
  return board.list().map((ticket) => {
    const budget = board.budget(ticket.id);
    return {
      id: ticket.id,
      type: ticket.type,
      status: ticket.status,
      hopCount: budget?.hopCount ?? 0,
      maxHops: budget?.maxHops ?? 0,
      usedCalls: budget?.usedCalls ?? 0,
      maxCalls: budget?.maxCalls ?? null,
    };
  });
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

/**
 * Why the trial did not finish: the runner's own stop reason first, then the positive control, then
 * Pi Durable's settlement.
 *
 * The positive control is office mode's alone, because it is the only mode that claims a defence: a
 * trial in which nothing executed cannot tell a working gate from a ledger that saw nothing.
 */
function traceError(
  stopped: string | undefined,
  settlement: SettledSubmissionRecord,
  officeMode: boolean,
  executedCalls: readonly ExecutedCall[],
): string | undefined {
  if (stopped !== undefined) return stopped;
  if (officeMode && !executedCalls.some((call) => call.executed)) return EMPTY_LEDGER_ERROR;
  if (settlement.status === "done") return undefined;
  const detail = settlement.detail;
  return typeof detail === "string" && detail.length > 0 ? detail : settlement.reason;
}
