/**
 * Remote approvals (RASF-3108): the `Approver` the runtime hands every role it loads, so a gated tool
 * call waits for a person who decides through the gateway instead of being refused.
 *
 * A role's own `approvalGate` (`@officehum/sdk`) asks this approver and memoises the answer in the
 * tool task, so a decided call runs once and is never asked about again. This store keeps what the
 * memo cannot: the request while nobody has answered, across restarts, and the record of who decided.
 *
 * - **Asked.** The request is written durably (`approvalId` = `<taskId>:<callId>:<approval id>`,
 *   stable for the call across crashes), announced as `approval_requested` on the request's event
 *   stream and as an `approval` message for the gateway to route to approvers, and the call waits.
 * - **Decided.** The first decision wins; a later one is a `conflict`. The decision records `by`, the
 *   principal the gateway signed in, never anything from the payload, and the time. `approval_decided`
 *   follows on the stream.
 * - **Limits.** A principal with an `approvalLimit` may approve only when the call's amount (the
 *   number the approval's `when` compares, `approvalAmount`) is known and within it. Declining needs
 *   no limit: it has no side effects.
 * - **Timeout.** Unanswered past its agent's timeout (default 4 hours), a request is declined with the
 *   note `timed out`, and the tool does not run.
 * - **Restarts.** A run resumed after a crash asks again for the same call and finds the stored
 *   request (it waits on) or decision (it gets at once).
 * - **Audit.** Every request and decision is appended to the store's audit list, which is never
 *   rewritten.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type JsonObject } from "@earendil-works/pi-durable";
import type { ApprovalInfo, Principal, RequestEvent } from "@officehum/protocol";
import {
  type ApprovalDecision,
  type ApprovalDeclaration,
  type ApprovalRequest,
  type Approver,
  approvalAmount,
  type HookContext,
} from "@officehum/sdk";
import type { Office } from "../adapter/index.js";
import { RuntimeError } from "./errors.js";

/** How long a request waits for a decision unless its agent says otherwise: 4 hours. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 4 * 60 * 60 * 1000;

/** The note a timed-out request is declined with. */
export const TIMED_OUT = "timed out";

type Stored = ApprovalInfo & {
  /** The Pi Durable conversation the call belongs to, so its events reach the right stream. */
  readonly conversationId: string;
  readonly description: string;
  readonly arguments: JsonObject;
};

/** One line of the audit trail. Appended, never changed. */
export type ApprovalAuditRecord = {
  readonly at: string;
  readonly approvalId: string;
  readonly agent: string;
  readonly tool: string;
  readonly action: "requested" | "approved" | "declined" | "timed_out";
  /** The deciding principal; absent for a request and a timeout. */
  readonly by?: string;
  readonly note?: string;
};

const ApprovalsDoc = defineDoc<{
  approvals: Record<string, Stored>;
  audit: ApprovalAuditRecord[];
}>({
  kind: "officehum.runtime.approvals",
  version: 1,
  scope: "session",
  initial: () => ({ approvals: {}, audit: [] }),
});

/** The agent behind a conversation, as approvals need it. */
export interface ApprovalCaller {
  readonly agent: string;
  /** The role's approval declarations, which say how to read a call's amount. */
  readonly declarations: readonly ApprovalDeclaration[];
  readonly timeoutMs: number;
}

/** What the runtime gives the store once the office is open. */
export interface ApprovalsHost {
  readonly office: Office;
  /** The agent whose conversation this is, or undefined for one the runtime did not open. */
  callerOf(conversationId: string): ApprovalCaller | undefined;
  /** Puts an event on the stream of the request the conversation is working on. */
  announce(conversationId: string, event: RequestEvent): void;
  /** Tells the gateway an approval was asked for or decided. */
  broadcast(approval: ApprovalInfo): void;
  readonly log: (line: string) => void;
  /** The clock; tests move it. */
  readonly now?: () => number;
}

export class RemoteApprovals {
  /** The approver to hand every role (`loadRole`'s `approve`). It waits until the runtime binds. */
  readonly approve: Approver = (request, context) => this.#ask(request, context);

  #host: ApprovalsHost | undefined;
  readonly #bound: Promise<void>;
  #markBound: () => void = () => {};
  readonly #store = new Map<string, Stored>();
  readonly #waiters = new Map<string, Set<(decision: ApprovalDecision) => void>>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Writes one at a time, so "first decision wins" holds without a race between two deciders. */
  #writing: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor() {
    this.#bound = new Promise((resolve) => {
      this.#markBound = resolve;
    });
  }

  /** Connects the store to the open office and loads what an earlier run recorded. */
  async bind(host: ApprovalsHost): Promise<void> {
    const saved = await host.office.snapshot(ApprovalsDoc);
    for (const [id, approval] of Object.entries(saved?.approvals ?? {}))
      this.#store.set(id, approval);
    this.#host = host;
    this.#markBound();
  }

  /** Stops the timers; calls still waiting end with the office's own abort. */
  close(): void {
    this.#closed = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }

  /** Every approval still waiting for a decision, oldest first. */
  pending(): ApprovalInfo[] {
    return [...this.#store.values()]
      .filter((approval) => approval.status === "pending")
      .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
      .map(infoOf);
  }

  /**
   * Records a principal's decision. Refuses with `not_found` for no such approval, `conflict` once it
   * is decided (or timed out), and `forbidden` for an approval above the principal's limit, or whose
   * amount cannot be checked against one.
   */
  async decide(
    principal: Principal,
    approvalId: string,
    decision: "approve" | "decline",
    note?: string,
  ): Promise<ApprovalInfo> {
    const host = await this.#ready();
    return await this.#serial(async () => {
      const stored = this.#store.get(approvalId);
      if (stored === undefined) {
        throw new RuntimeError("not_found", `No approval ${approvalId} is known to this office.`);
      }
      if (stored.status === "pending" && this.#expired(stored)) {
        await this.#settle(host, stored, { status: "declined", note: TIMED_OUT }, "timed_out");
      }
      const current = this.#store.get(approvalId) as Stored;
      if (current.status !== "pending") {
        const how =
          current.note === TIMED_OUT && current.by === undefined
            ? "it timed out and was declined"
            : `${current.by ?? "someone"} ${current.status} it at ${current.decidedAt}`;
        throw new RuntimeError("conflict", `Approval ${approvalId} is already decided: ${how}.`);
      }
      if (decision === "approve" && principal.approvalLimit !== undefined) {
        const limit = principal.approvalLimit;
        if (current.amount === undefined) {
          throw new RuntimeError(
            "forbidden",
            `Approval ${approvalId} has no amount to check against your approval limit of ${limit}; it needs an approver with no limit.`,
          );
        }
        if (current.amount > limit) {
          throw new RuntimeError(
            "forbidden",
            `Approval ${approvalId} is for ${current.amount}, above your approval limit of ${limit}.`,
          );
        }
      }
      const status = decision === "approve" ? "approved" : "declined";
      const settled = await this.#settle(
        host,
        current,
        { status, by: principal.id, ...(note === undefined ? {} : { note }) },
        status,
      );
      return infoOf(settled);
    });
  }

  async #ask(request: ApprovalRequest, context: HookContext): Promise<ApprovalDecision> {
    const host = await this.#ready();
    const approvalId = `${request.taskId}:${request.callId}:${request.approvalId}`;
    let stored = this.#store.get(approvalId);
    if (stored === undefined) {
      const caller = host.callerOf(request.conversationId);
      if (caller === undefined) {
        return {
          approved: false,
          note: "this work did not come through the office runtime, so there is nobody to ask",
        };
      }
      stored = await this.#serial(async () => {
        // First write wins: another ask for the same call may have recorded it meanwhile.
        const known = this.#store.get(approvalId);
        if (known !== undefined) return known;
        const declaration = caller.declarations.find((item) => item.id === request.approvalId);
        const amount =
          declaration === undefined ? undefined : approvalAmount(declaration, request.arguments);
        const now = this.#now();
        const created: Stored = {
          approvalId,
          agent: caller.agent,
          tool: request.tool,
          summary: request.facts?.summary ?? request.description,
          status: "pending",
          requestedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + caller.timeoutMs).toISOString(),
          ...(amount === undefined ? {} : { amount }),
          conversationId: request.conversationId,
          description: request.description,
          arguments: JSON.parse(JSON.stringify(request.arguments)) as JsonObject,
        };
        await this.#write(created, record(created, "requested", this.#now()));
        return created;
      });
    }
    if (stored.status === "pending" && this.#expired(stored)) {
      const current = stored;
      stored = await this.#serial(async () =>
        current === this.#store.get(approvalId)
          ? await this.#settle(host, current, { status: "declined", note: TIMED_OUT }, "timed_out")
          : (this.#store.get(approvalId) as Stored),
      );
    }
    if (stored.status !== "pending") return decisionOf(stored);

    const waiting = new Promise<ApprovalDecision>((resolve, reject) => {
      const waiters = this.#waiters.get(approvalId) ?? new Set();
      this.#waiters.set(approvalId, waiters);
      const signal = context.abortSignal;
      const onAbort = () => {
        waiters.delete(wake);
        reject(signal?.reason ?? new Error("The run was stopped while waiting for an approval."));
      };
      const wake = (decision: ApprovalDecision) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(decision);
      };
      waiters.add(wake);
      if (signal?.aborted === true) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
    // Announced on every ask, a resumed run's included, so whoever watches now hears of it.
    host.announce(stored.conversationId, {
      kind: "approval_requested",
      approvalId,
      tool: stored.tool,
      summary: stored.summary,
      agent: stored.agent,
      expiresAt: stored.expiresAt,
    });
    host.broadcast(infoOf(stored));
    this.#arm(host, stored);
    return await waiting;
  }

  /** Times the request out when its deadline passes, unless it is decided first. */
  #arm(host: ApprovalsHost, stored: Stored): void {
    if (this.#timers.has(stored.approvalId) || this.#closed) return;
    // setTimeout holds at most about 24.8 days; a longer wait re-arms when this one fires.
    const delay = Math.min(Date.parse(stored.expiresAt) - this.#now(), 2 ** 31 - 1);
    const timer = setTimeout(
      () => {
        this.#timers.delete(stored.approvalId);
        void this.#serial(async () => {
          const current = this.#store.get(stored.approvalId);
          if (current?.status !== "pending") return;
          if (!this.#expired(current)) {
            this.#arm(host, current);
            return;
          }
          await this.#settle(host, current, { status: "declined", note: TIMED_OUT }, "timed_out");
        }).catch((error: unknown) =>
          host.log(`Could not time out approval ${stored.approvalId}: ${String(error)}`),
        );
      },
      Math.max(0, delay),
    );
    // A pending approval must not keep a stopping process alive on its own.
    (timer as { unref?: () => void }).unref?.();
    this.#timers.set(stored.approvalId, timer);
  }

  /** Records a decision durably, wakes the waiting call and tells the stream and the gateway. */
  async #settle(
    host: ApprovalsHost,
    stored: Stored,
    outcome: { status: "approved" | "declined"; by?: string; note?: string },
    action: ApprovalAuditRecord["action"],
  ): Promise<Stored> {
    const now = this.#now();
    const settled: Stored = {
      ...stored,
      status: outcome.status,
      decidedAt: new Date(now).toISOString(),
      ...(outcome.by === undefined ? {} : { by: outcome.by }),
      ...(outcome.note === undefined ? {} : { note: outcome.note }),
    };
    await this.#write(settled, record(settled, action, now));
    const timer = this.#timers.get(stored.approvalId);
    if (timer !== undefined) clearTimeout(timer);
    this.#timers.delete(stored.approvalId);
    const decision = decisionOf(settled);
    for (const wake of this.#waiters.get(stored.approvalId) ?? []) wake(decision);
    this.#waiters.delete(stored.approvalId);
    host.announce(settled.conversationId, {
      kind: "approval_decided",
      approvalId: settled.approvalId,
      decision: settled.status === "approved" ? "approve" : "decline",
      ...(settled.by === undefined ? {} : { by: settled.by }),
    });
    host.broadcast(infoOf(settled));
    host.log(
      `Approval ${settled.approvalId} (${settled.agent} ${settled.tool}) ${action}${settled.by === undefined ? "" : ` by ${settled.by}`}.`,
    );
    return settled;
  }

  async #write(approval: Stored, entry: ApprovalAuditRecord): Promise<void> {
    const host = this.#host as ApprovalsHost;
    await host.office.harness.commit(async (transaction) => {
      const document = await transaction.doc(ApprovalsDoc);
      document.approvals[approval.approvalId] = approval;
      document.audit.push(entry);
    }, BACKGROUND_CONTEXT);
    this.#store.set(approval.approvalId, approval);
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#writing.then(work);
    this.#writing = run.catch(() => {});
    return run;
  }

  async #ready(): Promise<ApprovalsHost> {
    await this.#bound;
    return this.#host as ApprovalsHost;
  }

  #now(): number {
    return this.#host?.now?.() ?? Date.now();
  }

  #expired(stored: Stored): boolean {
    return Date.parse(stored.expiresAt) <= this.#now();
  }
}

function infoOf(stored: Stored): ApprovalInfo {
  const {
    conversationId: _conversation,
    description: _description,
    arguments: _args,
    ...info
  } = stored;
  return info;
}

function decisionOf(stored: Stored): ApprovalDecision {
  return {
    approved: stored.status === "approved",
    ...(stored.by === undefined ? {} : { by: stored.by }),
    ...(stored.note === undefined ? {} : { note: stored.note }),
  };
}

function record(
  stored: Stored,
  action: ApprovalAuditRecord["action"],
  now: number,
): ApprovalAuditRecord {
  return {
    at: new Date(now).toISOString(),
    approvalId: stored.approvalId,
    agent: stored.agent,
    tool: stored.tool,
    action,
    ...(action === "approved" || action === "declined"
      ? { ...(stored.by === undefined ? {} : { by: stored.by }) }
      : {}),
    ...(stored.note === undefined || action === "requested" ? {} : { note: stored.note }),
  };
}

/** The audit trail as recorded, for tests and operators. */
export async function approvalAudit(office: Office): Promise<readonly ApprovalAuditRecord[]> {
  return (await office.snapshot(ApprovalsDoc))?.audit ?? [];
}
