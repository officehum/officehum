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

import { Type } from "@earendil-works/pi-ai";
import {
  type DocumentReader,
  type HookRegistration,
  hook,
  type JsonObject,
  type ToolHooks,
  ToolTask,
} from "@earendil-works/pi-durable";
import type { ApprovalDeclaration, ConditionDeclaration } from "./manifest.js";
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
export type ApprovalFactsReader = (
  args: ToolArguments,
  context: HookContext,
  call: ApprovalCallIdentity,
) => Promise<ApprovalFacts>;

/** The conversation and task a gated call belongs to, from the hook's API, never from arguments. */
export interface ApprovalCallIdentity {
  readonly conversationId: unknown;
  readonly taskId: unknown;
}

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
  return Type.Optional(
    Type.Object(
      {},
      { additionalProperties: true, description: "set by the approval gate; never supply it" },
    ),
  );
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
}

const gates = new WeakSet<HookRegistration>();

/**
 * A registration built by `approvalGate()`, marked with a `Symbol.for` key as well as the `WeakSet`.
 * The role loader (`loadRole` in `@officehum/office`) may hold a different copy of this SDK than the
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

type StoredDecision = { approved: boolean; by: string | null; note: string | null };
type StoredApplicability = { tool: string; argsJson: string; required: boolean };
type StoredFacts = { summary: string; facts: JsonObject };

function canonicalJson(value: unknown): string {
  const canonical = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(canonical);
    if (candidate !== null && typeof candidate === "object") {
      return Object.fromEntries(
        Object.entries(candidate as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, canonical(child)]),
      );
    }
    return candidate;
  };
  const json = JSON.stringify(canonical(value));
  if (json === undefined) throw new Error("Approval arguments must be JSON serializable.");
  return json;
}

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
  if (stored.tool !== tool || stored.argsJson !== argsJson) {
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
      // The approved-facts key is the gate's alone: whatever the model put there is dropped before
      // anything reads the arguments, and only facts a person approved are put back.
      const forged = Object.hasOwn(call.arguments, APPROVED_FACTS_ARG);
      const args: ToolArguments = forged
        ? Object.fromEntries(
            Object.entries(call.arguments).filter(([key]) => key !== APPROVED_FACTS_ARG),
          )
        : call.arguments;
      let granted: Record<string, unknown> | undefined;
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
                const result = await applies(args, { read, limits }, context);
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
          // First write wins: after a crash mid-ask, the decision recorded first stands.
          decision = await api.memo<StoredDecision>(
            memoKey,
            { approved: answer.approved, by: answer.by ?? null, note: answer.note ?? null },
            context,
          );
        }
        if (!decision.approved) {
          const reason = decision.note === null ? "" : `: ${decision.note}`;
          // Models otherwise name the approver they asked as the one who said no, a claim
          // nothing in this result supports.
          return {
            block:
              `A person declined this action (${approval.description})${reason}. ` +
              "Say it was declined. This result does not say who declined, so name no one as the person who did.",
          };
        }
        // A yes without memoised facts (a decision recorded before this approval had a reader) passes
        // no facts, so the tool refuses rather than writing against facts nobody was shown.
        if (facts !== undefined) granted = facts.facts;
      }
      if (granted !== undefined) {
        return { arguments: { ...args, [APPROVED_FACTS_ARG]: granted } as JsonObject };
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
 * from the arguments the way conditions read them (a summed field included). `undefined` when the
 * declaration names no amount or the arguments do not give a readable one, so a limit check can tell
 * "unknown" from "small". It is never guessed from `when`, whose numbers may be percentages or counts.
 */
export function approvalAmount(
  declaration: ApprovalDeclaration,
  args: ToolArguments,
): number | undefined {
  const declared = declaration.amount;
  if (declared === undefined) return undefined;
  const actual = args[declared.arg];
  if (actual === undefined || actual === null) return undefined;
  const amount =
    declared.field === undefined
      ? asNumber(actual)
      : summedField(actual, declared.field, declared.times);
  return amount === undefined || !Number.isFinite(amount) || amount < 0 ? undefined : amount;
}

/** One argument as the number to compare, or `undefined` when it is not one. */
function asNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
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
