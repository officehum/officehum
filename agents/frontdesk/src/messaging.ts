import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ApprovalCondition } from "@officehum/sdk";
import { ContactsDoc } from "./contacts.js";

export type MessageChannel = "email" | "sms";
export type MessageIntent = { to: string; channel: MessageChannel; text: string };
export type DeliveryReceipt = { id: string; status: "recorded" | "accepted" };

export interface Messenger {
  readonly identity: string;
  send(intent: MessageIntent, options: { requestId: string }): Promise<DeliveryReceipt>;
}

export type MessageRecord = {
  key: string;
  argsJson: string;
  messengerId: string;
  contactId: string;
  contactRevision: number;
  contactName: string;
  to: string;
  channel: MessageChannel;
  text: string;
  delivery: DeliveryReceipt;
};

export type MessagesDocument = { messages: MessageRecord[] };

export const MessagesDoc = defineDoc<MessagesDocument>({
  kind: "frontdesk.messages",
  version: 1,
  scope: "session",
  initial: () => ({ messages: [] }),
});

type SendArguments = {
  contactId: string;
  channel: MessageChannel;
  to: string;
  text: string;
  messengerId: string;
};

type MessageIntentMemo = Omit<MessageRecord, "delivery">;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const PHONE = /^\+[1-9][0-9]{6,14}$/u;

function hasForbiddenControl(value: string, allowMessageWhitespace = false): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    if (allowMessageWhitespace && (code === 9 || code === 10 || code === 13)) return false;
    return code <= 31 || (code >= 127 && code <= 159);
  });
}

function exactBounded(value: string, label: string, maximum: number): string {
  if (
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    hasForbiddenControl(value)
  ) {
    throw new Error(
      `${label} must be 1-${maximum} characters with no outer whitespace or controls.`,
    );
  }
  return value;
}

function validTarget(channel: MessageChannel, value: string): string {
  const target = exactBounded(value, "Message destination", channel === "email" ? 254 : 16);
  if (channel === "email") {
    if (target !== target.toLowerCase() || !EMAIL.test(target)) {
      throw new Error("Email destination must be a canonical lowercase email address.");
    }
  } else if (!PHONE.test(target)) {
    throw new Error("SMS destination must be a canonical international phone number.");
  }
  return target;
}

function validText(value: string): string {
  if (value.length === 0 || value.length > 4000 || value.trim().length === 0) {
    throw new Error("Message text must be nonblank and between 1 and 4000 characters.");
  }
  if (hasForbiddenControl(value, true)) {
    throw new Error("Message text contains an unsupported control character.");
  }
  return value;
}

function normalizedArguments(args: SendArguments): SendArguments {
  const channel = args.channel;
  if (channel !== "email" && channel !== "sms") throw new Error("Unknown message channel.");
  return {
    contactId: exactBounded(args.contactId, "Contact ID", 200),
    channel,
    to: validTarget(channel, args.to),
    text: validText(args.text),
    messengerId: exactBounded(args.messengerId, "Messenger ID", 200),
  };
}

function argumentsJson(args: SendArguments): string {
  return JSON.stringify({
    contactId: args.contactId,
    channel: args.channel,
    to: args.to,
    text: args.text,
    messengerId: args.messengerId,
  });
}

function assertPinned(
  pinned: MessageIntentMemo,
  key: string,
  args: SendArguments,
  argsJson: string,
): void {
  if (
    pinned === null ||
    typeof pinned !== "object" ||
    pinned.key !== key ||
    pinned.argsJson !== argsJson ||
    typeof pinned.messengerId !== "string" ||
    typeof pinned.contactId !== "string" ||
    !Number.isSafeInteger(pinned.contactRevision) ||
    typeof pinned.contactName !== "string" ||
    typeof pinned.to !== "string" ||
    (pinned.channel !== "email" && pinned.channel !== "sms") ||
    typeof pinned.text !== "string"
  ) {
    throw new Error("This messaging call identity was already used with different arguments.");
  }
  if (
    pinned.messengerId !== args.messengerId ||
    pinned.contactId !== args.contactId ||
    pinned.to !== args.to ||
    pinned.channel !== args.channel ||
    pinned.text !== args.text
  ) {
    throw new Error("This messaging call identity was already used with different arguments.");
  }
}

function deliveryReceipt(value: DeliveryReceipt): DeliveryReceipt {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > 200 ||
    value.id.trim() !== value.id ||
    hasForbiddenControl(value.id) ||
    (value.status !== "recorded" && value.status !== "accepted")
  ) {
    throw new Error("Messenger returned a malformed delivery receipt.");
  }
  return { id: value.id, status: value.status };
}

function sameRecord(left: MessageRecord, right: MessageRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function result(record: MessageRecord, replayed: boolean) {
  const copy =
    record.delivery.status === "recorded"
      ? "Recorded in console outbox; no customer delivery"
      : "Accepted by transport";
  return {
    content: [
      {
        type: "text" as const,
        text: replayed ? `Historical receipt: ${copy}.` : `${copy}.`,
      },
    ],
    details: {
      ...record,
      delivery: { ...record.delivery },
      replayed,
    },
  };
}

function matchingCommitted(
  state: Readonly<MessagesDocument> | undefined,
  key: string,
  args: SendArguments,
  argsJson: string,
): MessageRecord | undefined {
  const prior = state?.messages.find((message) => message.key === key);
  if (prior === undefined) return undefined;
  if (
    prior.argsJson !== argsJson ||
    prior.messengerId !== args.messengerId ||
    prior.contactId !== args.contactId ||
    prior.to !== args.to ||
    prior.channel !== args.channel ||
    prior.text !== args.text
  ) {
    throw new Error("This messaging call identity was already used with different arguments.");
  }
  deliveryReceipt(prior.delivery);
  return {
    ...prior,
    delivery: { ...prior.delivery },
  };
}

/** Approval is needed until this exact transport/contact/channel/destination has successful history. */
export const firstContactCondition: ApprovalCondition = async (raw, environment, context) => {
  try {
    const args = normalizedArguments(raw as SendArguments);
    const contacts = await environment.read.snapshot(ContactsDoc, context);
    if (contacts === undefined || !Array.isArray(contacts.contacts)) return true;
    const contact = contacts.contacts.find(({ id }) => id === args.contactId);
    if (contact === undefined) return true;
    const destination = args.channel === "email" ? contact.email : contact.phone;
    if (destination !== args.to) return true;
    const state = await environment.read.snapshot(MessagesDoc, context);
    if (state === undefined) return true;
    if (!Array.isArray(state.messages)) return true;
    if (
      state.messages.some(
        (message) =>
          message === null ||
          typeof message !== "object" ||
          typeof message.key !== "string" ||
          typeof message.argsJson !== "string" ||
          typeof message.messengerId !== "string" ||
          typeof message.contactId !== "string" ||
          !Number.isSafeInteger(message.contactRevision) ||
          typeof message.contactName !== "string" ||
          typeof message.to !== "string" ||
          (message.channel !== "email" && message.channel !== "sms") ||
          typeof message.text !== "string" ||
          typeof message.delivery?.id !== "string" ||
          (message.delivery.status !== "recorded" && message.delivery.status !== "accepted"),
      )
    ) {
      return true;
    }
    return !state.messages.some(
      (message) =>
        message !== null &&
        typeof message === "object" &&
        typeof message.delivery?.id === "string" &&
        (message.delivery.status === "recorded" || message.delivery.status === "accepted") &&
        message.messengerId === args.messengerId &&
        message.contactId === args.contactId &&
        message.channel === args.channel &&
        message.to === args.to,
    );
  } catch {
    context.abortSignal?.throwIfAborted();
    return true;
  }
};

/** Build portable messaging tools; all durable workflow state lives behind the invocation API. */
export function messagingTools(messenger?: Messenger): ToolRegistration[] {
  const transport = messenger?.identity ?? "unconfigured";
  const send = defineTool({
    name: "send_message",
    description: `Send an explicit saved-contact message through messenger ${transport}.`,
    parameters: Type.Object(
      {
        contactId: Type.String(),
        channel: Type.Union([Type.Literal("email"), Type.Literal("sms")]),
        to: Type.String(),
        text: Type.String(),
        messengerId: Type.String(),
      },
      { additionalProperties: false },
    ),
    replay: "safe",
    executionMode: "parallel",
    execute: async (raw, api, context) => {
      const args = normalizedArguments(raw);
      if (messenger === undefined) throw new Error("No Messenger is configured for Front Desk.");
      const messengerIdentity = exactBounded(messenger.identity, "Configured Messenger ID", 200);
      if (args.messengerId !== messengerIdentity) {
        throw new Error(
          "Messenger identity changed; request fresh approval for the configured transport.",
        );
      }
      const key = `${api.conversationId}:${api.taskId}:${api.callId}`;
      const argsJson = argumentsJson(args);
      const committed = matchingCommitted(
        await api.snapshot(MessagesDoc, context),
        key,
        args,
        argsJson,
      );
      if (committed !== undefined) return result(committed, true);

      let pinned = await api.memo<MessageIntentMemo>("frontdesk.message-intent", context);
      if (pinned === undefined) {
        const contacts = await api.snapshot(ContactsDoc, context);
        const contact = contacts?.contacts.find(({ id }) => id === args.contactId);
        if (contact === undefined) throw new Error(`Unknown contact ${args.contactId}.`);
        const destination = args.channel === "email" ? contact.email : contact.phone;
        if (destination !== args.to) {
          throw new Error("Contact destination mismatch. List current contacts before retrying.");
        }
        pinned = await api.memo<MessageIntentMemo>(
          "frontdesk.message-intent",
          {
            key,
            argsJson,
            messengerId: args.messengerId,
            contactId: contact.id,
            contactRevision: contact.revision,
            contactName: contact.name,
            to: args.to,
            channel: args.channel,
            text: args.text,
          },
          context,
        );
      }
      assertPinned(pinned, key, args, argsJson);
      if (pinned.messengerId !== messengerIdentity) {
        throw new Error("Pinned message transport does not match the configured Messenger.");
      }
      const delivery = deliveryReceipt(
        await messenger.send(
          { to: pinned.to, channel: pinned.channel, text: pinned.text },
          { requestId: pinned.key },
        ),
      );
      const candidate: MessageRecord = { ...pinned, delivery };
      const saved = await api.commit(async (tx): Promise<MessageRecord> => {
        const state = await tx.doc(MessagesDoc);
        const prior = state.messages.find((message) => message.key === key);
        if (prior !== undefined) {
          if (!sameRecord(prior, candidate)) {
            throw new Error("This messaging call identity has a conflicting successful receipt.");
          }
          return { ...prior, delivery: { ...prior.delivery } };
        }
        state.messages.push({ ...candidate, delivery: { ...candidate.delivery } });
        return { ...candidate, delivery: { ...candidate.delivery } };
      }, context);
      return result(saved, false);
    },
  });
  return [send];
}
