import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { type Approver, type DefinedRole, defineRole } from "@officehum/sdk";
import manifest from "../officehum.json" with { type: "json" };

export interface Booking {
  readonly id: string;
  readonly start: string;
  readonly customer: string;
}

export interface Calendar {
  freeSlots(date: string): Promise<string[]>;
  book(start: string, customer: string, idempotencyKey: string): Promise<Booking>;
}

export interface FrontDeskOptions {
  readonly calendar: Calendar;
  readonly overlays?: readonly string[];
  readonly approve?: Approver;
}

export default function frontdesk(options: FrontDeskOptions): DefinedRole {
  const checkSchedule = defineTool({
    name: "check_schedule",
    description: "List the available UTC appointment slots for a valid date.",
    parameters: Type.Object({ date: Type.String({ description: "UTC date as YYYY-MM-DD" }) }),
    replay: "safe",
    execute: async (args) => {
      const slots = await options.calendar.freeSlots(args.date);
      return {
        content: [
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
    description: "Reserve an available UTC slot after operator approval.",
    parameters: Type.Object({ start: Type.String(), customer: Type.String() }),
    replay: "safe",
    execute: async (args, api) => {
      const key = `${api.conversationId}:${api.taskId}:${api.callId}`;
      const booking = await options.calendar.book(args.start, args.customer, key);
      return {
        content: [{ type: "text", text: `Booked ${booking.id} at ${booking.start}` }],
        details: { ...booking },
      };
    },
  });
  return defineRole({
    packageDir: fileURLToPath(new URL("..", import.meta.url)),
    manifest,
    tools: [checkSchedule, book],
    ...(options.overlays === undefined ? {} : { overlays: options.overlays }),
    ...(options.approve === undefined ? {} : { approve: options.approve }),
  });
}
