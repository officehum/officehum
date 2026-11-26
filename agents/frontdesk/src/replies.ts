import {
  defineDoc,
  defineTool,
  type HookRegistration,
  hook,
  type ToolRegistration,
  ToolTask,
} from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import {
  APPROVED_FACTS_ARG,
  type ApprovalFacts,
  type ApprovalFactsReader,
  approvedFacts,
  approvedFactsParameter,
  canonicalJson,
  sameCanonical,
  sameFacts,
} from "@officehum/sdk";
import { ContactsDoc, markContactSeen } from "./contacts.js";

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
  checkpointWhen: () => false,
  scope: "session",
  initial: () => ({ replies: [] }),
});

const InboundConversationMarkerDoc = defineDoc<{ authorityId: string; senders: string[] }>({
  kind: "officehum.inbound.conversation",
  version: 1,
  checkpointWhen: () => false,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ authorityId: "", senders: [] }),
});

/** The marker `openSmsIntake` writes on a conversation that began as a text. */
const SmsConversationMarkerDoc = defineDoc<{
  agent: string;
  number: string;
  contactId: string;
  provenance: "external";
}>({
  kind: "officehum.sms.conversation",
  version: 1,
  checkpointWhen: () => false,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ agent: "", number: "", contactId: "", provenance: "external" }),
});

/** Defense in depth for customer conversations, including model calls that were not offered. */
export function inboundCustomerToolGuard(): HookRegistration {
  return hook(ToolTask, {
    beforeTool: async (call, api, context) => {
      const marker = await api.snapshot(InboundConversationMarkerDoc, api.conversationId, context);
      if (marker !== undefined) {
        if (call.name === "check_schedule" || call.name === "reply_message") return undefined;
        return {
          block:
            "Inbound customer conversations may only check availability and reply to their authenticated email receipt.",
        };
      }
      // A conversation that began as a text has no email receipt to answer on, so its reply leaves by
      // email through `send_message` — where a person's approval gates the first contact. Availability
      // and that one reply are the whole of what a customer's text may cause; everything else here is
      // the office's own work, not theirs.
      const sms = await api.snapshot(SmsConversationMarkerDoc, api.conversationId, context);
      if (sms !== undefined) {
        if (call.name === "check_schedule" || call.name === "send_message") return undefined;
        return {
          block:
            "A conversation that began as a text may only check availability and reply by email; the office does not send SMS.",
        };
      }
      return undefined;
    },
  });
}

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

function delivery(value: ReplyDeliveryReceipt): ReplyDeliveryReceipt {
  if (value?.status !== "accepted") throw new Error("Reply transport returned an invalid receipt.");
  return { id: bounded(value.id, "Reply delivery ID", 200), status: "accepted" };
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

/** Said when the office has no reply transport: a capability check, not an approval. */
export const REPLY_NOT_CONNECTED =
  "Inbound email replies are not connected in this office, so this reply was not sent and nobody was asked to approve it. Tell the user so they can reply to the customer themselves.";

/** What a person approves for one reply: where it goes, as the inbound record says, and its text. */
export type ReplyFacts = { target: ReplyTarget; text: string };

/** The reply's destination for this call, read from the inbound records through the messenger. */
async function resolvedTarget(
  messenger: ReplyMessenger,
  receiptId: string,
  conversationId: string,
): Promise<ReplyTarget> {
  const identity = bounded(messenger.identity, "Reply Messenger identity", 200);
  const prepared = target(await messenger.prepare(receiptId, conversationId));
  if (
    prepared.receiptId !== receiptId ||
    prepared.conversationId !== conversationId ||
    prepared.messengerId !== identity
  ) {
    throw new Error("Reply target does not match this conversation or transport.");
  }
  return prepared;
}

/**
 * The `confirm_inbound_reply` facts reader: the reply's authenticated destination, read from the
 * inbound records by the messenger for the receipt and this call's conversation (never from the
 * model's arguments, which carry only a receipt id), and the exact text. The approver is shown both,
 * and on a yes the tool sends only that reply to that destination.
 */
export function replyFacts(messenger?: ReplyMessenger): ApprovalFactsReader {
  return async (args, _context, call): Promise<ApprovalFacts> => {
    if (messenger === undefined) throw new Error(REPLY_NOT_CONNECTED);
    const receiptId = bounded(args.receiptId, "Receipt ID", 200);
    const replyText = text(args.text);
    const destination = await resolvedTarget(messenger, receiptId, String(call.conversationId));
    const facts: ReplyFacts = { target: destination, text: replyText };
    return {
      summary: `Reply to ${destination.to} (${destination.subject}): ${replyText}`,
      facts,
    };
  };
}

/**
 * The approved facts on this call, checked: a reply the gate granted carries exactly the target and
 * text a person saw. Anything else (no grant, a malformed grant, or one for other words) refuses.
 */
function grantedReply(raw: Readonly<Record<string, unknown>>, replyText: string): ReplyFacts {
  const granted = approvedFacts(raw);
  if (granted === undefined) {
    throw new Error("This reply has no approval: a person must approve it before it is sent.");
  }
  const approvedTarget = target(granted.target);
  if (typeof granted.text !== "string" || granted.text !== replyText) {
    throw new Error("The approved reply's text is not this call's text, so it was not sent.");
  }
  return { target: approvedTarget, text: granted.text };
}

/**
 * The reply tool. It raises no approval of its own: the role's gate asks `confirm_inbound_reply` with
 * the facts `replyFacts` reads, and on a yes passes them here under `officehumApprovedFacts`. The tool
 * sends exactly that reply, and refuses if the inbound record no longer resolves to the destination
 * the person approved.
 */
export function repliesTools(messenger?: ReplyMessenger): ToolRegistration[] {
  return [
    defineTool({
      name: "reply_message",
      description:
        "Reply to the current authenticated inbound email. A person approves the exact reply and its destination first; it is sent when they grant it.",
      parameters: obj({
        receiptId: str(),
        text: str(),
        [APPROVED_FACTS_ARG]: approvedFactsParameter(),
      }),
      replay: "safe",
      executionMode: "parallel",
      execute: async (raw, api, context) => {
        const receiptId = bounded(raw.receiptId, "Receipt ID", 200);
        const replyText = text(raw.text);
        if (messenger === undefined) throw new Error(REPLY_NOT_CONNECTED);
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
            !sameCanonical(previous.argsJson, argsJson) ||
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
        const granted = grantedReply(raw, replyText);
        if (
          granted.target.receiptId !== receiptId ||
          granted.target.conversationId !== String(api.conversationId) ||
          granted.target.messengerId !== identity
        ) {
          throw new Error("The approved reply is for another receipt, conversation or transport.");
        }
        // The record as it stands now must still be the one the person approved.
        const current = await resolvedTarget(messenger, receiptId, String(api.conversationId));
        if (!sameFacts(current, granted.target)) {
          throw new Error(
            "The inbound email this reply answers changed after the reply was approved, so it was not sent. Ask for the reply again.",
          );
        }
        const accepted = delivery(
          await messenger.send({ target: granted.target, text: granted.text }, { requestId: key }),
        );
        const candidate: ReplyRecord = {
          key,
          argsJson,
          target: granted.target,
          text: granted.text,
          delivery: accepted,
        };
        const stored = await api.commit(async (tx) => {
          const doc = await tx.doc(RepliesDoc);
          const prior = doc.replies.find((reply) => reply.key === key);
          if (prior !== undefined) {
            if (!same(prior, candidate))
              throw new Error("Reply history contains a conflicting receipt.");
            return prior;
          }
          doc.replies.push(candidate);
          // A customer wrote in: the reply's destination is the inbound envelope's authenticated
          // sender. When it exactly matches a stored contact, record a last-seen marker. Identity
          // comes only from that verified address, never from the message text, and no contact is
          // created or corrected here, so the first-contact approval is untouched.
          markContactSeen(await tx.doc(ContactsDoc), candidate.target.to, new Date().toISOString());
          return candidate;
        }, context);
        return toolResult(stored, false);
      },
    }),
  ];
}

/**
 * The demonstration inbox, for evals on demonstration data only (`demo`): every receipt is an email
 * from the demonstration guest, guest@example.test, in the conversation that asks. It resolves a
 * destination so the approval can be asked and shown; it sends nothing anywhere and answers with a
 * demonstration receipt. A production office never builds it: `demo` is reserved to the host.
 */
export function demoReplyMessenger(): ReplyMessenger {
  const identity = "officehum.demo.reply";
  return {
    identity,
    async prepare(receiptId, conversationId) {
      const parent = `<${receiptId.replace(/[^A-Za-z0-9.-]/gu, "-")}@demo.example.test>`;
      return {
        receiptId,
        conversationId,
        messengerId: identity,
        from: "frontdesk@demo.example.test",
        to: "guest@example.test",
        replyTo: "frontdesk@demo.example.test",
        subject: "Re: your email",
        inReplyTo: parent,
        references: [parent],
      };
    },
    async send(_intent, options) {
      return {
        id: `demo-${options.requestId.replace(/[^A-Za-z0-9-]/gu, "-")}`,
        status: "accepted",
      };
    },
  };
}
