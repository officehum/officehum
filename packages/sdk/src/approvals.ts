/**
 * Approval gates: a Pi Durable `beforeTool` hook that holds gated actions until a person decides.
 *
 * Safe by default: with no approver supplied (a role on a bare Pi Durable install), every gated
 * action is blocked. Inside Office Hum the approver is backed by the Inbox. Each decision is kept in
 * the tool task's memo, so a crash never asks twice and never forgets a yes.
 */

import {
  type DocumentReader,
  type HookRegistration,
  hook,
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
}

/** A person's decision. */
export type ApprovalDecision = {
  readonly approved: boolean;
  /** Who decided, for the audit trail. */
  readonly by?: string;
  /** Why, shown to the agent when declined. */
  readonly note?: string;
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
      for (const approval of options.approvals) {
        if (approval.tool !== call.name) continue;
        const memoKey = `officehum.approval.${call.id}.${approval.id}`;
        let decision = await api.memo<StoredDecision>(memoKey, context);
        const applicabilityKey = `officehum.approval-intent.${call.id}.${approval.id}`;
        const argsJson = canonicalJson(call.arguments);
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
                const result = await applies(call.arguments, { read, limits }, context);
                required = typeof result === "boolean" ? result : true;
              } catch {
                context.abortSignal?.throwIfAborted();
                required = true;
              }
            } else if (approval.when !== undefined) {
              required = conditionsHold(approval.when, call.arguments, limits);
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

        if (decision === undefined) {
          if (options.approve === undefined) {
            return {
              block: `This action needs a person's approval (${approval.description}), and no approver is configured, so it was not done. Tell the user what you were going to do so they can do it themselves.`,
            };
          }
          const answer = await options.approve(
            {
              approvalId: approval.id,
              description: approval.description,
              tool: call.name,
              arguments: call.arguments,
              conversationId: String(api.conversationId),
              taskId: String(api.taskId),
              callId: call.id,
            },
            context,
          );
          // First write wins: after a crash mid-ask, the decision recorded first stands.
          decision = await api.memo<StoredDecision>(
            memoKey,
            { approved: answer.approved, by: answer.by ?? null, note: answer.note ?? null },
            context,
          );
        }
        if (!decision.approved) {
          const reason = decision.note === null ? "" : `: ${decision.note}`;
          return { block: `A person declined this action (${approval.description})${reason}.` };
        }
      }
      return undefined;
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
 */
export function conditionsHold(
  conditions: readonly ConditionDeclaration[],
  args: ToolArguments,
  limits: Readonly<Record<string, number>> = {},
): boolean {
  return conditions.every((condition) => {
    const actual = args[condition.arg];
    const name = limitName(condition.value);
    const expected = name === undefined ? condition.value : limits[name];
    // An unknown limit leaves nothing to compare against, so the action needs approval rather than passing.
    if (name !== undefined && typeof expected !== "number") return true;
    if (actual === undefined || actual === null) return true;
    switch (condition.op) {
      case "eq":
        return actual === expected;
      case "ne":
        return actual !== expected;
      case "in":
        return Array.isArray(expected) && (expected as readonly unknown[]).includes(actual);
      default: {
        const number = typeof actual === "number" ? actual : Number(actual);
        if (Number.isNaN(number) || typeof expected !== "number") return true;
        if (condition.op === "gt") return number > expected;
        if (condition.op === "gte") return number >= expected;
        if (condition.op === "lt") return number < expected;
        return number <= expected;
      }
    }
  });
}
