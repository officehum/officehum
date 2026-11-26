import { type PromptSection, section } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import sampleManifest from "../../fixtures/sample-desk/officehum.json" with { type: "json" };
import sampleDesk from "../../fixtures/sample-desk/src/index.js";
import { checkAgent, type RoleBundle } from "../agent.js";
import { formatIssue } from "../issues.js";
import type { AgentManifest } from "../manifest.js";

const calendar = { freeSlots: async () => [], book: async () => ({ id: "A1" }) };
const manifest = sampleManifest as AgentManifest;

/** The sample desk's bundle with its role extension's sections replaced by `sections(current)`. */
function withSections(
  sections: (current: readonly PromptSection[]) => PromptSection[],
  now?: () => Date,
): RoleBundle {
  const bundle = sampleDesk({ calendar, ...(now === undefined ? {} : { now }) });
  const [role, ...rest] = bundle.extensions;
  if (role === undefined) throw new Error("no role extension");
  return {
    extensions: [{ ...role, sections: sections(role.sections ?? []) }, ...rest],
    agent: bundle.agent,
  };
}

async function sectionIssues(bundle: RoleBundle): Promise<string[]> {
  return (await checkAgent(bundle, manifest)).issues
    .map(formatIssue)
    .filter((line) => line.includes("› sections ›"));
}

describe("the stable-section check in checkAgent", () => {
  it("passes the sample desk, whose today section is meant to change and comes last", async () => {
    const bundle = sampleDesk({ calendar, now: () => new Date() });
    expect((await checkAgent(bundle, manifest)).issues).toEqual([]);
  });

  it("reports a section that includes the time", async () => {
    const bundle = withSections((current) => [
      ...current.map((candidate) =>
        candidate.key === "skills"
          ? section(
              "skills",
              () =>
                `${String(candidate.render({} as never, {} as never))}\nAs of ${new Date().toISOString()}`,
            )
          : candidate,
      ),
    ]);
    expect(await sectionIssues(bundle)).toEqual([
      "role › sample-desk › sections › skills: is not stable: it includes the time. Unstable text breaks the provider's prompt cache on every turn; move it into a section registered after the stable ones, or into a tool result",
    ]);
    expect((await checkAgent(bundle, manifest)).ok).toBe(false);
  });

  it("reports a section with a random value or a counter", async () => {
    let count = 0;
    const bundle = withSections((current) => [
      ...current,
      section("nonce", () => `request ${Math.random().toString(36).slice(2)}`),
      section("counter", () => `turn ${++count}`),
    ]);
    expect(await sectionIssues(bundle)).toEqual([
      "role › sample-desk › sections › nonce: is not stable: it includes something that changes between renders, such as a counter or a random value. Unstable text breaks the provider's prompt cache on every turn; move it into a section registered after the stable ones, or into a tool result",
      "role › sample-desk › sections › counter: is not stable: it includes something that changes between renders, such as a counter or a random value. Unstable text breaks the provider's prompt cache on every turn; move it into a section registered after the stable ones, or into a tool result",
    ]);
  });

  it("reports a stable section placed after the today section", async () => {
    const bundle = withSections(
      (current) => {
        const today = current.filter((candidate) => candidate.key === "today");
        const stable = current.filter((candidate) => candidate.key !== "today");
        return [...today, ...stable];
      },
      () => new Date(),
    );
    expect(await sectionIssues(bundle)).toEqual([
      'role › sample-desk › sections › agents_md: comes after the "today" section, which changes every day; register stable sections first so the prompt\'s start stays cacheable',
      'role › sample-desk › sections › skills: comes after the "today" section, which changes every day; register stable sections first so the prompt\'s start stays cacheable',
      'role › sample-desk › sections › append_system: comes after the "today" section, which changes every day; register stable sections first so the prompt\'s start stays cacheable',
    ]);
  });

  it("lets no other code see the fake clock, and reports an async section it cannot check", async () => {
    // A concurrent task and a timer, both started before the check, sample the clock throughout.
    const seen: number[] = [];
    let running = true;
    const watcher = (async () => {
      while (running) {
        seen.push(new Date().getUTCFullYear(), new Date(Date.now()).getUTCFullYear());
        await Promise.resolve();
      }
    })();
    const timer = new Promise<void>((resolve) =>
      setTimeout(() => {
        seen.push(new Date().getUTCFullYear());
        resolve();
      }, 0),
    );
    // An async section reads the clock after an await, when other code could run.
    const sectionSaw: number[] = [];
    const bundle = withSections((current) => [
      ...current,
      section("lookup", async () => {
        await Promise.resolve();
        sectionSaw.push(new Date().getUTCFullYear());
        return "Looked up.";
      }),
    ]);
    const issues = await sectionIssues(bundle);
    running = false;
    await watcher;
    await timer;

    expect(seen.length).toBeGreaterThan(2);
    expect(seen.filter((year) => year < 2026)).toEqual([]);
    expect(sectionSaw.filter((year) => year < 2026)).toEqual([]);
    expect(issues).toEqual([
      "role › sample-desk › sections › lookup: renders asynchronously, so the check cannot hold its clock fixed; render it synchronously from data the role already has, or move it to the host's extension",
    ]);
  });

  it("restores the real clock and random after rendering", async () => {
    await checkAgent(
      withSections((current) => [...current]),
      manifest,
    );
    expect(new Date().getUTCFullYear()).toBeGreaterThanOrEqual(2026);
    expect(Math.random()).not.toBe(Math.random());
  });
});
