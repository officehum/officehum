/**
 * How a relayed message leaves the office (RASF-3067).
 *
 * The transport is kept narrow on purpose. Routing, wrapping and guards all live above it, so the
 * transport cannot pick the wrong conversation (the relay resolved it), cannot forget the untrusted
 * fence (the relay already applied it), and cannot skip a guard (the relay already ran them). All it
 * knows is how to admit one wrapped message and how to await its settlement.
 *
 * `HarnessRelayTransport` wraps `office.submit` / `office.submission` with the event id as the
 * `requestId`. That is the whole exactly-once argument: Pi Durable returns the original submission
 * for a repeated `(conversation, requestId)`, so a redelivery after a crash — the relay re-sending
 * the same event — is idempotent at the only layer that can be. A cross-office transport (RASF-3110)
 * adds a second implementation of this interface; nothing above it changes.
 *
 * The transport receives the resolved `Conversation` rather than the conversation key. The plan had
 * it resolve the key itself; resolving needs the role's agent settings, which the relay owns, and a
 * transport that guessed them would be choosing the recipient's identity. Handing over a resolved
 * conversation keeps that decision in one place.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  type Conversation,
  type SettledSubmissionRecord,
} from "@earendil-works/pi-durable";
import type { Office } from "../adapter/index.js";
import type { RelayMessage } from "./message.js";

/** How a delivered message ended. `answer` is the delegate's final text, when it produced one. */
export type DeliveryOutcome =
  | { readonly status: "done"; readonly answer?: string }
  | { readonly status: "unanswered"; readonly reason: string }
  | { readonly status: "skipped" };

/** One admitted delivery. `id` is Pi Durable's `SubmissionId`, so recovery can reacquire by id. */
export interface DeliveryHandle {
  readonly id: number;
  /** Resolve when the submission is terminal. Never rejects for an ordinary settlement. */
  wait(): Promise<DeliveryOutcome>;
}

/** Everything one delivery needs. The relay builds it; the transport never guesses. */
export interface DeliveryTarget {
  /** Idempotency key scoped to the conversation — always the board event's id. */
  readonly requestId: string;
  /** The conversation key the target was derived from, kept for the ledger and for reacquire. */
  readonly conversationKey: string;
  /** The resolved conversation the message goes to. */
  readonly conversation: Conversation;
}

export interface RelayTransport {
  /** A later cross-office implementation makes this a union; the relay only ever compares it. */
  readonly kind: "harness";
  /** Admit one wrapped message. A repeated `target.requestId` returns the original admission. */
  deliver(target: DeliveryTarget, message: RelayMessage): Promise<DeliveryHandle>;
  /**
   * Re-find the submission a delivery already made, without admitting anything new. `undefined` when
   * the conversation has no submission for that request id — the caller then falls back to `deliver`.
   */
  reacquire(target: DeliveryTarget): Promise<DeliveryHandle | undefined>;
}

/** The assistant text one settled submission produced, read the way `solo.ts` reads an answer. */
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
  return text === undefined || text.length === 0 ? undefined : text;
}

/** The outcome of one admitted submission, once it settles. */
async function settle(
  conversation: Conversation,
  submission: { wait(context: typeof BACKGROUND_CONTEXT): Promise<SettledSubmissionRecord> },
): Promise<DeliveryOutcome> {
  const settlement = await submission.wait(BACKGROUND_CONTEXT);
  if (settlement.status !== "done") {
    return { status: "unanswered", reason: settlement.reason };
  }
  const answer = await answerText(conversation, settlement);
  return answer === undefined ? { status: "done" } : { status: "done", answer };
}

/**
 * The transport every office uses today: Pi Durable submissions inside the one harness.
 *
 * `reacquire` asks the Session for the submission a `(conversation, requestId)` pair already made.
 * It is a read-only commit, so reacquiring cannot admit anything by accident — which is exactly what
 * a recovery pass needs.
 */
export function harnessTransport(office: Office): RelayTransport {
  return {
    kind: "harness",
    async deliver(target, message) {
      const submission = await office.submit(target.conversation, {
        input: message.content,
        requestId: target.requestId,
        entry: message.entry,
      });
      return {
        id: submission.id,
        wait: () => settle(target.conversation, submission),
      };
    },
    async reacquire(target) {
      const record = await office.harness.commit(
        (transaction) => transaction.submissionByRequest(target.conversation.id, target.requestId),
        BACKGROUND_CONTEXT,
      );
      if (record === undefined) return undefined;
      const submission = await office.submission(record.id);
      if (submission === undefined) return undefined;
      return {
        id: submission.id,
        wait: () => settle(target.conversation, submission),
      };
    },
  };
}
