import { describe } from "vitest";
import { calendarContract } from "./fixtures/calendar-contract.js";
import { fakeCalendar } from "./index.js";

describe("Calendar contract: the fake", () => {
  calendarContract((schedule) => fakeCalendar(schedule));
});
