import { describe, expect, it } from "vitest";
import type { AgentManifest } from "./manifest.js";
import { outsideApprovals, outsideFloor, outsideHints, reachesOutside } from "./send-tools.js";

const manifest = (tools: AgentManifest["tools"]): Pick<AgentManifest, "tools"> => ({ tools });

describe("outsideFloor", () => {
  const floored = {
    tools: [
      { name: "email_customer", replay: "unsafe", outside: true },
      { name: "pay", replay: "unsafe" },
    ],
    approvals: [
      {
        id: "bulk_email",
        tool: "email_customer",
        description: "Many recipients",
        when: [{ arg: "recipients", op: "gt", value: { limit: "bulk_recipients" } }],
      },
      {
        id: "big_payment",
        tool: "pay",
        description: "A big payment",
        when: [{ arg: "amount", op: "gt", value: { limit: "payment_limit" } }],
      },
    ],
    limits: {
      bulk_recipients: { description: "Recipients", default: 10 },
      payment_limit: { description: "Payments", default: 100 },
      order_limit: { description: "Orders", default: 5, guard: "ceiling", outside: true },
      reminder_days: { description: "Days", default: 3, guard: "none" },
    },
  } as unknown as AgentManifest;

  it("says which way a limit is held by the outside floor, and nothing for the others", () => {
    expect(outsideFloor(floored, "bulk_recipients")).toBe("ceiling");
    expect(outsideFloor(floored, "order_limit")).toBe("ceiling");
    expect(outsideFloor(floored, "payment_limit")).toBeUndefined();
    expect(outsideFloor(floored, "reminder_days")).toBeUndefined();
  });

  it("lists the approvals on tools that reach outside", () => {
    expect(outsideApprovals(floored).map((approval) => approval.id)).toEqual(["bulk_email"]);
  });
});

describe("reachesOutside", () => {
  it("is a tool declared outside, or one of the channel's send tools", () => {
    expect(reachesOutside({ name: "publish", outside: true })).toBe(true);
    expect(reachesOutside({ name: "reply_message" })).toBe(true);
    expect(reachesOutside({ name: "publish" })).toBe(false);
  });
});

describe("outsideHints", () => {
  it("warns on a writing tool that sounds like it sends or publishes but does not say outside", () => {
    expect(
      outsideHints(
        manifest([
          { name: "send_statement", replay: "unsafe", noApproval: "test" },
          {
            name: "share_update",
            replay: "unsafe",
            description: "Post the update to the company's social channels.",
            noApproval: "test",
          },
        ]),
      ),
    ).toEqual([
      {
        source: "officehum.json",
        path: "tools[0]",
        severity: "warning",
        message:
          '"send_statement" changes something and mentions "send"; if it sends or publishes to people outside the business, declare "outside": true so no overlay can switch its approval off',
      },
      {
        source: "officehum.json",
        path: "tools[1]",
        severity: "warning",
        message:
          '"share_update" changes something and mentions "post"; if it sends or publishes to people outside the business, declare "outside": true so no overlay can switch its approval off',
      },
    ]);
  });

  it("says nothing of a tool declared outside, a channel send tool, or one that only reads", () => {
    expect(
      outsideHints(
        manifest([
          { name: "publish", replay: "unsafe", outside: true, noApproval: "test" },
          { name: "send_message", replay: "safe", writes: true },
          { name: "list_messages", replay: "safe", description: "Read the messages sent today." },
          { name: "record_count", replay: "unsafe", noApproval: "test" },
        ]),
      ),
    ).toEqual([]);
  });
});
