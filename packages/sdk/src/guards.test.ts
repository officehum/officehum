import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type GuardChange, guardChanges, loweredGuards } from "./guards.js";
import { formatIssue } from "./issues.js";
import { type AgentManifest, limitDirection } from "./manifest.js";
import { type ResolvedRole, resolveRoleFiles } from "./resources.js";
import { removeTempDirs, SAMPLE_DIR, STOCKROOM_DIR, tempDir } from "./test-helpers.js";

afterEach(removeTempDirs);

const read = (dir: string) =>
  JSON.parse(readFileSync(join(dir, "officehum.json"), "utf8")) as AgentManifest;
const desk = read(SAMPLE_DIR);
const stockroom = read(STOCKROOM_DIR);

function resolved(manifest: AgentManifest, packageDir: string, overlays: string[]): ResolvedRole {
  const result = resolveRoleFiles({ packageDir, manifest, overlays });
  if (!result.ok) throw new Error(result.issues.map(formatIssue).join("\n"));
  return result.value;
}

/** An overlay holding only `settings.json`, or nothing at all. */
const settings = (value?: object) =>
  tempDir("acme", value === undefined ? {} : { "settings.json": JSON.stringify(value) });

/** The guard changes from a current overlay to a candidate one, against the package's defaults. */
function changes(
  manifest: AgentManifest,
  packageDir: string,
  current: string[],
  candidate: string[],
): GuardChange[] {
  return guardChanges(manifest, {
    defaults: resolved(manifest, packageDir, []),
    current: resolved(manifest, packageDir, current),
    candidate: resolved(manifest, packageDir, candidate),
  });
}

const effects = (found: readonly GuardChange[]) => found.map(({ id, effect }) => `${id}:${effect}`);

describe("limitDirection", () => {
  it("reads a compared limit's direction from the approvals that compare with it", () => {
    expect(limitDirection(stockroom, "large_increase")).toBe("ceiling");
    expect(limitDirection(stockroom, "large_decrease")).toBe("floor");
  });

  it("takes a code-only limit's declared guard, and treats an undeclared one as both ways", () => {
    const limits = (guard?: "ceiling" | "floor" | "none") => ({
      ...desk,
      limits: {
        reminder_days: {
          description: "Days before a reminder",
          default: 7,
          ...(guard === undefined ? {} : { guard }),
        },
      },
    });
    expect(limitDirection(limits("floor"), "reminder_days")).toBe("floor");
    expect(limitDirection(limits("none"), "reminder_days")).toBe("none");
    expect(limitDirection(limits(), "reminder_days")).toBe("both");
  });
});

describe("guardChanges", () => {
  it("finds nothing when no guard moves", () => {
    expect(changes(stockroom, STOCKROOM_DIR, [], [])).toEqual([]);
    expect(changes(desk, SAMPLE_DIR, [], [tempDir("acme", { "AGENTS.md": "Be kind." })])).toEqual(
      [],
    );
  });

  it("calls raising a ceiling past its default a lowering, and names it with its figures", () => {
    expect(
      changes(stockroom, STOCKROOM_DIR, [], [settings({ limits: { large_increase: 2500 } })]),
    ).toEqual([
      {
        id: "limit.large_increase",
        kind: "limit",
        name: "large_increase",
        effect: "lowers",
        from: 10,
        to: 2500,
        default: 10,
        sentence:
          'Raise "Units a single adjustment may add before a person approves it" from 10 to 2,500; the role ships with 10.',
      },
    ]);
  });

  it("calls lowering a floor past its default a lowering", () => {
    const [change] = changes(
      stockroom,
      STOCKROOM_DIR,
      [],
      [settings({ limits: { large_decrease: -50 } })],
    );
    expect(change?.effect).toBe("lowers");
    expect(change?.sentence).toBe(
      'Lower "Units a single adjustment may remove before a person approves it (a negative quantity)" from -10 to -50; the role ships with -10.',
    );
  });

  it("tells lowering, loosening, tightening and restoring apart", () => {
    const at = (value: number) => settings({ limits: { large_increase: value } });
    // Further below the default than now: needs an acknowledgement.
    expect(effects(changes(stockroom, STOCKROOM_DIR, [at(20)], [at(30)]))).toEqual([
      "limit.large_increase:lowers",
    ]);
    // Eased, but still tighter than the role ships it.
    expect(effects(changes(stockroom, STOCKROOM_DIR, [at(5)], [at(8)]))).toEqual([
      "limit.large_increase:loosens",
    ]);
    // Still lowered, only less: tighter than now.
    expect(effects(changes(stockroom, STOCKROOM_DIR, [at(30)], [at(20)]))).toEqual([
      "limit.large_increase:tightens",
    ]);
    // Back at the default, from either side.
    expect(effects(changes(stockroom, STOCKROOM_DIR, [at(30)], [at(10)]))).toEqual([
      "limit.large_increase:restores",
    ]);
    expect(effects(changes(stockroom, STOCKROOM_DIR, [at(5)], [settings()]))).toEqual([
      "limit.large_increase:restores",
    ]);
  });

  it("calls any change to a limit of unknown direction a lowering, and ignores one that guards nothing", () => {
    const withLimits: AgentManifest = {
      ...desk,
      limits: {
        reminder_days: { description: "Days before a reminder", default: 7 },
        report_hour: { description: "Hour of the daily report", default: 9, guard: "none" },
      },
    };
    const found = changes(
      withLimits,
      SAMPLE_DIR,
      [],
      [settings({ limits: { reminder_days: 3, report_hour: 17 } })],
    );
    expect(effects(found)).toEqual(["limit.reminder_days:lowers"]);
    expect(found[0]?.sentence).toBe(
      'Lower "Days before a reminder" from 7 to 3; the role ships with 7. Office Hum cannot tell which way is safer for this limit, so it treats any change as lowering a safeguard.',
    );
  });

  it("calls switching an approval off a lowering, and switching it back on a restore", () => {
    const off = settings({ approvals: ["-book_after_hours"] });
    expect(changes(desk, SAMPLE_DIR, [], [off])).toEqual([
      {
        id: "approval.book_after_hours",
        kind: "approval",
        name: "book_after_hours",
        effect: "lowers",
        from: true,
        to: false,
        default: true,
        sentence:
          "Stop asking a person before: Bookings that start at 18:00 or later. Sample Desk will do this on its own.",
      },
    ]);
    const [back] = changes(desk, SAMPLE_DIR, [off], [settings()]);
    expect(back?.effect).toBe("restores");
    expect(back?.sentence).toBe(
      "Ask a person again before: Bookings that start at 18:00 or later.",
    );
  });

  it("calls a writing tool switched on that the role ships off a lowering, and not a reading one", () => {
    // The rescheduling skill ships off here, and it brings one tool that writes and one that reads.
    const withSkillTools: AgentManifest = {
      ...desk,
      tools: [
        ...desk.tools,
        { name: "move_appointment", replay: "unsafe", skill: "rescheduling", noApproval: "test" },
        { name: "list_moves", replay: "safe", skill: "rescheduling" },
      ],
      skills: [{ id: "rescheduling", enabledByDefault: false }],
    };
    const found = changes(
      withSkillTools,
      SAMPLE_DIR,
      [],
      [settings({ skills: ["+rescheduling"] })],
    );
    expect(found).toEqual([
      {
        id: "tool.move_appointment",
        kind: "tool",
        name: "move_appointment",
        effect: "lowers",
        from: false,
        to: true,
        default: false,
        sentence:
          "Switch on move_appointment, which Sample Desk ships switched off. It changes things, and no approval covers it.",
      },
    ]);
  });

  it("names the approval that still covers a tool switched on", () => {
    const covered: AgentManifest = {
      ...desk,
      tools: desk.tools.map((tool) =>
        tool.name === "book_appointment" ? { ...tool, skill: "rescheduling" } : tool,
      ),
      skills: [{ id: "rescheduling", enabledByDefault: false }],
    };
    const [change] = changes(covered, SAMPLE_DIR, [], [settings({ skills: ["+rescheduling"] })]);
    expect(change?.sentence).toBe(
      'Switch on book_appointment, which Sample Desk ships switched off. It changes things, and its approval "Bookings that start at 18:00 or later" still applies.',
    );
  });

  it("calls switching a tool off a tightening, and back on to its default a restore", () => {
    const off = settings({ tools: ["-book_appointment"] });
    expect(effects(changes(desk, SAMPLE_DIR, [], [off]))).toEqual([
      "tool.book_appointment:tightens",
    ]);
    expect(effects(changes(desk, SAMPLE_DIR, [off], [settings()]))).toEqual([
      "tool.book_appointment:restores",
    ]);
  });

  it("calls replacing the role's own instructions a lowering", () => {
    const override = tempDir("acme", { "AGENTS.override.md": "You are Acme's receptionist." });
    expect(changes(desk, SAMPLE_DIR, [], [override])).toEqual([
      {
        id: "instructions.agents",
        kind: "instructions",
        name: "AGENTS.md",
        effect: "lowers",
        from: false,
        to: true,
        default: false,
        sentence:
          "Replace Sample Desk's own instructions, including what it says it must never do, with yours. Its approvals and limits still apply.",
      },
    ]);
    const closing = tempDir("acme", { "APPEND_SYSTEM.md": "Sign off as Acme." });
    const [change] = changes(desk, SAMPLE_DIR, [], [closing]);
    expect(change?.id).toBe("instructions.append_system");
    expect(change?.sentence).toBe(
      "Replace the closing instructions Sample Desk ships with. Its approvals and limits still apply.",
    );
  });

  it("lists every change in a stable order", () => {
    const found = changes(
      stockroom,
      STOCKROOM_DIR,
      [],
      [settings({ approvals: ["-large_increase"], limits: { large_decrease: -40 } })],
    );
    expect(effects(found)).toEqual([
      "approval.large_increase:lowers",
      "limit.large_decrease:lowers",
    ]);
  });
});

describe("loweredGuards", () => {
  it("lists nothing for a role with no overlay", () => {
    const defaults = resolved(stockroom, STOCKROOM_DIR, []);
    expect(loweredGuards(stockroom, defaults, defaults)).toEqual([]);
  });

  it("lists every guard below its default, and not one that is tighter", () => {
    const defaults = resolved(stockroom, STOCKROOM_DIR, []);
    const now = resolved(stockroom, STOCKROOM_DIR, [
      settings({ approvals: ["-large_decrease"], limits: { large_increase: 50 } }),
    ]);
    expect(loweredGuards(stockroom, defaults, now)).toEqual([
      {
        id: "approval.large_decrease",
        kind: "approval",
        name: "large_decrease",
        value: false,
        default: true,
        sentence:
          "Sample Stockroom does not ask a person before: Removing more units than the business allows without approval.",
      },
      {
        id: "limit.large_increase",
        kind: "limit",
        name: "large_increase",
        value: 50,
        default: 10,
        sentence:
          '"Units a single adjustment may add before a person approves it" is 50; the role ships with 10.',
      },
    ]);
    const tighter = resolved(stockroom, STOCKROOM_DIR, [
      settings({ limits: { large_increase: 5 } }),
    ]);
    expect(loweredGuards(stockroom, defaults, tighter)).toEqual([]);
  });
});
