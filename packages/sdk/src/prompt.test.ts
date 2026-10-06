import { describe, expect, it } from "vitest";
import { ROLE_SECTION_KEYS, roleSections } from "./prompt.js";

describe("roleSections", () => {
  it("builds Pi Durable sections in the fixed role order", async () => {
    const sections = roleSections({
      identity: "You are the bookkeeper.",
      responsibilities: "Invoice completed jobs.",
      boundaries: "Never move money.",
      houseStyle: () => "Be brief.",
    });
    expect(sections.map((section) => section.key)).toEqual([...ROLE_SECTION_KEYS]);
    const rendered = await Promise.all(
      sections.map((section) =>
        section.render(
          {} as Parameters<typeof section.render>[0],
          {} as Parameters<typeof section.render>[1],
        ),
      ),
    );
    expect(rendered).toEqual([
      "You are the bookkeeper.",
      "Invoice completed jobs.",
      "Never move money.",
      "Be brief.",
    ]);
  });
});
