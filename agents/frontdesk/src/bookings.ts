import type { Context } from "@earendil-works/chord";
import { defineDoc, type ToolExecutionApi } from "@earendil-works/pi-durable";

/**
 * What the Front Desk records about a booking that the calendar does not hold. A calendar knows a
 * slot and a customer; a discount the booking was made with is the desk's to remember, so the next
 * person to read the booking sees it and it is not agreed a second time.
 */
export type BookingDiscount = {
  /** The durable identity of the `book_appointment` call that made the booking. */
  key: string;
  bookingId: string;
  /** The rate in percent, exactly as the booking call carried it past the discount approval. */
  discountPercent: number;
};

export type BookingsDocument = { discounts: BookingDiscount[] };

export const BookingsDoc = defineDoc<BookingsDocument>({
  kind: "frontdesk.bookings",
  version: 1,
  scope: "session",
  initial: () => ({ discounts: [] }),
});

/**
 * Record the discount a booking was made with, once per booking call: a replay of the same call
 * finds its own record and writes nothing.
 */
export async function recordBookingDiscount(
  bookingId: string,
  discountPercent: number,
  api: ToolExecutionApi,
  context: Context,
): Promise<void> {
  const key = `${api.conversationId}:${api.taskId}:${api.callId}`;
  await api.commit(async (tx) => {
    const state = await tx.doc(BookingsDoc);
    const prior = state.discounts.find((discount) => discount.key === key);
    if (prior !== undefined) {
      if (prior.bookingId !== bookingId || prior.discountPercent !== discountPercent) {
        throw new Error("This booking call identity already recorded a different discount.");
      }
      return;
    }
    state.discounts.push({ key, bookingId, discountPercent });
  }, context);
}

/** The discount recorded for each booking, by booking id. */
export function discountsByBooking(
  state: Readonly<BookingsDocument> | undefined,
): ReadonlyMap<string, number> {
  return new Map(
    (state?.discounts ?? []).map((discount) => [discount.bookingId, discount.discountPercent]),
  );
}
