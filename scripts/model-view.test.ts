/**
 * What every catalog role shows a model on the default company, pinned byte for byte.
 *
 * The company-record work changes how a role finds its people and its data, and must change nothing
 * a model reads while the role runs on the default company (demos and every eval do). So each role
 * is built as a demonstration host builds it (`demo: true`, a fixed clock) and this file writes down,
 * per role, in one text file under `__model-view__/`:
 *
 * - every prompt section of every extension, rendered;
 * - every tool's name, description and parameter schema;
 * - every tool's result for an empty call, every `read_company` section, and a few calls that go
 *   through the company's own data (the price book, the claims check, the crews, the incident types).
 *
 * A role that declares tools from the data pack is given it, as an office that gives the
 * pack builds it (here with no file store), so its pin shows the pack's tools as a model sees them.
 *
 * Each call runs on a freshly built role, so one call's writes never reach another's result. A call
 * that throws is written down as the error's message, which is what the model would be told.
 *
 * The snapshots were recorded on `main` before the company-record changes, as their own commit; a
 * change that alters any byte here alters what a model sees. Update them (`npx vitest run
 * scripts/model-view.test.ts -u`) only for a change that is meant to.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import { dataPack } from "../packages/tools-data/src/pack.ts";
import { freeCatalogRole } from "./company.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** The demonstration clock every role is built with: Monday 9 November 2026, morning on the west coast. */
const NOW = new Date("2026-11-09T16:00:00.000Z");

interface Tool {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: unknown;
  execute(args: unknown, call: unknown, context: unknown): Promise<unknown>;
}

interface Section {
  readonly key: string;
  render(a: unknown, b: unknown): unknown;
}

interface Bundle {
  readonly extensions: readonly {
    readonly name: string;
    readonly tools?: readonly Tool[];
    readonly sections?: readonly Section[];
  }[];
}

/** Calls through the company's own data, by role: each one a path the company-record work touches. */
const CALLS: Readonly<Record<string, readonly { tool: string; args: unknown }[]>> = {
  sales: [
    { tool: "search_price_book", args: { query: "deep clean for a dentist" } },
    { tool: "search_price_book", args: { query: "helicopter" } },
    {
      tool: "create_quote",
      args: {
        leadId: "L-204",
        lines: [
          { priceBookItemId: "clean-deep-sqft", quantity: 3200 },
          { priceBookItemId: "restroom-sanitise", quantity: 4 },
        ],
        notes: "First deep clean before the chairs go in.",
      },
    },
  ],
  marketing: [
    {
      tool: "draft_post",
      args: { channel: "facebook", text: "Day porters on site during business hours." },
    },
    {
      tool: "draft_post",
      args: {
        channel: "linkedin",
        text: "Our products are non-toxic and lab-tested, from $0.18 a square foot.",
      },
    },
  ],
  operations: [
    { tool: "request_overtime", args: { crewId: "cleaning-central", jobId: "J-2101", hours: 7 } },
  ],
  safety: [
    {
      tool: "log_incident",
      args: { type: "near-miss", crewId: "cleaning-north", summary: "Wet floor, no sign." },
    },
    { tool: "clearance_check", args: { personId: "sam-oduya", task: "ladder work" } },
  ],
  "people-ops": [{ tool: "list_availability", args: { crewId: "cleaning-south" } }],
  payroll: [{ tool: "get_benefits_summary", args: { personId: "jules-okafor" } }],
};

/** The catalog roles, as `npm run sync-company` finds them. */
function catalogRoles(): string[] {
  return readdirSync(join(ROOT, "agents"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && freeCatalogRole(join(ROOT, "agents", entry.name)))
    .map((entry) => entry.name)
    .filter((name) => {
      try {
        return readdirSync(join(ROOT, "agents", name, "src")).includes("index.ts");
      } catch {
        return false;
      }
    })
    .sort();
}

/** The data pack, for a role whose manifest declares its tools; none for any other role. */
function packsFor(role: string): unknown[] {
  const manifest = JSON.parse(
    readFileSync(join(ROOT, "agents", role, "officehum.json"), "utf8"),
  ) as { tools: { pack?: string }[] };
  if (!manifest.tools.some((tool) => tool.pack === "data")) return [];
  return [dataPack({ filesFor: async () => undefined, createdBy: `role:${role}` })];
}

async function build(role: string): Promise<Bundle> {
  const url = pathToFileURL(join(ROOT, "agents", role, "src", "index.ts")).href;
  const factory = (await import(url)).default as (options: Record<string, unknown>) => Bundle;
  const packs = packsFor(role);
  return factory({
    demo: true,
    now: () => new Date(NOW),
    ...(packs.length === 0 ? {} : { packs }),
  });
}

function tools(bundle: Bundle): Tool[] {
  return bundle.extensions.flatMap((extension) => [...(extension.tools ?? [])]);
}

/** What a result says, as text: its output blocks, then its details, so a UI's view is pinned too. */
function shown(result: unknown): string {
  const value = result as { output?: readonly { text?: string }[]; details?: unknown };
  const text = (value.output ?? []).map((block) => block.text ?? JSON.stringify(block)).join("\n");
  return `${text}\n-- details: ${JSON.stringify(value.details ?? null)}`;
}

async function call(role: string, name: string, args: unknown, index: number): Promise<string> {
  const tool = tools(await build(role)).find((candidate) => candidate.name === name);
  if (tool === undefined) return `(no tool ${name})`;
  try {
    const identity = {
      conversationId: "conversation-1",
      taskId: "task-1",
      callId: `call-${index}`,
    };
    return shown(await tool.execute(args, identity, BACKGROUND_CONTEXT));
  } catch (error) {
    return `THROWS: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** `read_company`'s sections, read from its own schema so a new section is pinned as it lands. */
function companySections(tool: Tool | undefined): string[] {
  const schema = tool?.parameters as
    | { properties?: { section?: { enum?: string[]; anyOf?: { const?: string }[] } } }
    | undefined;
  const section = schema?.properties?.section;
  return section?.enum ?? (section?.anyOf ?? []).flatMap((entry) => entry.const ?? []);
}

async function view(role: string): Promise<string> {
  const bundle = await build(role);
  const lines: string[] = [];
  for (const extension of bundle.extensions) {
    for (const section of extension.sections ?? []) {
      let rendered: unknown;
      try {
        rendered = await section.render({}, {});
      } catch (error) {
        rendered = `THROWS: ${error instanceof Error ? error.message : String(error)}`;
      }
      lines.push(`=== section ${extension.name} › ${section.key}`, String(rendered));
    }
  }
  for (const tool of tools(bundle)) {
    lines.push(
      `=== tool ${tool.name}`,
      tool.description ?? "",
      `-- parameters: ${JSON.stringify(tool.parameters ?? null)}`,
    );
  }
  let index = 0;
  for (const tool of tools(bundle)) {
    lines.push(`=== call ${tool.name} {}`, await call(role, tool.name, {}, index++));
  }
  const readCompany = tools(bundle).find((tool) => tool.name === "read_company");
  for (const section of companySections(readCompany)) {
    lines.push(
      `=== call read_company ${section}`,
      await call(role, "read_company", { section }, index++),
    );
  }
  for (const { tool, args } of CALLS[role] ?? []) {
    lines.push(`=== call ${tool} ${JSON.stringify(args)}`, await call(role, tool, args, index++));
  }
  return `${lines.join("\n")}\n`;
}

describe("what each catalog role shows a model on the default company", () => {
  for (const role of catalogRoles()) {
    it(role, async () => {
      await expect(await view(role)).toMatchFileSnapshot(`__model-view__/${role}.txt`);
    });
  }
});
