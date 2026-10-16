import { Type } from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineTool,
  type HookRegistration,
  hook,
  type ToolRegistration,
  ToolTask,
} from "@earendil-works/pi-durable";
import type { ApprovalDecision, ApprovalRequest, Approver } from "@officehum/sdk";

export type ReplyTarget = {
  receiptId: string;
  conversationId: string;
  messengerId: string;
  from: string;
  to: string;
  replyTo: string;
  subject: string;
  inReplyTo: string;
  references: string[];
};

export type ReplyDeliveryReceipt = { id: string; status: "accepted" };

export interface ReplyMessenger {
  readonly identity: string;
  prepare(receiptId: string, conversationId: string): Promise<ReplyTarget>;
  send(
    intent: { target: ReplyTarget; text: string },
    options: { requestId: string },
  ): Promise<ReplyDeliveryReceipt>;
}

export type ReplyRecord = {
  key: string;
  argsJson: string;
  target: ReplyTarget;
  text: string;
  delivery: ReplyDeliveryReceipt;
};

export const RepliesDoc = defineDoc<{ replies: ReplyRecord[] }>({
  kind: "frontdesk.replies",
  version: 1,
  scope: "session",
  initial: () => ({ replies: [] }),
});

const InboundConversationMarkerDoc = defineDoc<{ authorityId: string; senders: string[] }>({
  kind: "officehum.inbound.conversation",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ authorityId: "", senders: [] }),
});

/** Defense in depth for customer conversations, including model calls that were not offered. */
export function inboundCustomerToolGuard(): HookRegistration {
  return hook(ToolTask, {
    beforeTool: async (call, api, context) => {
      const marker = await api.snapshot(InboundConversationMarkerDoc, api.conversationId, context);
      if (marker === undefined) return undefined;
      if (call.name === "check_schedule" || call.name === "reply_message") return undefined;
      return {
        block:
          "Inbound customer conversations may only check availability and reply to their authenticated email receipt.",
      };
    },
  });
}

type ReplyMemo = Omit<ReplyRecord, "delivery">;
type DecisionMemo = {
  requestJson: string;
  approved: boolean;
  by: string | null;
  note: string | null;
};

const EMAIL =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const MESSAGE_ID = /^<[\x21-\x3b\x3d\x3f\x41-\x7e]+@[\x21-\x3b\x3d\x3f\x41-\x7e]+>$/u;

function hasControl(value: string, message = false): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    if (message && (code === 9 || code === 10 || code === 13)) return false;
    return code <= 31 || (code >= 127 && code <= 159);
  });
}

function bounded(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    hasControl(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function text(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4000 ||
    value.trim().length === 0 ||
    hasControl(value, true)
  ) {
    throw new Error("Reply text is invalid.");
  }
  return value;
}

function target(value: unknown): ReplyTarget {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Reply target is invalid.");
  }
  const source = value as Record<string, unknown>;
  const to = bounded(source.to, "Reply destination", 254);
  const from = bounded(source.from, "Reply sender", 254);
  const replyTo = bounded(source.replyTo, "Reply-To", 254);
  if (
    to !== to.toLowerCase() ||
    from !== from.toLowerCase() ||
    replyTo !== replyTo.toLowerCase() ||
    !EMAIL.test(to) ||
    !EMAIL.test(from) ||
    !EMAIL.test(replyTo)
  ) {
    throw new Error("Reply target is invalid.");
  }
  const inReplyTo = bounded(source.inReplyTo, "Reply parent", 998);
  if (!MESSAGE_ID.test(inReplyTo)) throw new Error("Reply target is invalid.");
  if (
    !Array.isArray(source.references) ||
    source.references.length === 0 ||
    source.references.length > 50
  ) {
    throw new Error("Reply target is invalid.");
  }
  const references = source.references.map((entry) => {
    const id = bounded(entry, "Reply reference", 998);
    if (!MESSAGE_ID.test(id)) throw new Error("Reply target is invalid.");
    return id;
  });
  if (references.join(" ").length > 8192) throw new Error("Reply target is invalid.");
  return {
    receiptId: bounded(source.receiptId, "Receipt ID", 200),
    conversationId: bounded(source.conversationId, "Conversation ID", 200),
    messengerId: bounded(source.messengerId, "Messenger ID", 200),
    from,
    to,
    replyTo,
    subject: bounded(source.subject, "Reply subject", 998),
    inReplyTo,
    references,
  };
}

function canonicalJson(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, canonical(child)]),
      );
    }
    return item;
  };
  return JSON.stringify(canonical(value));
}

function delivery(value: ReplyDeliveryReceipt): ReplyDeliveryReceipt {
  if (value?.status !== "accepted") throw new Error("Reply transport returned an invalid receipt.");
  return { id: bounded(value.id, "Reply delivery ID", 200), status: "accepted" };
}

function decision(value: ApprovalDecision): ApprovalDecision {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.approved !== "boolean" ||
    (value.by !== undefined &&
      (typeof value.by !== "string" || value.by.length > 200 || hasControl(value.by))) ||
    (value.note !== undefined &&
      (typeof value.note !== "string" || value.note.length > 1000 || hasControl(value.note, true)))
  ) {
    throw new Error("Reply approval was invalid.");
  }
  return value;
}

function same(left: ReplyRecord, right: ReplyRecord): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function toolResult(record: ReplyRecord, replayed: boolean) {
  return {
    output: [
      {
        type: "text" as const,
        text: replayed ? "Historical receipt: Accepted by transport." : "Accepted by transport.",
      },
    ],
    details: {
      ...record,
      target: { ...record.target, references: [...record.target.references] },
      delivery: { ...record.delivery },
      replayed,
    },
  };
}

export function repliesTools(messenger?: ReplyMessenger, approve?: Approver): ToolRegistration[] {
  return [
    defineTool({
      name: "reply_message",
      description: "Reply to the current authenticated inbound email after operator approval.",
      parameters: Type.Object(
        { receiptId: Type.String(), text: Type.String() },
        { additionalProperties: false },
      ),
      replay: "safe",
      executionMode: "parallel",
      execute: async (raw, api, context) => {
        const receiptId = bounded(raw.receiptId, "Receipt ID", 200);
        const replyText = text(raw.text);
        if (messenger === undefined || approve === undefined) {
          throw new Error("Inbound reply transport and operator approval are required.");
        }
        const identity = bounded(messenger.identity, "Reply Messenger identity", 200);
        const key = `${api.conversationId}:${api.taskId}:${api.callId}`;
        const argsJson = canonicalJson({ receiptId, text: replyText });
        const history = await api.snapshot(RepliesDoc, context);
        const matches = history?.replies.filter((reply) => reply.key === key) ?? [];
        if (matches.length > 1)
          throw new Error("Reply history contains a duplicate call identity.");
        const previous = matches[0];
        if (previous !== undefined) {
          const previousTarget = target(previous.target);
          const previousDelivery = delivery(previous.delivery);
          if (
            previous.argsJson !== argsJson ||
            text(previous.text) !== replyText ||
            canonicalJson(previousTarget) !== canonicalJson(previous.target) ||
            canonicalJson(previousDelivery) !== canonicalJson(previous.delivery) ||
            previousTarget.receiptId !== receiptId ||
            previousTarget.conversationId !== String(api.conversationId) ||
            previousTarget.messengerId !== identity
          ) {
            throw new Error("This reply call identity was already used with different arguments.");
          }
          return toolResult(previous, true);
        }
        let pinned = await api.memo<ReplyMemo>("frontdesk.reply-intent", context);
        if (pinned === undefined) {
          const prepared = target(await messenger.prepare(receiptId, String(api.conversationId)));
          if (
            prepared.receiptId !== receiptId ||
            prepared.conversationId !== String(api.conversationId) ||
            prepared.messengerId !== identity
          ) {
            throw new Error("Reply target does not match this conversation or transport.");
          }
          pinned = await api.memo<ReplyMemo>(
            "frontdesk.reply-intent",
            { key, argsJson, target: prepared, text: replyText },
            context,
          );
        }
        if (
          pinned.key !== key ||
          pinned.argsJson !== argsJson ||
          pinned.text !== replyText ||
          canonicalJson(target(pinned.target)) !== canonicalJson(pinned.target) ||
          pinned.target.receiptId !== receiptId ||
          pinned.target.conversationId !== String(api.conversationId) ||
          pinned.target.messengerId !== identity
        ) {
          throw new Error("This reply call identity was already used with different arguments.");
        }
        const request: ApprovalRequest = {
          approvalId: "confirm_inbound_reply",
          description: "Confirm this exact threaded reply to the authenticated inbound sender",
          tool: "reply_message",
          arguments: { target: pinned.target, text: pinned.text },
          conversationId: String(api.conversationId),
          taskId: String(api.taskId),
          callId: api.callId,
        };
        const requestJson = canonicalJson(request);
        let savedDecision = await api.memo<DecisionMemo>("frontdesk.reply-approval", context);
        if (savedDecision === undefined) {
          const answer = decision(await approve(request, context));
          savedDecision = await api.memo<DecisionMemo>(
            "frontdesk.reply-approval",
            {
              requestJson,
              approved: answer.approved,
              by: answer.by ?? null,
              note: answer.note ?? null,
            },
            context,
          );
        }
        if (savedDecision.requestJson !== requestJson) {
          throw new Error("This approval identity was already used with a different reply.");
        }
        if (!savedDecision.approved) throw new Error("The operator declined this inbound reply.");
        const accepted = delivery(
          await messenger.send(
            { target: pinned.target, text: pinned.text },
            { requestId: pinned.key },
          ),
        );
        const candidate: ReplyRecord = { ...pinned, delivery: accepted };
        const stored = await api.commit(async (tx) => {
          const doc = await tx.doc(RepliesDoc);
          const prior = doc.replies.find((reply) => reply.key === key);
          if (prior !== undefined) {
            if (!same(prior, candidate))
              throw new Error("Reply history contains a conflicting receipt.");
            return prior;
          }
          doc.replies.push(candidate);
          return candidate;
        }, context);
        return toolResult(stored, false);
      },
    }),
  ];
}
