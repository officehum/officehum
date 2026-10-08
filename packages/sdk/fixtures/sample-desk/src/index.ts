/**
 * Sample Desk: the smallest complete portable role, used to test @officehum/sdk. Its prompt and
 * skills are files (AGENTS.md, APPEND_SYSTEM.md, skills/); this entry point only adds the tools,
 * which take the app they work in (a calendar) from the factory's options.
 *
 *   const role = sampleDesk({ calendar, overlays: ["./my-desk"] });
 *   for (const extension of role.extensions) registry.install(extension);
 *   const root = await harness.root(context, { agent: role.agent });
 */

import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { type Approver, type DefinedRole, defineRole } from "../../../src/index.js";
import manifest from "../officehum.json" with { type: "json" };

/** The calendar the desk books into. Office Hum passes a gateway-backed one; anyone else, their own. */
export interface Calendar {
  freeSlots(date: string): Promise<string[]>;
  book(start: string, customer: string): Promise<{ readonly id: string }>;
}

export interface SampleDeskOptions {
  readonly calendar: Calendar;
  /** Overlay directories with the business's own AGENTS.md, skills and settings. */
  readonly overlays?: readonly string[];
  /** Decides after-hours bookings. Omitted: they are blocked. */
  readonly approve?: Approver;
}

export default function sampleDesk(options: SampleDeskOptions): DefinedRole {
  const checkSchedule = defineTool({
    name: "check_schedule",
    description: "List the free appointment slots on a date.",
    parameters: Type.Object({ date: Type.String({ description: "The date, as YYYY-MM-DD" }) }),
    replay: "safe",
    execute: async (args) => {
      const slots = await options.calendar.freeSlots(args.date);
      const text = slots.length === 0 ? "No free slots" : `Free: ${slots.join(", ")}`;
      return { content: [{ type: "text", text }] };
    },
  });

  const bookAppointment = defineTool({
    name: "book_appointment",
    description: "Book an appointment that check_schedule showed as free.",
    parameters: Type.Object({
      start: Type.String({ description: "Start time, as YYYY-MM-DDTHH:MM" }),
      customer: Type.String({ description: "The customer's name or email" }),
    }),
    replay: "unsafe",
    execute: async (args) => {
      const booking = await options.calendar.book(args.start, args.customer);
      return { content: [{ type: "text", text: `Booked ${booking.id} for ${args.start}` }] };
    },
  });

  return defineRole({
    packageDir: fileURLToPath(new URL("..", import.meta.url)),
    manifest,
    overlays: options.overlays,
    approve: options.approve,
    tools: [checkSchedule, bookAppointment],
    when: { book_after_hours: (args) => Number(String(args.start).slice(11, 13)) >= 18 },
  });
}
