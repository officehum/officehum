import { fileURLToPath } from "node:url";
import { defineTool } from "@earendil-works/pi-durable";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import { type Approver, type DefinedRole, defineRole } from "@officehum/sdk";
import manifest from "../officehum.json" with { type: "json" };
import { BookingsDoc, discountsByBooking, recordBookingDiscount } from "./bookings.js";
import { contactTools, linkBookingContact, pinBookingContact } from "./contacts.js";
import {
  firstContactCondition,
  type Messenger,
  messagingTools,
  type StaffAsked,
  unrequestedMessageCondition,
} from "./messaging.js";
import {
  demoReplyMessenger,
  inboundCustomerToolGuard,
  type ReplyMessenger,
  repliesTools,
  replyFacts,
} from "./replies.js";

export { type BookingDiscount, BookingsDoc, type BookingsDocument } from "./bookings.js";
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
  demoReplyMessenger,
  inboundCustomerToolGuard,
  REPLY_NOT_CONNECTED,
  RepliesDoc,
  type ReplyDeliveryReceipt,
  type ReplyFacts,
  type ReplyMessenger,
  type ReplyRecord,
  type ReplyTarget,
  repliesTools,
  replyFacts,
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
  /**
   * Decides every gated action, the inbound reply's `confirm_inbound_reply` included: one approver,
   * one ask per reply. Omitted: every gated action is refused.
   */
  readonly approve?: Approver;
  /**
   * Whether a verified member of staff asked for a conversation's work themselves (an office runtime
   * passes one). Given, `send_message` waits for a person (`confirm_unrequested_message`) whenever
   * nobody on the staff asked; omitted (solo), messages are asked about only on first contact.
   */
  readonly staffAsked?: StaffAsked;
  /** Sends inbound replies. Omitted: `reply_message` answers that replies are not connected. */
  readonly replyMessenger?: ReplyMessenger;
  /**
   * Run on demonstration data (reserved to the host, which sets it only for evals): with no reply
   * messenger, inbound replies resolve against the demonstration inbox (`demoReplyMessenger`).
   */
  readonly demo?: boolean;
}

export default function frontdesk(options: FrontDeskOptions): DefinedRole {
  const replyMessenger =
    options.replyMessenger ?? (options.demo === true ? demoReplyMessenger() : undefined);
  const checkSchedule = defineTool({
    name: "check_schedule",
    description: "List the available UTC appointment slots for a valid date.",
    parameters: obj({ date: str({ description: "UTC date as YYYY-MM-DD" }) }, { open: true }),
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
      "Reserve an available UTC slot. This call raises the approval request for a person and performs the booking when they grant it; a discount above the business's rate also waits for a person.",
    parameters: obj({
      start: str(),
      customer: str(),
      contactId: opt(str()),
      discountPercent: opt(
        num({
          description:
            "The discount rate in percent, when one was agreed; a rate above the business's limit waits for a person.",
        }),
      ),
    }),
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
      // A discount that reaches this point is within the business's rate or a person approved it
      // (`discount_booking`); either way the booking was made with it, so it is recorded on it.
      const discount =
        args.discountPercent !== undefined && args.discountPercent > 0
          ? args.discountPercent
          : undefined;
      if (discount !== undefined) await recordBookingDiscount(booking.id, discount, api, context);
      return {
        output: [
          {
            type: "text",
            text: `Booked ${booking.id} at ${booking.start}${discount === undefined ? "" : ` with a ${discount}% discount`}`,
          },
        ],
        details: { ...booking, ...(discount === undefined ? {} : { discountPercent: discount }) },
      };
    },
  });
  const listBookings = defineTool({
    name: "list_bookings",
    description:
      "List active managed appointments in UTC, including the exact booking IDs needed for changes and any discount a booking was made with.",
    parameters: obj({}, { open: true }),
    replay: "safe",
    execute: async (_args, api, context) => {
      const discounts = discountsByBooking(await api.snapshot(BookingsDoc, context));
      const bookings = [...(await options.calendar.listBookings())]
        .sort(
          (left, right) => left.start.localeCompare(right.start) || left.id.localeCompare(right.id),
        )
        .map(({ id, start, customer }) => {
          const discountPercent = discounts.get(id);
          return {
            id,
            start,
            customer,
            ...(discountPercent === undefined ? {} : { discountPercent }),
          };
        });
      return {
        output: [
          {
            type: "text",
            text:
              bookings.length === 0
                ? "No active bookings"
                : `Bookings:\n${bookings
                    .map(
                      ({ id, start, customer, discountPercent }) =>
                        `${id} — ${start} — ${customer}${discountPercent === undefined ? "" : ` — ${discountPercent}% discount`}`,
                    )
                    .join("\n")}`,
          },
        ],
        details: { bookings },
      };
    },
  });
  const reschedule = defineTool({
    name: "reschedule_appointment",
    description:
      "Move one managed appointment by its exact booking ID. This call raises the approval request for a person and performs the move when they grant it.",
    parameters: obj({ id: str(), start: str() }, { open: true }),
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
    description:
      "Cancel one managed appointment by its exact booking ID. This call raises the approval request for a person and performs the cancellation when they grant it.",
    parameters: obj({ id: str() }, { open: true }),
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
      ...repliesTools(replyMessenger),
      book,
      reschedule,
      cancel,
    ],
    ...(options.overlays === undefined ? {} : { overlays: options.overlays }),
    ...(options.approve === undefined ? {} : { approve: options.approve }),
    when: {
      first_contact: firstContactCondition,
      confirm_unrequested_message: unrequestedMessageCondition(options.staffAsked),
    },
    // The reply is asked about like every other approval: the gate reads where it will go from the
    // inbound records (the model's arguments carry only a receipt id) and shows it with the text, and
    // on a yes the tool sends exactly that.
    approvalFacts: { confirm_inbound_reply: replyFacts(replyMessenger) },
    hooks: [inboundCustomerToolGuard()],
  });
}
