import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { type AgentCard, AgentCardSchema, agentCard, formatCard, formatCardLine } from "./card.js";
import { formatIssue } from "./issues.js";
import type { AgentManifest } from "./manifest.js";
import { type ResolvedRole, resolveRoleFiles } from "./resources.js";
import { removeTempDirs, SAMPLE_DIR, tempDir } from "./test-helpers.js";

afterEach(removeTempDirs);

const manifest = JSON.parse(
  readFileSync(join(SAMPLE_DIR, "officehum.json"), "utf8"),
) as AgentManifest;

/** The effective role: the package files, with the given overlays applied. */
function resolve(overlays: string[] = [], against: AgentManifest = manifest): ResolvedRole {
  const result = resolveRoleFiles({ packageDir: SAMPLE_DIR, manifest: against, overlays });
  if (!result.ok) throw new Error(result.issues.map(formatIssue).join("\n"));
  return result.value;
}

const capabilityNames = (card: AgentCard) =>
  card.capabilities.map((capability) => `${capability.kind}:${capability.name}`);

describe("agentCard", () => {
  it("builds the Sample Desk card, matching a snapshot", () => {
    const card = agentCard(manifest, resolve());
    expect(Value.Check(AgentCardSchema, card)).toBe(true);
    expect(card.id).toBe("sample-desk");
    expect(card.department).toBe("front-office");
    expect(card.status).toBe("active");
    expect(capabilityNames(card)).toEqual([
      "skill:rescheduling",
      "tool:check_schedule",
      "tool:book_appointment",
    ]);
    // read_skill is the SDK's, not the manifest's, so it never appears on a card.
    expect(capabilityNames(card)).not.toContain("tool:read_skill");
    expect(card).toMatchSnapshot();
  });

  it("marks a tool's effect from its replay and lists the approvals that gate it", () => {
    const card = agentCard(manifest, resolve());
    const schedule = card.capabilities.find((c) => c.name === "check_schedule");
    const booking = card.capabilities.find((c) => c.name === "book_appointment");
    expect(schedule).toMatchObject({ effect: "reads" });
    expect(schedule?.approvals).toBeUndefined();
    expect(booking).toMatchObject({
      effect: "changes",
      approvals: ["Bookings that start at 18:00 or later"],
    });
  });

  it("takes a status when the office reports one", () => {
    expect(agentCard(manifest, resolve(), { status: "paused" }).status).toBe("paused");
  });

  it("removes a tool an overlay switches off from the card", () => {
    const overlay = tempDir("acme", {
      "settings.json": JSON.stringify({ tools: ["-book_appointment"] }),
    });
    const card = agentCard(manifest, resolve([overlay]));
    expect(capabilityNames(card)).toEqual(["skill:rescheduling", "tool:check_schedule"]);
    expect(capabilityNames(card)).not.toContain("tool:book_appointment");
  });

  it("removes a skill an overlay switches off from the card", () => {
    const overlay = tempDir("acme", {
      "settings.json": JSON.stringify({ skills: ["-rescheduling"] }),
    });
    const card = agentCard(manifest, resolve([overlay]));
    expect(capabilityNames(card)).not.toContain("skill:rescheduling");
  });

  it("never carries overlay settings values, limits or prompt text", () => {
    const overlay = tempDir("acme", {
      "AGENTS.override.md": "Acme's own instructions, a secret to the card.",
      "settings.json": JSON.stringify({
        defaultProvider: "paper",
        defaultModel: "ultramarine-1-flash",
        defaultThinkingLevel: "xhigh",
        tools: ["-book_appointment"],
        limits: { large_invoice: 2500 },
      }),
    });
    const withLimits: AgentManifest = {
      ...manifest,
      limits: { large_invoice: { description: "Invoices over the amount", default: 5000 } },
    };
    const role = resolve([overlay], withLimits);
    const card = agentCard(withLimits, role);

    const text = JSON.stringify(card);
    for (const hidden of [
      "ultramarine-1-flash",
      "xhigh",
      "2500",
      "large_invoice",
      "Acme's own instructions",
    ]) {
      expect(text).not.toContain(hidden);
    }
    expect(capabilityNames(card)).not.toContain("tool:book_appointment");
  });
});

describe("formatCardLine", () => {
  it("is one line naming what the agent accepts and hands off, at most 160 characters", () => {
    const line = formatCardLine(agentCard(manifest, resolve()));
    expect(line).not.toContain("\n");
    expect(line.length).toBeLessThanOrEqual(160);
    expect(line).toContain("Sample Desk (front-office)");
    expect(line).toContain("accepts booking.request");
  });

  it("truncates a line that would run past the limit", () => {
    const long = agentCard(manifest, resolve());
    const card: AgentCard = {
      ...long,
      accepts: Array.from({ length: 40 }, (_, i) => ({
        type: `sample.type${i}`,
        description: "A long-winded description of a ticket type",
      })),
    };
    const line = formatCardLine(card);
    expect(line.length).toBeLessThanOrEqual(160);
    expect(line.endsWith("…")).toBe(true);
  });
});

describe("formatCard", () => {
  it("renders compact Markdown an agent_card tool can return", () => {
    const markdown = formatCard(agentCard(manifest, resolve()));
    expect(markdown).toMatch(/^# Sample Desk/);
    for (const heading of ["## Accepts", "## Hands off", "## Capabilities", "## You may not"]) {
      expect(markdown).toContain(heading);
    }
    expect(markdown).toContain("- booking.request: Book an appointment for a customer");
    expect(markdown).toContain("- book_appointment (changes; needs approval:");
  });
});
