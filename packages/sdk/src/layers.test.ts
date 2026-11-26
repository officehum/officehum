import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { formatIssue, type Issue } from "./issues.js";
import { checkFourLayers } from "./layers.js";
import { type AgentManifest, validateManifest } from "./manifest.js";

const sampleDesk = fileURLToPath(new URL("../fixtures/sample-desk", import.meta.url));
const sampleStockroom = fileURLToPath(new URL("../fixtures/sample-stockroom", import.meta.url));
const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A copy of a fixture package, with the given files replaced. */
async function packageWith(fixture: string, files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "officehum-layers-"));
  temps.push(dir);
  await cp(fixture, dir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) await writeFile(join(dir, name), contents);
  return dir;
}

const readManifest = async (fixture: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(fixture, "officehum.json"), "utf8")) as Record<string, unknown>;

/** Validated, so a mutation that makes the manifest invalid fails loudly rather than quietly. */
function manifestOf(value: Record<string, unknown>): AgentManifest {
  const checked = validateManifest(value);
  if (!checked.ok) throw new Error(checked.issues.map(formatIssue).join("\n"));
  return checked.value;
}

const withTool = (manifest: Record<string, unknown>, tool: Record<string, unknown>) => ({
  ...manifest,
  tools: [...(manifest.tools as unknown[]), tool],
});

const issuesFor = (dir: string, manifest: AgentManifest, strict = false): readonly Issue[] =>
  checkFourLayers(dir, manifest, { strict });

const lines = (issues: readonly Issue[]): string[] => issues.map(formatIssue);

/** AGENTS.md text of exactly `words` words, with a "You may not" section and no numbers in it. */
function agentsWithWords(words: number): string {
  const head = "# Desk\n\n## You may not\n\nNothing is approved by default.";
  const filler = Array.from({ length: words - head.split(/\s+/).length }, (_, i) => `word${i}`);
  return `${head}\n\n${filler.join(" ")}\n`;
}

describe("checkFourLayers", () => {
  it("accepts both fixture packages in strict mode", async () => {
    for (const fixture of [sampleDesk, sampleStockroom]) {
      const manifest = manifestOf(await readManifest(fixture));
      expect(lines(issuesFor(fixture, manifest, true))).toEqual([]);
    }
  });

  it("reports an AGENTS.md over the word budget, with its layer and where the detail belongs", async () => {
    const manifest = manifestOf(await readManifest(sampleDesk));
    const dir = await packageWith(sampleDesk, { "AGENTS.md": agentsWithWords(1200) });
    const [issue, ...rest] = issuesFor(dir, manifest);
    expect(rest).toEqual([]);
    expect(issue?.layer).toBe("context");
    expect(formatIssue(issue as Issue)).toBe(
      "AGENTS.md: warning: is 1200 words; keep AGENTS.md under 1000 words and move the detail into a skill or one of its reference files",
    );
  });

  it("starts warning above 800 words", async () => {
    const manifest = manifestOf(await readManifest(sampleDesk));
    const dir = await packageWith(sampleDesk, { "AGENTS.md": agentsWithWords(900) });
    expect(lines(issuesFor(dir, manifest))).toEqual([
      "AGENTS.md: warning: is 900 words; AGENTS.md reads best under 800, so move the detail into a skill or one of its reference files",
    ]);
  });

  it("reports a money amount in context and says where the number belongs", async () => {
    const manifest = manifestOf(await readManifest(sampleDesk));
    const dir = await packageWith(sampleDesk, {
      "AGENTS.md":
        "# Desk\n\n## You may not\n\nBook nothing without a person.\n\nInvoices over $2,500 wait for a person.\n",
    });
    expect(lines(issuesFor(dir, manifest))).toEqual([
      'AGENTS.md: warning: states "$2,500" (a money amount); a number belongs in an approval "when", an overlay limit, or a skill reference, never in the context the model reads every turn',
    ]);
  });

  it("reports threshold wording in APPEND_SYSTEM.md too", async () => {
    const manifest = manifestOf(await readManifest(sampleDesk));
    const dir = await packageWith(sampleDesk, {
      "APPEND_SYSTEM.md": "Escalate anything beyond 50 percent.\n",
    });
    expect(lines(issuesFor(dir, manifest))).toEqual([
      'APPEND_SYSTEM.md: warning: states "50 percent" (a percentage); a number belongs in an approval "when", an overlay limit, or a skill reference, never in the context the model reads every turn',
    ]);
  });

  it("requires a You may not section in AGENTS.md", async () => {
    const manifest = manifestOf(await readManifest(sampleDesk));
    const dir = await packageWith(sampleDesk, {
      "AGENTS.md": "# Desk\n\nYou book appointments.\n",
    });
    const [issue, ...rest] = issuesFor(dir, manifest);
    expect(rest).toEqual([]);
    expect(issue?.layer).toBe("context");
    expect(formatIssue(issue as Issue)).toBe(
      'AGENTS.md: warning: has no "You may not" section; add a heading like "## You may not" saying what this role never does',
    );
  });

  it("reports a reference file outside a skill's references/ folder", async () => {
    const manifest = manifestOf(await readManifest(sampleDesk));
    const dir = await packageWith(sampleDesk, { "skills/rescheduling/notice.md": "Two days.\n" });
    expect(lines(issuesFor(dir, manifest))).toEqual([
      "skills/rescheduling/notice.md: warning: is outside references/; move it to skills/rescheduling/references/ so the agent loads it with read_skill",
    ]);
  });

  it("reports a data, work or deliverables folder in the package", async () => {
    const manifest = manifestOf(await readManifest(sampleDesk));
    const dir = await packageWith(sampleDesk);
    await mkdir(join(dir, "work"));
    expect(lines(issuesFor(dir, manifest))).toEqual([
      "work: warning: is not a role file; a package holds instructions and references, and the engine reads the host's OFFICEHUM_DATA_DIR and OFFICEHUM_WORK_DIR at run time",
    ]);
  });

  it("rejects a role that registers Pi Durable's bash tool", async () => {
    const manifest = manifestOf(
      withTool(await readManifest(sampleDesk), {
        name: "bash",
        replay: "unsafe",
        noApproval: "internal note; no outside effect",
      }),
    );
    const [issue, ...rest] = issuesFor(sampleDesk, manifest);
    expect(rest).toEqual([]);
    expect(issue).toMatchObject({ layer: "wisdom", severity: "error" });
    expect(formatIssue(issue as Issue)).toBe(
      'officehum.json › tools[2].name: "bash" is a generic shell tool; a role registers no shell or file tool, so work through the role\'s declared tools (read_skill reads its references)',
    );
  });

  it("requires completion evidence on every accepted ticket type", async () => {
    const json = await readManifest(sampleDesk);
    const accepts = json.accepts as { done?: unknown }[];
    for (const accept of accepts) delete accept.done;
    const manifest = manifestOf(json);
    expect(lines(issuesFor(sampleDesk, manifest))).toEqual([
      'officehum.json › accepts[0].done: warning: is required for "booking.request": a ticket is done only when its evidence checks out — an engine check, a safe tool with expect "found", a file, or { "person": true }',
    ]);
  });

  it("warns outside agents/ and errors under strict, while wisdom is always an error", async () => {
    const manifest = manifestOf(await readManifest(sampleDesk));
    const dir = await packageWith(sampleDesk, {
      "AGENTS.md": "# Desk\n\nYou book appointments.\n",
    });

    const [warning] = issuesFor(dir, manifest);
    expect(warning).toMatchObject({ layer: "context", severity: "warning" });

    const [error] = issuesFor(dir, manifest, true);
    expect(error).toMatchObject({ layer: "context", severity: "error" });
    expect(formatIssue(error as Issue)).not.toContain("warning");

    const bash = manifestOf(
      withTool(await readManifest(sampleDesk), {
        name: "bash",
        replay: "unsafe",
        noApproval: "internal note; no outside effect",
      }),
    );
    expect(issuesFor(sampleDesk, bash)[0]).toMatchObject({ layer: "wisdom", severity: "error" });
    expect(issuesFor(sampleDesk, bash, true)[0]).toMatchObject({
      layer: "wisdom",
      severity: "error",
    });
  });
});
