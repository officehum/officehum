/**
 * The durable wait: a custom Pi Durable task that settles a delegator exactly once (RASF-3067).
 *
 * A delegator that needs a ticket's outcome waits on a task, not on a peer. The task is a state
 * machine with one phase, `awaiting`, that polls the board and commits a terminal outcome exactly
 * once, because Pi Durable refuses a second terminal commit. Delivery, a wake, and a recovery pass
 * racing on the same completion therefore leave one winner, which is what "settles once" means here.
 *
 * The task reads the board directly, and the board is the authority on whether the ticket is done:
 * `board.complete` writes `done` before the relay ever sees the `completed` event, so settlement does
 * not depend on the cursor catching up. That is why a crash after completion still resolves a waiter
 * on restart — the fact it is waiting for is already durable.
 *
 * Two gates, not one. `done` alone is not enough: a delegate's tool can complete the ticket a moment
 * before the delegate's own turn ends, so the answer entry may not be committed yet. The task also
 * waits until every delivery for the ticket is terminal, which is the relay's own record that the
 * delegate's submission has settled and its answer is readable. Only then does it read the transcript
 * and commit.
 *
 * The definition is built per relay rather than declared once, so the phase can close over that
 * relay's board. A task registered by name is resolved against the registry of the office it runs in,
 * and an office has one relay.
 */
import type { Context } from "@earendil-works/chord";
import {
  type ConversationId,
  defineTask,
  type Task,
  type TaskRuntime,
} from "@earendil-works/pi-durable";
import type { Board } from "../board/index.js";

/** The registered task name. Part of the durable protocol: changing it orphans live waits. */
export const WAIT_TASK_NAME = "officehum.relay.wait";

/** Version of the checkpoint shape. Bump only with a `migrate`. */
export const WAIT_TASK_VERSION = 1;

/** How long one poll parks before the next, in harness milliseconds. */
const POLL_MS = 250;

export type WaitTaskInput = {
  readonly ticketId: string;
  /** Harness-clock deadline; `null` waits forever. */
  readonly deadlineMs: number | null;
};

export type WaitTaskState = {
  readonly phase: "awaiting";
  /** Incremented every pass, so each non-terminal commit is a changed checkpoint. */
  readonly polls: number;
};

/**
 * What a settled wait reports to its delegator. `answer` is the delegate's final text when it wrote
 * one; a person-completed ticket has none, and the status is the whole result.
 */
export type WaitTaskResult =
  | {
      readonly ok: true;
      readonly ticketId: string;
      readonly status: "completed";
      readonly answer?: string;
    }
  | { readonly ok: false; readonly reason: "cancelled" | "timeout" };

export interface WaitTaskDeps {
  /** The office's board: the ticket's status and the delivery ledger, both authoritative. */
  readonly board: Board;
}

/** The last assistant text visible in `conversationId`, or `undefined` when there is none. */
async function answerText(
  runtime: TaskRuntime<WaitTaskInput, WaitTaskState, WaitTaskResult, object>,
  conversationId: ConversationId,
  context: Context,
): Promise<string | undefined> {
  const view = await runtime.context(conversationId, context);
  const text = view.messages
    .flatMap((message) =>
      message.role === "assistant"
        ? message.content.filter((block) => block.type === "text").map((block) => block.text)
        : [],
    )
    .join("");
  return text.length === 0 ? undefined : text;
}

/** The settled result a terminal commit leaves behind, whichever way it settled. */
function completed(ticketId: string, answer: string | undefined): WaitTaskResult {
  return answer === undefined
    ? { ok: true, ticketId, status: "completed" }
    : { ok: true, ticketId, status: "completed", answer };
}

/**
 * Build the wait task over one relay's board. Register it in the relay's extension; the relay does
 * that itself so a caller cannot forget and end up with a wait that never runs.
 */
export function createWaitTask(
  deps: WaitTaskDeps,
): Task<WaitTaskInput, WaitTaskState, WaitTaskResult, object> {
  return defineTask<WaitTaskInput, WaitTaskState, WaitTaskResult>({
    name: WAIT_TASK_NAME,
    version: WAIT_TASK_VERSION,
    initial: () => ({ phase: "awaiting", polls: 0 }),
    phases: {
      awaiting: async (task, runtime, context) => {
        const { ticketId, deadlineMs } = task.input;
        const ticket = deps.board.get(ticketId);
        if (ticket === undefined) {
          // The wait has nothing to settle on. Failing closed beats parking forever on a ticket that
          // no longer exists.
          await runtime.commit(
            () => ({
              status: "terminal",
              outcome: {
                status: "failed",
                error: { message: `No ticket ${ticketId} on this board.` },
              },
            }),
            context,
          );
          return;
        }
        if (ticket.status === "cancelled") {
          await runtime.commit(
            () => ({
              status: "terminal",
              outcome: {
                status: "aborted",
                reason: "cancelled",
                result: { ok: false, reason: "cancelled" },
              },
            }),
            context,
          );
          return;
        }
        if (ticket.status === "done" && settledDeliveries(deps.board, ticketId)) {
          const answer = await answerText(runtime, task.conversationId, context);
          await runtime.commit(
            () => ({
              status: "terminal",
              outcome: { status: "completed", result: completed(ticketId, answer) },
            }),
            context,
          );
          return;
        }
        if (deadlineMs !== null && runtime.now() >= deadlineMs) {
          await runtime.commit(
            () => ({
              status: "terminal",
              outcome: {
                status: "failed",
                error: { message: `Wait on ticket ${ticketId} timed out.` },
                result: { ok: false, reason: "timeout" },
              },
            }),
            context,
          );
          return;
        }
        // No terminal outcome yet: commit a changed checkpoint (the phase must make durable progress)
        // and park. A poll, not a wake: settlement is a board fact, so polling cannot miss it.
        await runtime.commit(
          () => ({
            status: "running",
            checkpoint: { phase: "awaiting", polls: task.state.checkpoint.polls + 1 },
          }),
          context,
        );
        await runtime.sleep(runtime.now() + POLL_MS, context);
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(
        () => ({
          status: "terminal",
          outcome: {
            status: "aborted",
            reason: "cancelled",
            result: { ok: false, reason: "cancelled" },
          },
        }),
        context,
      );
    },
  });
}

/** Whether every delivery for the ticket has reached a terminal state (or there are none). */
function settledDeliveries(board: Board, ticketId: string): boolean {
  return board.relay
    .deliveriesForTicket(ticketId)
    .every((delivery) => delivery.state !== "pending" && delivery.state !== "admitted");
}
