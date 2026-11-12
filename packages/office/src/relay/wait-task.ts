/**
 * The durable wait: a custom Pi Durable task that settles a delegator exactly once (RASF-3067).
 *
 * A delegator that needs a ticket's outcome waits on a task, not on a peer. The task is a state
 * machine with one phase, `awaiting`, that polls the board and commits a terminal outcome exactly
 * once, because Pi Durable refuses a second terminal commit. Delivery, a wake, and a recovery pass
 * racing on the same completion therefore leave one winner, which is what "settles once" means here.
 *
 * The terminal outcome is the only thing the task ever commits. While the ticket is open there is
 * nothing new to make durable, so the phase stays in its invocation and sleeps between looks at the
 * board; a restart re-enters the phase from the same checkpoint and looks again.
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
  type RunningTask,
  type Task,
  type TaskOutcome,
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
  /**
   * Always 0 for a new wait. Earlier versions committed a checkpoint per poll and counted them here;
   * the field stays so those checkpoints still load under this version.
   */
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
  // The last message that says something: a ticket's conversation holds every turn it took (text
  // before a tool call, an earlier delivery's reply), and those are not part of the answer.
  for (const message of view.messages.toReversed()) {
    if (message.role !== "assistant") continue;
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (text.length > 0) return text;
  }
  return undefined;
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
        // One invocation polls until there is an outcome to commit. A poll, not a wake: settlement
        // is a board fact, so polling cannot miss it. Returning between polls would need a changed
        // checkpoint each time (Pi Durable faults a phase that returns without one), which is a
        // storage write every interval for as long as a ticket waits.
        for (;;) {
          const outcome = await outcomeOf(deps.board, ticketId, deadlineMs, task, runtime, context);
          if (outcome !== undefined) {
            await runtime.commit(() => ({ status: "terminal", outcome }), context);
            return;
          }
          await runtime.sleep(runtime.now() + POLL_MS, context);
        }
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

/** The wait's terminal outcome as the board stands now, or `undefined` while there is none yet. */
async function outcomeOf(
  board: Board,
  ticketId: string,
  deadlineMs: number | null,
  task: RunningTask<WaitTaskInput, WaitTaskState, WaitTaskResult>,
  runtime: TaskRuntime<WaitTaskInput, WaitTaskState, WaitTaskResult, object>,
  context: Context,
): Promise<TaskOutcome<WaitTaskResult> | undefined> {
  const ticket = board.get(ticketId);
  if (ticket === undefined) {
    // The wait has nothing to settle on. Failing closed beats parking forever on a ticket that no
    // longer exists.
    return { status: "failed", error: { message: `No ticket ${ticketId} on this board.` } };
  }
  if (ticket.status === "cancelled") {
    return { status: "aborted", reason: "cancelled", result: { ok: false, reason: "cancelled" } };
  }
  if (ticket.status === "done" && settledDeliveries(board, ticketId)) {
    // A recorded result is what the delegate said it was replying with; its transcript is whatever
    // it happened to write last. Prefer the answer the board holds, and fall back to the transcript
    // only for tickets closed without one (a human closing it, say).
    const answer = ticket.result ?? (await answerText(runtime, task.conversationId, context));
    return { status: "completed", result: completed(ticketId, answer) };
  }
  if (deadlineMs !== null && runtime.now() >= deadlineMs) {
    return {
      status: "failed",
      error: { message: `Wait on ticket ${ticketId} timed out.` },
      result: { ok: false, reason: "timeout" },
    };
  }
  return undefined;
}

/** Whether every delivery for the ticket has reached a terminal state (or there are none). */
function settledDeliveries(board: Board, ticketId: string): boolean {
  return board.relay
    .deliveriesForTicket(ticketId)
    .every((delivery) => delivery.state !== "pending" && delivery.state !== "admitted");
}
