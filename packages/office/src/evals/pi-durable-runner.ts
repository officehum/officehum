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
 * the one production would produce.
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
import type {
  AgentRunner,
  ApprovalRecord,
  ApprovalRequest,
  ExecutedCall,
  Scenario,
  Trace,
} from "@officehum/sdk";
import { openOffice, ROOT_KEY } from "../adapter/index.js";
import { argsHash, type Board, type Person } from "../board/index.js";
import { createWorkboard, seedPerson } from "../board/testing.js";
import { registerOfficeHooks } from "../extension/office-extension.js";
import type { LoadedRole } from "../roles/load-role.js";
import { loadRole } from "../roles/load-role.js";

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

/** The person a trial's office knows by default, and whose decision a scripted approval is. */
const DEFAULT_PERSON = { id: "ada", name: "Ada" } as const;

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
  bind(conversationId: number): void;
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

  const execution: Execution = { ran: new Set(), blocks: new Map() };
  const office =
    ticketType === undefined
      ? undefined
      : openEvalOffice(options, scenario, trial, role, ticketType, stop);
  const extension = runnerExtension({
    scenario,
    role,
    execution,
    stop,
    ...(office === undefined ? {} : { office }),
  });

  const selected = selectedExtensions(role.bundle.agent.extensions, role.bundle.extensions);
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
        : [extension, ...role.bundle.extensions],
    agent,
  };

  const harness = await openOffice({ storage: "memory", models: runtime.models });
  try {
    harness.install(bundle);
    const conversation = await harness.conversation(ROOT_KEY, { agent });
    office?.bind(conversation.id);
    const submitted = await harness.submit(conversation, {
      input: scenario.input.text,
      requestId: `eval/${scenario.id}/${trial}`,
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
      office === undefined ? [] : approvalRows(office.board, office.ticketId, emitted);
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
  ticketType: string,
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
        type: ticketType,
        title: `Eval ${scenario.id} (trial ${trial})`,
        createdBy: role.manifest.id,
        provenance: { origin: "internal", sourceChannel: "eval", sourceContact: "eval" },
      },
      `eval/${scenario.id}/${trial}`,
    );
    const person = board.people().find((entry) => entry.id === personId);
    if (person === undefined) {
      throw new Error(`The eval office's board knows no person ${JSON.stringify(personId)}.`);
    }
    return {
      board,
      ticketId: ticket.id,
      person,
      stop,
      bind(conversationId) {
        board.bindConversation(conversationId, { ticketId: ticket.id, agent: role.manifest.id });
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
    // refuses, then whatever the role brings.
    hooks.push(decisionHook(scenario, role, office), ...watchedGate(role, office, execution));
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
 * The office's real approval gate, with its refusals observed.
 *
 * The harness stops at the first `block`: a hook registered after the gate never runs when the gate
 * refuses, so the only place the refusal can be seen is the gate's own return value. This wraps the
 * registrations `registerOfficeHooks` built rather than deciding anything itself — the ledger must say
 * what the gate did, not what the runner thinks it would have done, or the mutation it is meant to
 * catch (delete the gate and watch `executed` flip to true) would catch nothing.
 */
function watchedGate(
  role: LoadedRole,
  office: EvalOffice,
  execution: Execution,
): readonly HookRegistration[] {
  // The gate learns which tools wait for a person from the installed manifest's `approvals[].tool`,
  // which is the role's own declaration. Nothing here re-states that list.
  const registrations = registerOfficeHooks({
    board: office.board,
    role: role.manifest.id,
    people: [role.manifest],
  });
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
          execution.blocks.set(call.id, { hook: OFFICE_GATE, text: decision.block });
        }
        // An unscripted approval the gate let through — a covering row left by an earlier call with
        // these exact arguments — is still an approval nobody scripted, so it stops here too.
        noteUnscripted(office);
        return decision;
      },
    });
  });
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
 * **One limit, stated rather than hidden.** The office's gate is keyed by tool: `registerOfficeHooks`
 * gates every tool a manifest declares an approval for, and knows nothing about the manifest's `when`
 * conditions, which are the role's own gate's business. So a decision a scenario scripts for a tool
 * applies to every call of that tool, and a scenario that needs a call to go ungated picks a tool the
 * manifest does not declare. The reason a trial stops says which tool and which declarations, rather
 * than naming one declaration that may not have been the one that applied.
 */
function decisionHook(scenario: Scenario, role: LoadedRole, office: EvalOffice): HookRegistration {
  return hook(ToolTask, {
    beforeTool: (call) => {
      const declarations = role.manifest.approvals.filter((entry) => entry.tool === call.name);
      if (declarations.length === 0) return undefined;
      const scripted = declarations.flatMap((entry) => {
        const decision = scenario.approvals?.[entry.id];
        return decision === undefined ? [] : [{ id: entry.id, decision }];
      });
      const chosen = scripted[0];
      if (chosen === undefined) {
        office.pendingUnscripted =
          `the scenario scripts no decision for ${call.name}; its manifest declares ` +
          declarations.map((entry) => entry.id).join(", ");
        return undefined;
      }
      const conflicting = scripted.find((entry) => entry.decision !== chosen.decision);
      if (conflicting !== undefined) {
        office.pendingUnscripted =
          `the scenario scripts both ${chosen.id} and ${conflicting.id} for ${call.name}, so there ` +
          "is no single answer to apply";
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
 * The approval rows the gate left for the calls this trial made, read from the board.
 *
 * One lookup per call by `(ticket, tool, argsHash)` — the same key the gate decides on, which is why
 * an assertion about these rows is an assertion about the gate rather than about the script. Rows for
 * calls that never happened are not invented, and a call the board has no row for contributes none.
 */
function approvalRows(
  board: Board,
  ticketId: string,
  emitted: readonly EmittedCall[],
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
    rows.set(row.id, {
      ticketId: row.ticketId,
      approvalId: row.approvalId,
      tool: row.tool,
      args: row.args,
      argsHash: row.argsHash,
      status: row.status,
      decidedBy: row.decidedBy,
    });
  }
  return [...rows.values()];
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
