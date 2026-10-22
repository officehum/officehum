import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentManifest,
  checkFourLayers,
  validateManifest,
  validatePackage,
} from "@officehum/sdk";
import { afterEach, describe, expect, it } from "vitest";
import manifest from "../officehum.json" with { type: "json" };

const temps: string[] = [];
afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
/** The JSON import's inferred type is widened; the checks want the SDK's manifest type. */
const roleManifest = manifest as unknown as AgentManifest;

/**
 * The brief's situations: the five routing requests (three in one triage note, two in another), the
 * missing detail, the blocked items and the items waiting on a person in a digest, and the forwarded
 * instruction. The role declares no tools, so a scenario stubs nothing and asserts on the reply.
 */
const SCENARIOS = [
  "triage-routes-three-requests",
  "triage-routes-two-more-requests",
  "triage-asks-for-the-missing-detail",
  "digest-lists-every-blocked-item",
  "digest-lists-every-item-waiting-on-a-person",
  "forwarded-approval-instruction-approves-nothing",
];

const tempCopy = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "officehum-office-manager-"));
  temps.push(directory);
  cpSync(packageDirectory, directory, { recursive: true });
  return directory;
};

describe("office manager package (RASF-3131)", () => {
  it("validates strictly as a package under agents/, with the brief's four situations", async () => {
    const validated = await validatePackage(packageDirectory);
    expect(validated.issues).toEqual([]);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    expect(validated.value.piDurableRange).toBe("1.3.x");
    expect(Object.keys(validated.value.suites)).toEqual(["evals/situations.json"]);
    const suites = Object.values(validated.value.suites);
    expect(suites.flatMap((suite) => suite.scenarios.map((scenario) => scenario.id))).toEqual(
      SCENARIOS,
    );

    // The suite validator already requires every declared tool to be stubbed; with no tools the rule
    // holds over an empty stub set, so restate it here to catch a manifest that grows a tool later.
    for (const suite of suites) {
      for (const scenario of suite.scenarios) expect(scenario.stubs).toEqual({});
    }
  });

  it("declares no tools, no approvals and completion evidence on both accepted types", () => {
    expect(validateManifest(roleManifest).ok).toBe(true);
    expect(roleManifest.id).toBe("office-manager");
    expect(roleManifest.department).toBe("operations");
    expect(roleManifest.tools).toEqual([]);
    expect(roleManifest.approvals).toEqual([]);
    expect(roleManifest.connectors).toEqual([]);
    expect(roleManifest.channels).toEqual(["chat"]);
    expect(roleManifest.skills.map((skill) => skill.id)).toEqual(["triage", "daily-digest"]);
    expect(roleManifest.skills.every((skill) => skill.enabledByDefault)).toBe(true);

    // Both accepted types, with the only evidence this role can honestly offer: nothing runs a tool,
    // so the host has no safe tool to look up, and a person confirms the note or the digest.
    // The brief names the first type `triage`; the SDK's ticket types must be dotted (like every
    // other role's), so it is spelled `triage.request` here. Reported as a divergence on RASF-3131.
    expect(roleManifest.accepts.map((accept) => accept.type)).toEqual([
      "triage.request",
      "digest.request",
    ]);
    for (const accept of roleManifest.accepts) {
      expect(accept.done).toEqual([{ person: true }]);
    }
    // A role accepts a type or hands it off, never both; this one hands nothing off.
    expect(roleManifest.dispatches ?? []).toEqual([]);
  });

  it('refuses a money amount, a missing "You may not" and a type with no evidence, on a copy', () => {
    const copy = tempCopy();
    const copiedAgents = join(copy, "AGENTS.md");
    const body = readFileSync(copiedAgents, "utf8");

    writeFileSync(copiedAgents, `${body}\n\nAn invoice over $500 waits for a person.\n`);
    const money = checkFourLayers(copy, roleManifest, { strict: true });
    expect(
      money.some(
        (issue) => issue.layer === "context" && issue.message.includes("money amount") === true,
      ),
    ).toBe(true);

    writeFileSync(copiedAgents, body.replace("## You may not", "## Notes"));
    const heading = checkFourLayers(copy, roleManifest, { strict: true });
    expect(
      heading.some(
        (issue) => issue.layer === "context" && issue.message.includes('no "You may not"') === true,
      ),
    ).toBe(true);

    // Strip an accepted type's evidence: a ticket nobody can prove finished is a workflow error.
    const stripped: AgentManifest = {
      ...roleManifest,
      accepts: roleManifest.accepts.map((accept) => ({
        type: accept.type,
        description: accept.description,
      })),
    };
    const evidence = checkFourLayers(copy, stripped, { strict: true });
    expect(
      evidence.some(
        (issue) => issue.layer === "workflow" && issue.message.includes("is required for") === true,
      ),
    ).toBe(true);

    // Restoring the body leaves the copy clean again, and the damage never reached the package itself:
    // every check above ran against the copy.
    writeFileSync(copiedAgents, body);
    expect(checkFourLayers(copy, roleManifest, { strict: true })).toEqual([]);
    const realAgents = existsSync(join(packageDirectory, "AGENTS.md"))
      ? readFileSync(join(packageDirectory, "AGENTS.md"), "utf8")
      : undefined;
    expect(realAgents).toBe(body);
  });
});
