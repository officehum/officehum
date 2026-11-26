/**
 * Approval gates: a Pi Durable `beforeTool` hook that holds gated actions until a person decides.
 *
 * Safe by default: with no approver supplied (a role on a bare Pi Durable install), every gated
 * action is blocked. Inside Office Hum the approver is backed by the Inbox. Each decision is kept in
 * the tool task's memo, so a crash never asks twice and never forgets a yes.
 *
 * An approval can have a facts reader. The gate then reads what the person is asked to approve from
 * the role's own records (a desk, a ledger), not from the model's arguments, shows it with the ask,
 * and on a yes hands exactly those facts to the tool under `APPROVED_FACTS_ARG`. The tool, or the desk
 * behind it, compares them with the record as it stands when it writes, so a grant never covers
 * something nobody was shown. The facts travel in the arguments because Pi Durable's
 * `ToolExecutionApi` has no memo a tool could read them from.
 */

import {
  type DocumentReader,
  type HookRegistration,
  hook,
  type JsonObject,
  type ToolHooks,
  ToolTask,
} from "@earendil-works/pi-durable";
import { obj, opt } from "@earendil-works/pi-schema";
import { canonicalJson, sameCanonical } from "./canonical-json.js";
import type {
  ApprovalDeclaration,
  ApprovalValueDeclaration,
  ConditionDeclaration,
} from "./manifest.js";
import { limitName } from "./manifest.js";

/** The cancellation and deadline context Pi Durable passes to hooks. */
export type HookContext = Parameters<ToolHooks["beforeTool"]>[2];

/** A tool call's arguments, as the model sent them after validation. */
export type ToolArguments = Readonly<Record<string, unknown>>;

/** Durable documents and resolved limits available to an approval condition, without mutation methods. */
export type ApprovalConditionContext = {
  /** The hook's document reader, bound to this call. */
  readonly read: DocumentReader;
  /**
   * The role's resolved limits, e.g. `{ large_invoice: 2500 }`: the manifest's defaults with the
   * business's overlay applied. A code condition reads the same values a `{ "limit": "NAME" }`
   * condition resolves against.
   */
  readonly limits: Readonly<Record<string, number>>;
  /**
   * The call's conversation and task, from the hook's context (never an argument): the pair a
   * `SenderResolver` takes, so a condition can ask the host about who the work is for.
   */
  readonly conversationId: unknown;
  readonly taskId: unknown;
};

/** Decides whether an approval applies to this exact tool intent. */
export type ApprovalCondition = (
  args: ToolArguments,
  environment: ApprovalConditionContext,
  context: HookContext,
) => boolean | Promise<boolean>;

/**
 * What a person approves, as the role's own records hold it: a one-line summary for the person, and
 * the facts the tool is bound to on a yes.
 */
export interface ApprovalFacts {
  readonly summary: string;
  readonly facts: Record<string, unknown>;
}

/**
 * Reads an approval's facts for one call, from the role's records. It sees the call's arguments
 * without `APPROVED_FACTS_ARG`, and the call's conversation and task, the same pair a
 * `SenderResolver` takes, so a role can read only what the call's sender may see. Throwing blocks
 * the call with the error's message and asks nobody, so a reader that cannot find the thing to
 * approve says why in words the model can act on.
 */
export type ApprovalFactsReader = ((
  args: ToolArguments,
  context: HookContext,
  call: ApprovalCallIdentity,
) => Promise<ApprovalFacts>) & {
  /**
   * The top-level fields of the facts this reader returns, when it states them (`declaredFacts`).
   * `checkAgent` reads them: an approval on an unsafe tool whose facts carry a `…Cents` field must
   * declare its `amount`, so an approver's limit is compared with the real figure.
   */
  readonly fields?: readonly string[];
};

/**
 * A facts reader that states the fields of the facts it returns, and holds itself to them: facts with
 * a field it does not declare, or missing one it does, are refused (the gate then blocks the call and
 * asks nobody), so the statement `checkAgent` reads cannot drift from what the person is shown.
 */
export function declaredFacts(
  fields: readonly string[],
  read: (
    args: ToolArguments,
    context: HookContext,
    call: ApprovalCallIdentity,
  ) => Promise<ApprovalFacts>,
): ApprovalFactsReader {
  const stated = [...fields];
  const reader = async (
    args: ToolArguments,
    context: HookContext,
    call: ApprovalCallIdentity,
  ): Promise<ApprovalFacts> => {
    const facts = await read(args, context, call);
    const keys = Object.keys(facts.facts);
    const extra = keys.filter((key) => !stated.includes(key));
    const missing = stated.filter((key) => !keys.includes(key));
    if (extra.length > 0) {
      throw new Error(
        `This approval's facts reader returned facts it does not declare: ${extra.map((key) => JSON.stringify(key)).join(", ")}.`,
      );
    }
    if (missing.length > 0) {
      throw new Error(
        `This approval's facts reader lacks declared facts: ${missing.map((key) => JSON.stringify(key)).join(", ")}.`,
      );
    }
    return facts;
  };
  return Object.assign(reader, { fields: stated });
}

/** The conversation and task a gated call belongs to, from the hook's API, never from arguments. */
export interface ApprovalCallIdentity {
  readonly conversationId: unknown;
  readonly taskId: unknown;
}

/** A gated call a person declined, as a declined handler receives it. */
export interface DeclinedApproval extends ApprovalCallIdentity {
  /**
   * The call's id, stable across replay and restart. A handler that writes derives its request id
   * from it, so a write repeated after a crash is the same write.
   */
  readonly callId: string;
  /** What the person was shown and declined, when the approval has a facts reader. */
  readonly facts?: ApprovalFacts;
  /** The decision's note, e.g. the person's reason or the runtime's `timed out`. */
  readonly note?: string;
}

/**
 * Undoes what a call proposed once a person has declined it, or once the request expired unanswered
 * (an approver reports an expiry as a decline). It sees the call's arguments without
 * `APPROVED_FACTS_ARG` and the facts the person was shown, never the model's text. It returns a
 * sentence for the model saying what it recorded, or nothing.
 *
 * It runs only for a request a person was actually asked: never for a call refused because no
 * approver is configured (nobody was asked, so nothing was proposed to anyone and there is nothing to
 * undo), never for a call whose facts reader refused, and never while the answer is pending. It runs
 * once per call: its outcome is memoised beside the decision, so a replay or a restart repeats the
 * outcome without running it again. A crash after its write and before the memo runs it again with
 * the same `callId`. If it throws, the call stays blocked: the failure is memoised as its outcome and
 * the block tells the model it.
 */
export type ApprovalDeclinedHandler = (
  args: ToolArguments,
  declined: DeclinedApproval,
  context: HookContext,
) => Promise<string | undefined>;

/**
 * The argument the gate sets to the approved facts. The gate overwrites or removes it on every call,
 * whatever the model sent, so a tool reading it with `approvedFacts` reads only what a person saw.
 */
export const APPROVED_FACTS_ARG = "officehumApprovedFacts";

/**
 * The schema entry a tool with an approval facts reader declares for `APPROVED_FACTS_ARG`. Pi Durable
 * validates the arguments a `beforeTool` hook returns against the tool's parameters again, so a tool
 * whose parameters refuse additional properties must declare the key, or every approved call fails
 * validation. Optional: the model never supplies it, and the gate replaces it if it does.
 */
export function approvedFactsParameter() {
  return opt(obj({}, { open: true, description: "set by the approval gate; never supply it" }));
}

/**
 * The argument the gate sets to the value a person entered with their yes, for an
 * approval that declares a `value`. Like `APPROVED_FACTS_ARG`, it is the gate's alone: whatever the
 * model sent under it is dropped before anything reads the arguments.
 */
export const APPROVED_VALUE_ARG = "officehumApprovedValue";

/** What the person is asked to enter, with the bounds pinned to the request when it was made. */
export interface ApprovalValueRequest {
  /** The tool's name for it, e.g. `creditCents`. */
  readonly name: string;
  /** What the person is asked for, e.g. "Credit to give". */
  readonly label: string;
  /** The lowest whole number of cents the person may enter. */
  readonly min: number;
  /** The highest, when there is one. */
  readonly max?: number;
}

/** The value a person entered, as the gate hands it to the tool under `APPROVED_VALUE_ARG`. */
export interface ApprovedValue {
  readonly name: string;
  /** Whole cents. */
  readonly cents: number;
  /** Who entered it, as the approver reported them; `null` when the approver did not say. */
  readonly by: string | null;
}

/**
 * The schema entry a tool for an approval that declares a value adds for `APPROVED_VALUE_ARG`, for the
 * same reason as `approvedFactsParameter()`: Pi Durable validates the gate's rewritten arguments
 * against the tool's parameters again. `checkAgent` reports such a tool without it.
 */
export function approvedValueParameter() {
  return opt(obj({}, { open: true, description: "set by the approval gate; never supply it" }));
}

/**
 * The value a person entered for this call, by the name the approval declares. Throws when the call
 * carries none or carries another name, so a tool never writes without the person's figure and never
 * falls back to a figure in its other arguments.
 */
export function approvedValue(args: ToolArguments, name: string): ApprovedValue {
  const value = args[APPROVED_VALUE_ARG];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `This call carries no approved ${name}: a person enters it when they approve, and the approval gate hands it to the tool.`,
    );
  }
  const { name: carried, cents, by } = value as Record<string, unknown>;
  if (carried !== name) {
    throw new Error(`This call's approved value is ${JSON.stringify(carried)}, not ${name}.`);
  }
  if (typeof cents !== "number" || !Number.isSafeInteger(cents)) {
    throw new Error(`This call's approved ${name} is not a whole number of cents.`);
  }
  if (by !== null && typeof by !== "string") {
    throw new Error(`This call's approved ${name} does not say who entered it.`);
  }
  return { name, cents, by };
}

/**
 * Pins an approval's value request: its fixed bounds, or the facts its bounds name, read from the facts
 * the role's reader read for this call. Returns why it cannot when a fact bound is missing or not a
 * whole number of cents, or the bounds leave nothing to enter; the gate then asks nobody.
 */
export function resolveValueRequest(
  declaration: ApprovalValueDeclaration,
  facts?: Readonly<Record<string, unknown>>,
): { readonly request: ApprovalValueRequest } | { readonly problem: string } {
  const bound = (fixed: number | undefined, fact: string | undefined, fallback?: number) => {
    if (fixed !== undefined || fact === undefined) return { cents: fixed ?? fallback };
    const read = facts?.[fact];
    return typeof read === "number" && Number.isSafeInteger(read)
      ? { cents: read }
      : {
          problem: `The bound ${fact} for "${declaration.label}" could not be read from the role's records as a whole number of cents, so nobody was asked.`,
        };
  };
  const low = bound(declaration.min, declaration.minFact, 0);
  if ("problem" in low) return { problem: low.problem };
  const high = bound(declaration.max, declaration.maxFact);
  if ("problem" in high) return { problem: high.problem };
  const min = low.cents as number;
  const max = high.cents;
  if (max !== undefined && min > max) {
    // The gate blocks with this text, which the model reads, so it names no bound: a bound read from
    // the records can be another person's pay.
    return {
      problem: `The bounds for "${declaration.label}" leave nothing to enter, so nobody was asked.`,
    };
  }
  return {
    request: {
      name: declaration.name,
      label: declaration.label,
      min,
      ...(max === undefined ? {} : { max }),
    },
  };
}

/**
 * Why an answer is not a decision, with what the approver needs to correct it. It carries the
 * request's bounds, which may be read from the role's records (one employee's gross pay), so it is
 * formatted for the approver (`valueProblemForApprover`) and never shown to the model: the gate tells
 * the model only `valueProblemForModel`.
 */
export type ApprovalValueProblem =
  | { readonly code: "decline_with_value" }
  | { readonly code: "value_not_asked" }
  | { readonly code: "value_missing"; readonly request: ApprovalValueRequest }
  | {
      readonly code: "not_whole_cents";
      readonly request: ApprovalValueRequest;
      readonly value: unknown;
    }
  | {
      readonly code: "out_of_bounds";
      readonly request: ApprovalValueRequest;
      readonly cents: number;
    };

/**
 * Why a decision is not an acceptable answer to a request, or `undefined` when it is. The one rule,
 * used by the gate for every answer and by the runtime before it records one:
 * - a yes to a request that asks for no value carries none;
 * - a yes to one that asks for a value carries a whole number of cents inside the pinned bounds;
 * - a no never carries a value.
 */
export function approvalValueProblem(
  request: ApprovalValueRequest | undefined,
  decision: { readonly approved: boolean; readonly value?: unknown },
): ApprovalValueProblem | undefined {
  if (!decision.approved) {
    return decision.value === undefined ? undefined : { code: "decline_with_value" };
  }
  if (request === undefined) {
    return decision.value === undefined ? undefined : { code: "value_not_asked" };
  }
  if (decision.value === undefined) return { code: "value_missing", request };
  const cents = decision.value;
  if (typeof cents !== "number" || !Number.isSafeInteger(cents)) {
    return { code: "not_whole_cents", request, value: cents };
  }
  if (cents < request.min || (request.max !== undefined && cents > request.max)) {
    return { code: "out_of_bounds", request, cents };
  }
  return undefined;
}

/**
 * A value problem in words for the person deciding: the terminal, the error an `approve` command
 * returns, an eval's report. It names the bounds, which the approver was already shown with the ask.
 */
export function valueProblemForApprover(problem: ApprovalValueProblem): string {
  switch (problem.code) {
    case "decline_with_value":
      return "A decline carries no value; send it without one.";
    case "value_not_asked":
      return "This approval asks for no value; approve it without one.";
    case "value_missing":
      return `This approval asks for ${askedText(problem.request)}; approve it with that value.`;
    case "not_whole_cents":
      return `The value for ${askedText(problem.request)} must be a whole number of cents.`;
    case "out_of_bounds":
      return `The value ${problem.cents} for ${askedText(problem.request)} is outside its bounds.`;
  }
}

/**
 * What the model is told when an approver's answer was not a decision. It takes no problem on purpose:
 * the bounds can be another person's pay, and the entered value is the approver's, so the model learns
 * only that nothing was done and that it must neither retry nor state a figure.
 */
export function valueProblemForModel(tool: string, description: string): string {
  return (
    `${tool} was not run: the approval it needs (${description}) was not completed, because the ` +
    "approver's answer did not carry a valid value. Nothing was done. Nothing has been approved or " +
    "declined. Do not retry this call on your own, and do not state any figure for it; say the " +
    "approval was not completed."
  );
}

/** `"Credit to give" (value, whole cents from 1 to 50000)`: the label and bounds, for the approver. */
function askedText(request: ApprovalValueRequest): string {
  return `"${request.label}" (value, ${boundsText(request)})`;
}

/** A request's bounds in words, in cents: "whole cents from 1 to 50000", or "from 1" without a max. */
function boundsText(request: ApprovalValueRequest): string {
  return request.max === undefined
    ? `whole cents, at least ${request.min}`
    : `whole cents from ${request.min} to ${request.max}`;
}

/** The facts a person approved for this call, as the gate injected them; `undefined` without a grant. */
export function approvedFacts(args: ToolArguments): Record<string, unknown> | undefined {
  const facts = args[APPROVED_FACTS_ARG];
  if (facts === null || typeof facts !== "object" || Array.isArray(facts)) return undefined;
  return facts as Record<string, unknown>;
}

/**
 * Whether approved facts still equal a record's facts now, by content and not by key order. A desk
 * uses it to refuse a write when the thing a person approved changed after its facts were read.
 */
export function sameFacts(approved: unknown, current: unknown): boolean {
  try {
    return canonicalJson(approved) === canonicalJson(current);
  } catch {
    return false;
  }
}

/** What the approver is asked to decide. */
export interface ApprovalRequest {
  /** The approval id from `officehum.json`. */
  readonly approvalId: string;
  /** The approval's description from `officehum.json`, shown to the person deciding. */
  readonly description: string;
  readonly tool: string;
  readonly arguments: ToolArguments;
  readonly conversationId: string;
  readonly taskId: string;
  /** Stable for this call across crashes, so an approver can deduplicate repeated asks. */
  readonly callId: string;
  /** What is being approved, read from the role's records, when the approval has a facts reader. */
  readonly facts?: ApprovalFacts;
  /**
   * The approval's amount in cents (`approvalAmount`), when it declares one and the call gives a
   * readable one. For an approval that asks for a value it is the proposal the person sees first.
   */
  readonly amount?: number;
  /**
   * What the person is asked to enter with a yes, when the approval declares a `value`. A yes without
   * a value inside these bounds is not an approval (`approvalValueProblem`).
   */
  readonly valueRequest?: ApprovalValueRequest;
}

/** A person's decision. */
export type ApprovalDecision = {
  readonly approved: boolean;
  /** Who decided, for the audit trail. */
  readonly by?: string;
  /** Why, shown to the agent when declined. */
  readonly note?: string;
  /**
   * The request reached a person who has not answered yet (`approved` is then ignored). The call is
   * not run and no decision is recorded, so the same call is asked again later and runs on a yes.
   */
  readonly pending?: boolean;
  /**
   * The value the person entered with a yes, in whole cents, when the request has a `valueRequest`.
   * A decline never carries one.
   */
  readonly value?: number;
};

/** Asks a person to decide. May take as long as the person needs. */
export type Approver = (
  request: ApprovalRequest,
  context: HookContext,
) => Promise<ApprovalDecision>;

export interface ApprovalGateOptions {
  /** The manifest's `approvals`. */
  readonly approvals: readonly ApprovalDeclaration[];
  /** Decides gated actions. Omitted: every gated action is blocked. */
  readonly approve?: Approver | undefined;
  /**
   * When each approval applies, keyed by approval id, e.g. `large_invoice: (args) => total(args) > 5000`.
   * An approval with no condition applies to every call of its tool.
   */
  readonly when?: Readonly<Record<string, ApprovalCondition>>;
  /**
   * The role's resolved limits, keyed by name, e.g. `{ large_invoice: 2500 }`. Conditions declared as
   * `{ "limit": "NAME" }` compare against them, and code conditions read them from the environment.
   * Omitted: no limits, so a named limit resolves to nothing and its approval waits for a person.
   */
  readonly limits?: Readonly<Record<string, number>> | undefined;
  /**
   * Facts readers, keyed by approval id. An approval with one is asked with the facts it read, and a
   * yes passes them to the tool under `APPROVED_FACTS_ARG`.
   */
  readonly facts?: Readonly<Record<string, ApprovalFactsReader>> | undefined;
  /**
   * Declined handlers, keyed by approval id: what the role records when a person declines a call it
   * asked about, or the request expires (`ApprovalDeclinedHandler`).
   */
  readonly declined?: Readonly<Record<string, ApprovalDeclinedHandler>> | undefined;
}

/** The arguments only the gate sets. */
const RESERVED_ARGS: readonly string[] = [APPROVED_FACTS_ARG, APPROVED_VALUE_ARG];

const gates = new WeakSet<HookRegistration>();

/**
 * A registration built by `approvalGate()`, marked with a `Symbol.for` key as well as the `WeakSet`.
 * The role loader (`loadRole` in `@officehum/runner`) may hold a different copy of this SDK than the
 * role package it just imported, so detection cannot rely on module identity alone; the well-known
 * symbol makes the mark visible across copies.
 */
const APPROVAL_GATE = Symbol.for("officehum.approvalGate");

/** Whether a hook was built by `approvalGate()`. `checkAgent` uses it to confirm a gated role really gates. */
export function isApprovalGate(registration: HookRegistration): boolean {
  return (
    gates.has(registration) ||
    (registration as unknown as Record<symbol, unknown>)[APPROVAL_GATE] === true
  );
}

/**
 * A decision as the gate memoises it. `value` is set only for an approval that asks for one: the cents
 * the person entered on a yes, `null` on a no. A decision written before its approval asked for a
 * value has no `value`, and is not a grant of one.
 */
type StoredDecision = {
  approved: boolean;
  by: string | null;
  note: string | null;
  value?: number | null;
};
type StoredApplicability = { tool: string; argsJson: string; required: boolean };
type StoredFacts = { summary: string; facts: JsonObject };
type StoredValueRequest = { name: string; label: string; min: number; max?: number };
/** A declined handler's outcome: what it said, or why it failed. */
type StoredDeclined = { said: string | null; failed: string | null };

function assertApplicability(stored: StoredApplicability, tool: string, argsJson: string): void {
  if (
    stored === null ||
    typeof stored !== "object" ||
    typeof stored.tool !== "string" ||
    typeof stored.argsJson !== "string" ||
    typeof stored.required !== "boolean"
  ) {
    throw new Error("Malformed stored approval applicability.");
  }
  if (stored.tool !== tool || !sameCanonical(stored.argsJson, argsJson)) {
    throw new Error(
      "This approval call identity was already used with a different tool or arguments.",
    );
  }
}

/** Builds the hook a role adds to its extension's `hooks`. It covers the role's skill tools too. */
export function approvalGate(options: ApprovalGateOptions): HookRegistration {
  const registration = hook(ToolTask, {
    beforeTool: async (call, api, context) => {
      // Read per call, so a role that resolves its limits live (defineRole) sees overlay changes.
      const limits = options.limits ?? {};
      // The approved-facts and approved-value keys are the gate's alone: whatever the model put there
      // is dropped before anything reads the arguments, and only what a person approved is put back.
      const forged = RESERVED_ARGS.some((key) => Object.hasOwn(call.arguments, key));
      const args: ToolArguments = forged
        ? Object.fromEntries(
            Object.entries(call.arguments).filter(([key]) => !RESERVED_ARGS.includes(key)),
          )
        : call.arguments;
      let granted: Record<string, unknown> | undefined;
      let grantedValue: ApprovedValue | undefined;
      for (const approval of options.approvals) {
        if (approval.tool !== call.name) continue;
        const memoKey = `officehum.approval.${call.id}.${approval.id}`;
        let decision = await api.memo<StoredDecision>(memoKey, context);
        const applicabilityKey = `officehum.approval-intent.${call.id}.${approval.id}`;
        const argsJson = canonicalJson(args);
        let applicability = await api.memo<StoredApplicability>(applicabilityKey, context);

        // Decisions written before applicability memos existed remain authoritative.
        if (decision === undefined || applicability !== undefined) {
          if (applicability === undefined) {
            let required = true;
            const applies = options.when?.[approval.id];
            if (applies !== undefined) {
              try {
                const read = {
                  snapshot: api.snapshot.bind(api),
                  snapshotAsOf: api.snapshotAsOf.bind(api),
                };
                const result = await applies(
                  args,
                  { read, limits, conversationId: api.conversationId, taskId: api.taskId },
                  context,
                );
                required = typeof result === "boolean" ? result : true;
              } catch {
                context.abortSignal?.throwIfAborted();
                required = true;
              }
            } else if (approval.when !== undefined) {
              required = conditionsHold(approval.when, args, limits);
            }
            applicability = await api.memo<StoredApplicability>(
              applicabilityKey,
              { tool: call.name, argsJson, required },
              context,
            );
          }
          assertApplicability(applicability, call.name, argsJson);
          if (!applicability.required) continue;
        }

        const reader = options.facts?.[approval.id];
        const factsKey = `officehum.approval-facts.${call.id}.${approval.id}`;
        let facts =
          reader === undefined ? undefined : await api.memo<StoredFacts>(factsKey, context);
        const valueKey = `officehum.approval-value.${call.id}.${approval.id}`;
        let valueRequest =
          approval.value === undefined
            ? undefined
            : await api.memo<StoredValueRequest>(valueKey, context);
        if (decision === undefined) {
          if (options.approve === undefined) {
            return {
              block: `This action needs a person's approval (${approval.description}), and no approver is configured, so it was not done. Tell the user what you were going to do so they can do it themselves.`,
            };
          }
          if (reader !== undefined && facts === undefined) {
            let read: ApprovalFacts;
            try {
              read = await reader(args, context, {
                conversationId: api.conversationId,
                taskId: api.taskId,
              });
            } catch (error) {
              context.abortSignal?.throwIfAborted();
              return { block: error instanceof Error ? error.message : String(error) };
            }
            // First write wins: after a crash mid-read, the facts recorded first are the ones asked about.
            facts = await api.memo<StoredFacts>(
              factsKey,
              // A reader's facts are records read from a desk; the memo stores them as JSON.
              { summary: read.summary, facts: read.facts as JsonObject },
              context,
            );
          }
          if (approval.value !== undefined && valueRequest === undefined) {
            const resolved = resolveValueRequest(approval.value, facts?.facts);
            if ("problem" in resolved) return { block: resolved.problem };
            // First write wins, like the facts: the bounds asked about are the ones first pinned.
            valueRequest = await api.memo<StoredValueRequest>(
              valueKey,
              resolved.request as StoredValueRequest,
              context,
            );
          }
          const amount = approvalAmount(approval, args, facts?.facts);
          const answer = await options.approve(
            {
              approvalId: approval.id,
              description: approval.description,
              tool: call.name,
              arguments: args,
              conversationId: String(api.conversationId),
              taskId: String(api.taskId),
              callId: call.id,
              ...(facts === undefined ? {} : { facts }),
              ...(amount === undefined ? {} : { amount }),
              ...(valueRequest === undefined ? {} : { valueRequest }),
            },
            context,
          );
          // Nothing is memoised for a pending answer: memoising it would turn "not yet" into a
          // standing no for this call, and the person's later answer could never reach it.
          if (answer.pending === true) {
            return {
              block:
                `${call.name} was not run: it needs a person's approval (${approval.description}), ` +
                "and the request is with a person who has not answered yet. Nothing has been " +
                "approved or declined. Say the request is waiting for a person's answer, and do not " +
                "retry this call.",
            };
          }
          // An answer that is not an acceptable decision (a yes without the value the person was asked
          // for, or with one out of bounds) is no decision at all: nothing is memoised, so the call
          // does not run and the person can still be asked.
          // The block is the model's, so it is told nothing of the bounds or the entered value.
          if (approvalValueProblem(valueRequest, answer) !== undefined) {
            return { block: valueProblemForModel(call.name, approval.description) };
          }
          // First write wins: after a crash mid-ask, the decision recorded first stands, its value
          // included, so a replay or a restart hands the tool the value first recorded.
          decision = await api.memo<StoredDecision>(
            memoKey,
            {
              approved: answer.approved,
              by: answer.by ?? null,
              note: answer.note ?? null,
              ...(approval.value === undefined
                ? {}
                : { value: answer.approved ? (answer.value ?? null) : null }),
            },
            context,
          );
        }
        if (!decision.approved) {
          const reason = decision.note === null ? "" : `: ${decision.note}`;
          // Models otherwise name the approver they asked as the one who said no, a claim
          // nothing in this result supports. The reason is given as data, not just the rule: any
          // signed-in approver can decide, a request escalates to a backup, and one left unanswered
          // closes as declined on timeout.
          const block =
            `A person declined this action (${approval.description})${reason}. ` +
            "Say it was declined. This result does not say who declined, so name no one as the person who did. " +
            "The person asked may not be the one who answered: another approver can decide, and an unanswered request closes as declined.";
          const handler = options.declined?.[approval.id];
          if (handler === undefined) return { block };
          const outcome = await declinedOutcome(handler, {
            api,
            context,
            args,
            key: `officehum.approval-declined.${call.id}.${approval.id}`,
            declined: {
              conversationId: api.conversationId,
              taskId: api.taskId,
              callId: call.id,
              ...(facts === undefined ? {} : { facts }),
              ...(decision.note === null ? {} : { note: decision.note }),
            },
          });
          if (outcome.failed !== null) {
            return {
              block: `${block} Recording what follows the decline failed (${outcome.failed}); the action was still not done.`,
            };
          }
          return { block: outcome.said === null ? block : `${block} ${outcome.said}` };
        }
        // A yes without memoised facts (a decision recorded before this approval had a reader) passes
        // no facts, so the tool refuses rather than writing against facts nobody was shown.
        if (facts !== undefined) granted = facts.facts;
        if (approval.value !== undefined) {
          // A yes recorded without a value (before this approval asked for one) grants none.
          if (typeof decision.value !== "number") {
            return {
              block: `${call.name} was not run: its approval (${approval.description}) was recorded without "${approval.value.label}", so there is no value a person entered to use.`,
            };
          }
          grantedValue = { name: approval.value.name, cents: decision.value, by: decision.by };
        }
      }
      if (granted !== undefined || grantedValue !== undefined) {
        return {
          arguments: {
            ...args,
            ...(granted === undefined ? {} : { [APPROVED_FACTS_ARG]: granted }),
            ...(grantedValue === undefined ? {} : { [APPROVED_VALUE_ARG]: grantedValue }),
          } as JsonObject,
        };
      }
      return forged ? { arguments: args as JsonObject } : undefined;
    },
  });
  gates.add(registration);
  // Best effort: a frozen registration keeps the `WeakSet` mark and still works within one copy.
  try {
    Object.defineProperty(registration, APPROVAL_GATE, {
      value: true,
      enumerable: false,
      configurable: true,
    });
  } catch {
    // ignore: the WeakSet remains authoritative for this module copy
  }
  return registration;
}

/**
 * A declined handler's outcome for one call: the memoised one, or the handler's, memoised beside the
 * decision so it runs once. A failure is an outcome too, so a replay repeats it rather than retrying;
 * an abort is not, so a stopped run asks again when it resumes.
 */
async function declinedOutcome(
  handler: ApprovalDeclinedHandler,
  run: {
    readonly api: Parameters<ToolHooks["beforeTool"]>[1];
    readonly context: HookContext;
    readonly args: ToolArguments;
    readonly key: string;
    readonly declined: DeclinedApproval;
  },
): Promise<StoredDeclined> {
  const stored = await run.api.memo<StoredDeclined>(run.key, run.context);
  if (stored !== undefined) return stored;
  let outcome: StoredDeclined;
  try {
    const said = await handler(run.args, run.declined, run.context);
    outcome = { said: said === undefined || said === "" ? null : said, failed: null };
  } catch (error) {
    run.context.abortSignal?.throwIfAborted();
    outcome = { said: null, failed: error instanceof Error ? error.message : String(error) };
  }
  // First write wins, like the decision itself.
  return await run.api.memo<StoredDeclined>(run.key, outcome, run.context);
}

/**
 * Whether every condition holds for a call's arguments, resolving `{ "limit": "NAME" }` values from
 * `limits`. Fails safe: a condition on an argument that is missing or of a type it cannot compare, or
 * a named limit that does not resolve to a number, counts as holding, so the action waits for a person.
 *
 * A condition with `field` compares a total instead of one argument:
 * `{ "arg": "lines", "op": "gt", "field": "unitPriceCents", "times": "quantity", "value": { "limit":
 * "large_invoice" } }` sums that field across the array `arg` names — each element's field times its
 * `times` field when one is given — and compares the sum with the value, the same way `gt` compares
 * one number. It fails safe on every element: see `summedField`.
 *
 * That fail-safe is wrong for an *optional* argument, where absent means the condition does not apply:
 * "a discount above the rate waits for a person" should not gate a booking with no discount at all.
 * `present` and `absent` are the opt-in answer — `when` is a conjunction, so `[{arg, op: "present"},
 * {arg, op: "gt", value: {limit}}]` says "present, and above it", and an absent argument makes the
 * first false and the whole condition not hold. Absence alone still holds, so a malformed call cannot
 * skip a gate by omitting a field.
 */
export function conditionsHold(
  conditions: readonly ConditionDeclaration[],
  args: ToolArguments,
  limits: Readonly<Record<string, number>> = {},
): boolean {
  return conditions.every((condition) => holds(condition, args, limits));
}

/** Whether one condition holds; see `conditionsHold` for the rules every branch follows. */
function holds(
  condition: ConditionDeclaration,
  args: ToolArguments,
  limits: Readonly<Record<string, number>>,
): boolean {
  const actual = args[condition.arg];
  const missing = actual === undefined || actual === null;
  if (condition.op === "present") return !missing;
  if (condition.op === "absent") return missing;
  // The schema refuses these without a value; a value-less condition cannot be evaluated, so it holds.
  if (condition.value === undefined) return true;
  const name = limitName(condition.value);
  const expected = name === undefined ? condition.value : limits[name];
  // An unknown limit leaves nothing to compare against, so the action needs approval rather than passing.
  if (name !== undefined && typeof expected !== "number") return true;
  if (missing) return true;
  switch (condition.op) {
    case "eq":
      return actual === expected;
    case "ne":
      return actual !== expected;
    case "in":
      return Array.isArray(expected) && (expected as readonly unknown[]).includes(actual);
    default: {
      const number =
        condition.field === undefined
          ? asNumber(actual)
          : summedField(actual, condition.field, condition.times);
      if (number === undefined || Number.isNaN(number) || typeof expected !== "number") return true;
      if (condition.op === "gt") return number > expected;
      if (condition.op === "gte") return number >= expected;
      if (condition.op === "lt") return number < expected;
      return number <= expected;
    }
  }
}

/**
 * The amount a call puts in front of a person, in cents: what the declaration's `amount` names, read
 * from the arguments the way conditions read them (a summed field included), or, for `{ "fact" }`,
 * from the facts the role's reader read for this call. `undefined` when the declaration names no
 * amount or the source does not give a readable one, so a limit check can tell "unknown" from
 * "small". It is never guessed from `when`, whose numbers may be percentages or counts.
 */
export function approvalAmount(
  declaration: ApprovalDeclaration,
  args: ToolArguments,
  facts?: Readonly<Record<string, unknown>>,
): number | undefined {
  const declared = declaration.amount;
  if (declared === undefined) return undefined;
  // A fact is the figure the role's own records hold, which the person is shown: only a whole,
  // non-negative number of cents reads as one, and anything else is unknown rather than zero.
  if ("fact" in declared) {
    const value = facts?.[declared.fact];
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  }
  const actual = args[declared.arg];
  if (actual === undefined || actual === null) return undefined;
  const amount =
    declared.field === undefined
      ? asNumber(actual)
      : summedField(actual, declared.field, declared.times);
  return amount === undefined || !Number.isFinite(amount) || amount < 0 ? undefined : amount;
}

/**
 * One argument as the number to compare, or `undefined` when it is not one. Only a number, or text
 * that spells one, is read: `Number` turns a blank string, an empty array and `false` into 0, and a
 * zero the call never stated is the one reading that slips a call past a limit.
 */
function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isNaN(value) ? undefined : value;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const number = Number(value);
  return Number.isNaN(number) ? undefined : number;
}

/**
 * The sum of one numeric field across an array's elements, multiplied by a second field per element
 * when `times` is given, or `undefined` when the array cannot be summed.
 *
 * A sum must never come out smaller than the call's own numbers, because a smaller total is the one
 * direction that slips a call past a limit. So an element this cannot read — not an object, a field
 * that is missing or not a finite number, a negative amount, or a `times` that is not a positive
 * number — makes the whole sum `undefined`, and `holds` turns that into "needs approval". Skipping
 * the element instead would total the rest and quietly under-report the call.
 *
 * With `times`, an element contributes `field × times` rounded to a whole number: a line is written
 * as a price and a count, and the amount a billing system adds up is that product in whole cents. An
 * empty array has nothing to add up and is not a total of zero — there is no call to compare.
 */
function summedField(value: unknown, field: string, times: string | undefined): number | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  let total = 0;
  for (const element of value) {
    if (element === null || typeof element !== "object" || Array.isArray(element)) return undefined;
    const record = element as Record<string, unknown>;
    const amount = record[field];
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return undefined;
    if (times === undefined) {
      total += amount;
      continue;
    }
    const count = record[times];
    if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) return undefined;
    total += Math.round(amount * count);
  }
  return total;
}
