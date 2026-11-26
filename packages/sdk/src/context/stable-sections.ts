/**
 * The stable-section check. A provider's prompt cache holds only while the start of the prompt is
 * byte-identical from request to request, so a role's sections must not change between renders: no
 * time, no counters, no random ids. The role extension's sections are rendered twice, under two fake
 * clocks and two random seeds, and any section that differs is reported. The `today` section is
 * the one that is meant to change; it must come after every stable section.
 *
 * Host sections that change per ticket (memory, focus) belong to the host's own extension, which a
 * host selects after the role's, so they render after the role's stable prefix.
 *
 * Neither Pi Durable's `PromptSection.render` nor a section built with `section()` takes a clock or
 * a random source, so the only way to vary them is the global `Date` and `Math.random`. The patch
 * covers one synchronous call to `render` and is undone in a `finally` before anything else can run:
 * with no `await` inside the window, no timer, task or harness in the same process can see the fake
 * clock. A section whose render returns a promise cannot be checked this way and is reported.
 * `checkAgent` runs in live processes (the office's `loadRole`), so this matters.
 */

import type { Extension } from "@earendil-works/pi-durable";
import { TODAY_SECTION_KEY } from "../today.js";

/** Sections of a role extension that are meant to change between requests. */
export const DYNAMIC_ROLE_SECTIONS: readonly string[] = [TODAY_SECTION_KEY];

const CLOCKS = [Date.UTC(2001, 1, 3, 4, 5, 6), Date.UTC(2033, 6, 8, 9, 10, 11)] as const;
const SEEDS = [1, 7919] as const;

/** A small deterministic generator (mulberry32), so each render's "random" numbers are fixed. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** What one synchronous render under a fixed clock gave: its text, or that it was async. */
type Rendered = { readonly text: string | undefined } | "async";

/**
 * Calls `promptSection.render` once with `Date` fixed at `clock` and `Math.random` seeded. Strictly
 * synchronous: the globals are restored before this returns, so a returned promise finishes, if at
 * all, under the real clock, and its result is not used.
 */
function renderUnderClock(
  promptSection: NonNullable<Extension["sections"]>[number],
  clock: number,
  seed: number,
): Rendered {
  const RealDate = globalThis.Date;
  const realRandom = Math.random;
  class FakeDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(clock);
      else super(...(args as [string | number | Date]));
    }
    static override now(): number {
      return clock;
    }
  }
  let rendered: unknown;
  globalThis.Date = FakeDate as DateConstructor;
  Math.random = seeded(seed);
  try {
    rendered = promptSection.render({} as never, {} as never);
  } finally {
    globalThis.Date = RealDate;
    Math.random = realRandom;
  }
  if (
    rendered !== null &&
    typeof (rendered as { then?: unknown } | undefined)?.then === "function"
  ) {
    // Its outcome is not ours to report; keep a rejection from becoming an unhandled one.
    (rendered as Promise<unknown>).then(
      () => undefined,
      () => undefined,
    );
    return "async";
  }
  return { text: typeof rendered === "string" ? rendered : undefined };
}

/** One problem with a role's sections: which section, and what is wrong. */
export interface SectionProblem {
  readonly key: string;
  readonly message: string;
}

/** The role extension's sections that change between renders, or sit after the dynamic ones. */
export function stableSectionProblems(extension: Extension): SectionProblem[] {
  const problems: SectionProblem[] = [];
  const sections = extension.sections ?? [];
  const keys = sections.map((promptSection) => promptSection.key);
  const firstDynamic = keys.findIndex((key) => DYNAMIC_ROLE_SECTIONS.includes(key));
  if (firstDynamic !== -1) {
    for (const key of keys.slice(firstDynamic + 1)) {
      if (DYNAMIC_ROLE_SECTIONS.includes(key)) continue;
      problems.push({
        key,
        message: `comes after the ${show(keys[firstDynamic])} section, which changes every day; register stable sections first so the prompt's start stays cacheable`,
      });
    }
  }

  for (const promptSection of sections) {
    const key = promptSection.key;
    if (DYNAMIC_ROLE_SECTIONS.includes(key)) continue;
    const first = renderUnderClock(promptSection, CLOCKS[0], SEEDS[0]);
    if (first === "async") {
      problems.push({
        key,
        message:
          "renders asynchronously, so the check cannot hold its clock fixed; render it synchronously from data the role already has, or move it to the host's extension",
      });
      continue;
    }
    const second = renderUnderClock(promptSection, CLOCKS[1], SEEDS[1]);
    const a = first.text;
    const b = second === "async" ? undefined : second.text;
    if (a === b) continue;
    const years = [new Date(CLOCKS[0]).getUTCFullYear(), new Date(CLOCKS[1]).getUTCFullYear()];
    // Both fake clocks fall in years no real text mentions, so finding one names the cause.
    const cause = years.some((year) => `${a ?? ""}${b ?? ""}`.includes(String(year)))
      ? "it includes the time"
      : "it includes something that changes between renders, such as a counter or a random value";
    problems.push({
      key,
      message: `is not stable: ${cause}. Unstable text breaks the provider's prompt cache on every turn; move it into a section registered after the stable ones, or into a tool result`,
    });
  }
  return problems;
}

function show(value: string | undefined): string {
  return JSON.stringify(value ?? "");
}
