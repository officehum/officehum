/**
 * Approval gates: a Pi Durable `beforeTool` hook that holds gated actions until a person decides.
 *
 * Safe by default: with no approver supplied (a role on a bare Pi Durable install), every gated
 * action is blocked. Inside Office Hum the approver is backed by the Inbox. Each decision is kept in
 * the tool task's memo, so a crash never asks twice and never forgets a yes.
 */

import { type HookRegistration, hook, type ToolHooks, ToolTask } from "@earendil-works/pi-durable";
import type { ApprovalDeclaration, ConditionDeclaration } from "./manifest.js";

/** The cancellation and deadline context Pi Durable passes to hooks. */
export type HookContext = Parameters<ToolHooks["beforeTool"]>[2];

/** A tool call's arguments, as the model sent them after validation. */
export type ToolArguments = Readonly<Record<string, unknown>>;

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
  readonly when?: Readonly<Record<string, (args: ToolArguments) => boolean>>;
}

const gates = new WeakSet<HookRegistration>();

/** Whether a hook was built by `approvalGate()`. `checkAgent` uses it to confirm a gated role really gates. */
export function isApprovalGate(registration: HookRegistration): boolean {
  return gates.has(registration);
}

type StoredDecision = { approved: boolean; by: string | null; note: string | null };

/** Builds the hook a role adds to its extension's `hooks`. It covers the role's skill tools too. */
export function approvalGate(options: ApprovalGateOptions): HookRegistration {
  const registration = hook(ToolTask, {
    beforeTool: async (call, api, context) => {
      for (const approval of options.approvals) {
        if (approval.tool !== call.name) continue;
        // A condition in code wins; otherwise the manifest's `when`; otherwise every call is gated.
        const applies = options.when?.[approval.id];
        if (applies !== undefined) {
          if (!applies(call.arguments)) continue;
        } else if (approval.when !== undefined && !conditionsHold(approval.when, call.arguments)) {
          continue;
        }

        const memoKey = `officehum.approval.${call.id}.${approval.id}`;
        let decision = await api.memo<StoredDecision>(memoKey, context);
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
  return registration;
}

/**
 * Whether every condition holds for a call's arguments. Fails safe: a condition on an argument that
 * is missing, or of a type it cannot compare, counts as holding, so the action waits for a person.
 */
export function conditionsHold(
  conditions: readonly ConditionDeclaration[],
  args: ToolArguments,
): boolean {
  return conditions.every((condition) => {
    const actual = args[condition.arg];
    const expected = condition.value;
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
