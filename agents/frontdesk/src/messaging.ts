import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ApprovalCondition } from "@officehum/sdk";
import { ContactsDoc } from "./contacts.js";

/**
 * The one channel this role can send on.
 *
 * SMS used to be here, and it was reachable: the tool offered it, and the delivery path validated an
 * E.164 destination for it. RASF-3162 buys SMS inbound only, so the channel is gone rather than
 * hidden — a type with one member is what a schema of one member compiles from, and there is no
 * branch left in this file that could accept a phone number.
 */
export type MessageChannel = "email";
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

function validTarget(value: string): string {
  const target = exactBounded(value, "Message destination", 254);
  if (target !== target.toLowerCase() || !EMAIL.test(target)) {
    throw new Error("Email destination must be a canonical lowercase email address.");
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

/**
 * The delivery layer's refusal: the second of the two places outbound SMS is refused.
 *
 * The tool's schema no longer offers `sms`, which stops a model expressing the call. That is a check
 * at the edge, and edges move — a persisted intent written by an older build, a host that calls a
 * messenger itself, a helper added later — so the last function before a message leaves this role
 * refuses anything but email too. The two fail differently: the schema is a model that cannot say it,
 * this is a delivery that will not do it. It refuses by name so the failure says why rather than
 * looking like a typo in a destination.
 */
export function deliverableChannel(channel: unknown): "email" {
  if (channel !== "email") {
    throw new Error(
      "The Front Desk sends email only: SMS is inbound, and a reply to a text goes out as email.",
    );
  }
  return "email";
}

function normalizedArguments(args: SendArguments): SendArguments {
  const channel = deliverableChannel(args.channel);
  return {
    contactId: exactBounded(args.contactId, "Contact ID", 200),
    channel,
    to: validTarget(args.to),
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
    pinned.channel !== "email" ||
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
    output: [
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
    if (contact.email !== args.to) return true;
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
          message.channel !== "email" ||
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
    description: `Send an explicit saved-contact email through messenger ${transport}. This call raises the approval request for a person and sends the message when they grant it; the first message to a destination on this transport waits for that person. The Front Desk does not send SMS: an inbound text is answered by email.`,
    parameters: Type.Object(
      {
        contactId: Type.String(),
        // Email only. `sms` is not a value the model can express, which is the first of the two
        // layers that keep outbound SMS dead; see `deliverableChannel` for the second.
        channel: Type.Literal("email"),
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
        if (contact.email !== args.to) {
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
          { to: pinned.to, channel: deliverableChannel(pinned.channel), text: pinned.text },
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
