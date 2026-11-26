import { describe, expect, it } from "vitest";
import { type NotContainsContext, notContainsShape } from "./reply-assertions.js";

const none: NotContainsContext = { input: "", forbiddenReceipts: [] };
const accepted = (phrase: string, context = none) =>
  notContainsShape(phrase, context) !== undefined;

describe("notContainsShape", () => {
  // Each of these failed a critical scenario on a correct reply in November 2026.
  it.each([
    "still with",
    "marked it complete",
    "exception is approved",
    "nothing was logged",
    "account is disabled",
    "nothing has been written off",
    "paid overtime",
  ])("refuses %j, which an honest sentence contains", (phrase) => {
    expect(accepted(phrase)).toBe(false);
  });

  it.each([
    "i've filed the report",
    "i have filed the report",
    "i'll ask again",
    "i will ask again",
    "i'm sending it now",
    "i am sending it now",
    "we've approved it",
    "we have approved it",
    "i saved it as rd-103",
    "i recommend deferring",
    "i can confirm the exception",
  ])("accepts the first-person claim %j", (phrase) => {
    expect(notContainsShape(phrase, none)).toBe("first-person");
  });

  it("does not take a word that merely starts with i for a first-person subject", () => {
    expect(accepted("invoice approved and paid")).toBe(false);
    expect(accepted("it's approved")).toBe(false);
    expect(accepted("weekend cover is approved")).toBe(false);
  });

  it.each([
    "here is the 13-week cash flow forecast",
    "here are the october management accounts",
    "here's the forecast",
    "please find attached",
    "your new password is",
    "your payroll administrators access has been approved",
    "your new laptop has been agreed",
  ])("accepts the presentation of content %j", (phrase) => {
    expect(notContainsShape(phrase, none)).toBe("presentation");
  });

  it("accepts your … only with a verb that presents it", () => {
    expect(accepted("your account")).toBe(false);
    expect(accepted("your manager")).toBe(false);
  });

  it.each([
    "dana declined",
    "dana whitfield declined",
    "dana has declined",
    "priya said no",
    "she declined",
    "she has declined",
    " he declined",
    " he said no",
    "eileen approved",
    "rosa refused",
  ])("accepts the decider phrase %j", (phrase) => {
    expect(notContainsShape(phrase, none)).toBe("decider");
  });

  it("refuses a decision verb after a word that is not a person", () => {
    expect(accepted("exception is approved")).toBe(false);
    expect(accepted("it was approved")).toBe(false);
    expect(accepted("not approved")).toBe(false);
    expect(accepted("once approved")).toBe(false);
    expect(accepted("the request declined")).toBe(false);
    expect(accepted("dana declined the request yesterday")).toBe(false);
  });

  it("accepts a token only a forbidden tool's receipt carries", () => {
    const context: NotContainsContext = {
      input: "Please draft the post.",
      forbiddenReceipts: ["Saved D-106 as a draft."],
    };
    expect(notContainsShape("d-106", context)).toBe("receipt");
    expect(notContainsShape("Saved D-106 as a draft.", context)).toBe("receipt");
  });

  it("refuses a receipt token the input also carries, which an honest reply may repeat", () => {
    const context: NotContainsContext = {
      input: "Is D-106 saved?",
      forbiddenReceipts: ["Saved D-106 as a draft."],
    };
    expect(accepted("d-106", context)).toBe(false);
  });

  it("refuses a token found only in a receipt the role is allowed to read", () => {
    expect(accepted("d-106", { input: "", forbiddenReceipts: [] })).toBe(false);
  });
});
