import { MEMORY_TOOL_NAMES } from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import { normalSubject, recordId, SUBJECT_PATTERN, statusFor } from "./record.js";
import { memoryTools } from "./tools.js";

describe("normalSubject", () => {
  it("lower-cases a customer or vendor subject's system and keeps everything else as given", () => {
    expect(normalSubject("customer:QuickBooks:customer-42")).toBe(
      "customer:quickbooks:customer-42",
    );
    expect(normalSubject("vendor:XERO:Bill-7")).toBe("vendor:xero:Bill-7");
    expect(normalSubject("customer:quickbooks:42")).toBe("customer:quickbooks:42");
    expect(normalSubject("person:Eileen")).toBe("person:Eileen");
    expect(normalSubject("business")).toBe("business");
    expect(normalSubject("topic:payment-plans")).toBe("topic:payment-plans");
  });
});

describe("statusFor", () => {
  const person = { type: "person", ref: "local-user" } as const;
  const external = { type: "external", ref: "email:42" } as const;

  it("keeps outside content unverified, whatever its kind", () => {
    expect(statusFor("fact", external).status).toBe("unverified");
    expect(statusFor("rule", external).status).toBe("unverified");
  });

  it("proposes rules and procedures, and saves facts and preferences active", () => {
    expect(statusFor("rule", person).status).toBe("proposed");
    expect(statusFor("procedure", person).status).toBe("proposed");
    expect(statusFor("fact", person).status).toBe("active");
    expect(statusFor("preference", { type: "conversation", ref: "c1" }).status).toBe("active");
  });

  it("says why", () => {
    expect(statusFor("fact", external).reason).toMatch(/outside source.*until a person confirms/);
    expect(statusFor("rule", person).reason).toMatch(/approved/);
  });
});

describe("recordId", () => {
  it("is mem_ plus 26 Crockford base32 characters, the same for the same conversation and call", () => {
    const id = recordId("conversation-1", "call-1");
    expect(id).toMatch(/^mem_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(recordId("conversation-1", "call-1")).toBe(id);
    expect(recordId("conversation-1", "call-2")).not.toBe(id);
    expect(recordId("conversation-2", "call-1")).not.toBe(id);
  });
});

describe("SUBJECT_PATTERN", () => {
  it("accepts the six subject shapes and refuses anything else", () => {
    for (const subject of [
      "business",
      "customer:quickbooks:42",
      "vendor:quickbooks:7",
      "person:jane",
      "agent:bookkeeper",
      "topic:year-end-close",
    ]) {
      expect(new RegExp(SUBJECT_PATTERN).test(subject), subject).toBe(true);
    }
    for (const subject of ["customer:42", "Business", "topic:Year End", "anything", "person:"]) {
      expect(new RegExp(SUBJECT_PATTERN).test(subject), subject).toBe(false);
    }
  });
});

describe("the SDK's memory vocabulary", () => {
  it("names the four tools the extension defines, in order", () => {
    expect(memoryTools({ role: "desk" }).map((tool) => tool.name)).toEqual([...MEMORY_TOOL_NAMES]);
  });

  it("tells the model to set reviewAt whenever the fact names when it ends", () => {
    const save = memoryTools({ role: "desk" }).find((tool) => tool.name === "memory_save");
    const parameters = save?.parameters as {
      properties: Record<string, { description?: string }>;
    };
    expect(parameters.properties.reviewAt?.description).toBe(
      "YYYY-MM-DD. Set it whenever the fact says when it ends or should be looked at again " +
        '("until March", "for the next quarter", "through the summer"): the first day of the ' +
        "month or period it names, or the exact date when it gives one. With no year, use the next " +
        "such date after today. Leave it out only for a fact with no end.",
    );
  });
});
