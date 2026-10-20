import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import {
  type ApprovalCondition,
  type Approver,
  type DefinedRole,
  defineRole,
} from "@officehum/sdk";
import manifest from "../officehum.json" with { type: "json" };
import { contactTools, linkBookingContact, pinBookingContact } from "./contacts.js";
import { firstContactCondition, type Messenger, messagingTools } from "./messaging.js";
import { inboundCustomerToolGuard, type ReplyMessenger, repliesTools } from "./replies.js";

export { type Contact, ContactsDoc } from "./contacts.js";
export {
  type DeliveryReceipt,
  type MessageChannel,
  type MessageIntent,
  type MessageRecord,
  MessagesDoc,
  type MessagesDocument,
  type Messenger,
} from "./messaging.js";
export {
  inboundCustomerToolGuard,
  RepliesDoc,
  type ReplyDeliveryReceipt,
  type ReplyMessenger,
  type ReplyRecord,
  type ReplyTarget,
  repliesTools,
} from "./replies.js";

export interface Booking {
  readonly id: string;
  readonly start: string;
  readonly customer: string;
}

export interface Cancellation {
  readonly id: string;
  readonly status: "canceled";
  readonly alreadyCanceled: boolean;
}

export interface Calendar {
  freeSlots(date: string): Promise<string[]>;
  listBookings(): Promise<Booking[]>;
  book(start: string, customer: string, idempotencyKey: string): Promise<Booking>;
  reschedule(id: string, start: string, idempotencyKey: string): Promise<Booking>;
  cancel(id: string, idempotencyKey: string): Promise<Cancellation>;
}

export interface FrontDeskOptions {
  readonly calendar: Calendar;
  readonly messenger?: Messenger;
  readonly overlays?: readonly string[];
  readonly approve?: Approver;
  readonly replyMessenger?: ReplyMessenger;
  readonly approveReply?: Approver;
}

/**
 * A booking waits for a person only when it carries a discount above the business's rate. The rate is
 * the manifest's `booking_discount_percent` limit — an overlay sets it — so the role never hard-codes a
 * threshold. Absence of `discountPercent` means no discount, so it is not gated; a discount that is not
 * a finite number, or a limit that did not resolve, fails safe and waits rather than passing silently.
 */
export const discountApprovalCondition: ApprovalCondition = (args, environment) => {
  const percent = args.discountPercent;
  if (percent === undefined) return false;
  if (typeof percent !== "number" || !Number.isFinite(percent)) return true;
  const limit = environment.limits.booking_discount_percent;
  if (typeof limit !== "number") return true;
  return percent > limit;
};

export default function frontdesk(options: FrontDeskOptions): DefinedRole {
  const checkSchedule = defineTool({
    name: "check_schedule",
    description: "List the available UTC appointment slots for a valid date.",
    parameters: Type.Object({ date: Type.String({ description: "UTC date as YYYY-MM-DD" }) }),
    replay: "safe",
    execute: async (args) => {
      const slots = await options.calendar.freeSlots(args.date);
      return {
        output: [
          {
            type: "text",
            text: slots.length === 0 ? "No free slots" : `Free: ${slots.join(", ")}`,
          },
        ],
        details: { slots },
      };
    },
  });
  const book = defineTool({
    name: "book_appointment",
    description:
      "Reserve an available UTC slot after operator approval; a discount above the business's rate also waits for a person.",
    parameters: Type.Object(
      {
        start: Type.String(),
        customer: Type.String(),
        contactId: Type.Optional(Type.String()),
        discountPercent: Type.Optional(
          Type.Number({
            description:
              "The discount rate in percent, when one was agreed; a rate above the business's limit waits for a person.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    replay: "safe",
    execute: async (args, api, context) => {
      const key = `${api.conversationId}:${api.taskId}:${api.callId}`;
      const pinned =
        args.contactId === undefined
          ? undefined
          : await pinBookingContact(
              { start: args.start, customer: args.customer, contactId: args.contactId },
              api,
              context,
            );
      const booking = await options.calendar.book(args.start, pinned?.name ?? args.customer, key);
      if (pinned !== undefined) await linkBookingContact(pinned, booking.id, api, context);
      return {
        output: [{ type: "text", text: `Booked ${booking.id} at ${booking.start}` }],
        details: { ...booking },
      };
    },
  });
  const listBookings = defineTool({
    name: "list_bookings",
    description:
      "List active managed appointments in UTC, including the exact booking IDs needed for changes.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async () => {
      const bookings = [...(await options.calendar.listBookings())].sort(
        (left, right) => left.start.localeCompare(right.start) || left.id.localeCompare(right.id),
      );
      return {
        output: [
          {
            type: "text",
            text:
              bookings.length === 0
                ? "No active bookings"
                : `Bookings:\n${bookings
                    .map(({ id, start, customer }) => `${id} — ${start} — ${customer}`)
                    .join("\n")}`,
          },
        ],
        details: {
          bookings: bookings.map(({ id, start, customer }) => ({ id, start, customer })),
        },
      };
    },
  });
  const reschedule = defineTool({
    name: "reschedule_appointment",
    description: "Move one managed appointment by its exact booking ID after operator approval.",
    parameters: Type.Object({ id: Type.String(), start: Type.String() }),
    replay: "safe",
    execute: async (args, api) => {
      const key = `${api.conversationId}:${api.taskId}:${api.callId}`;
      const booking = await options.calendar.reschedule(args.id, args.start, key);
      return {
        output: [{ type: "text", text: `Rescheduled ${booking.id} to ${booking.start}` }],
        details: { ...booking },
      };
    },
  });
  const cancel = defineTool({
    name: "cancel_appointment",
    description: "Cancel one managed appointment by its exact booking ID after operator approval.",
    parameters: Type.Object({ id: Type.String() }),
    replay: "safe",
    execute: async (args, api) => {
      const key = `${api.conversationId}:${api.taskId}:${api.callId}`;
      const cancellation = await options.calendar.cancel(args.id, key);
      return {
        output: [
          {
            type: "text",
            text: `${cancellation.alreadyCanceled ? "Already canceled" : "Canceled"} ${cancellation.id}`,
          },
        ],
        details: { ...cancellation },
      };
    },
  });
  return defineRole({
    packageDir: fileURLToPath(new URL("..", import.meta.url)),
    manifest,
    tools: [
      checkSchedule,
      listBookings,
      ...contactTools(),
      ...messagingTools(options.messenger),
      ...repliesTools(options.replyMessenger, options.approveReply),
      book,
      reschedule,
      cancel,
    ],
    ...(options.overlays === undefined ? {} : { overlays: options.overlays }),
    ...(options.approve === undefined ? {} : { approve: options.approve }),
    when: { first_contact: firstContactCondition, discount_booking: discountApprovalCondition },
    hooks: [inboundCustomerToolGuard()],
  });
}
