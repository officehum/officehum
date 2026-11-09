import type { PromptSection } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import sampleDesk from "../fixtures/sample-desk/src/index.js";
import { isoDate, todaySection, todayText } from "./today.js";

const calendar = { freeSlots: async () => [], book: async () => ({ id: "A1" }) };

async function renderKeys(sections: readonly PromptSection[] | undefined) {
  const out: Record<string, string | undefined> = {};
  for (const section of sections ?? []) {
    out[section.key] = await section.render({} as never, {} as never);
  }
  return out;
}

describe("today", () => {
  it("todayText names today and the next 14 days", () => {
    const lines = todayText(new Date("2026-11-09T15:00:00.000Z")).split("\n");
    expect(lines).toEqual([
      "Today is 2026-11-09 (Monday).",
      "Tue 2026-11-10, Wed 2026-11-11, Thu 2026-11-12, Fri 2026-11-13, Sat 2026-11-14, Sun 2026-11-15, Mon 2026-11-16, Tue 2026-11-17, Wed 2026-11-18, Thu 2026-11-19, Fri 2026-11-20, Sat 2026-11-21, Sun 2026-11-22, Mon 2026-11-23",
      "Every date you state or record comes from this section or a tool result.",
    ]);
  });

  it("isoDate and the today section name the same UTC day at a month end", async () => {
    const at = new Date("2026-11-30T23:30:00.000Z");
    expect(isoDate(at)).toBe("2026-11-30");
    const section = todaySection(() => at);
    expect(section.key).toBe("today");
    const text = await section.render({} as never, {} as never);
    expect(text).toMatch(/^Today is 2026-11-30 \(Monday\)\.\nTue 2026-12-01, /);
  });

  it("renders from the clock at every request, not once", async () => {
    let now = new Date("2026-11-09T15:00:00.000Z");
    const section = todaySection(() => now);
    expect(await section.render({} as never, {} as never)).toMatch(/^Today is 2026-11-09/);
    now = new Date("2026-11-10T15:00:00.000Z");
    expect(await section.render({} as never, {} as never)).toMatch(/^Today is 2026-11-10/);
  });

  it("defineRole adds no today section without now", async () => {
    const sections = await renderKeys(sampleDesk({ calendar }).extensions[0]?.sections);
    expect(Object.keys(sections)).toEqual(["agents_md", "skills", "append_system"]);
  });

  it("defineRole adds the today section, last, from the clock it is given", async () => {
    const role = sampleDesk({ calendar, now: () => new Date("2027-02-01T09:00:00.000Z") });
    const sections = await renderKeys(role.extensions[0]?.sections);
    expect(Object.keys(sections)).toEqual(["agents_md", "skills", "append_system", "today"]);
    expect(sections.today).toMatch(/^Today is 2027-02-01 \(Monday\)\./);
  });
});
