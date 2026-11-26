/**
 * A test app client for `officehum run --clients`: exports a factory that returns a calendar. It
 * reads where to record bookings from the environment, never from the config file, so the config can
 * be proved credential-free.
 */
import { appendFileSync } from "node:fs";

export default function createCalendar() {
  return {
    freeSlots: async () => ["2030-01-15T18:00"],
    book: async (start, customer) => {
      const log = process.env.OFFICEHUM_TEST_BOOK_LOG;
      if (log !== undefined) appendFileSync(log, `${start} ${customer}\n`);
      return { id: "booking-1" };
    },
  };
}
