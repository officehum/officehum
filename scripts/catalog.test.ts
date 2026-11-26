/**
 * The catalog test: `agents/README.md` lists every role, with its tools and the actions it asks a
 * person about. Those lists are copied from each role's `officehum.json`, so this reads every
 * manifest and fails when the catalog misses a role, names a tool or approval the manifest does not
 * have, or leaves one out. A tool the role declares from a tool pack is listed after
 * "from the office's <pack> pack:", since the office supplies it, not the package.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type AgentManifest, limitDirection } from "../packages/sdk/src/manifest.js";
import {
  type ResponsibilitySource,
  type ResponsiblePerson,
  responsible,
} from "../packages/sdk/src/responsibilities.js";
import { SEND_TOOLS } from "../packages/sdk/src/send-tools.js";
import { freeCatalogRole } from "./company.ts";

const agentsDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "agents");
const companyFile = join(agentsDirectory, "..", "company", "default", "company.json");

interface Manifest {
  id: string;
  tools?: { name: string; pack?: string }[];
  approvals?: { id: string }[];
  accepts: { type: string }[];
  dispatches?: { type: string }[];
}

/**
 * Every ticket type a role hands on that no other role accepts and no person route takes, as
 * `"<role>: <type>"`. The office extension's `agent_dispatch` refuses exactly these, so a catalog
 * role that declares one would be refused at run time. A role's own accepts do not count: the
 * extension leaves them out of what that role may dispatch.
 */
function unroutedDispatches(
  manifests: readonly {
    id: string;
    accepts: { type: string }[];
    dispatches?: { type: string }[];
  }[],
  routes: readonly { type: string }[],
): string[] {
  const routed = new Set(routes.map((route) => route.type));
  const unrouted: string[] = [];
  for (const manifest of manifests) {
    for (const { type } of manifest.dispatches ?? []) {
      const accepted = manifests.some(
        (other) => other.id !== manifest.id && other.accepts.some((accept) => accept.type === type),
      );
      if (!accepted && !routed.has(type)) unrouted.push(`${manifest.id}: ${type}`);
    }
  }
  return unrouted;
}

interface Row {
  folder: string;
  packageName: string;
  /** The tools the package brings itself. */
  tools: string[];
  /** The tools the office supplies, by pack. */
  packs: Record<string, string[]>;
  approvals: string[];
}

const ticked = (cell: string): string[] => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");

/** A tools cell: the package's own tools, then each pack's after "from the office's <pack> pack:". */
function toolsCell(cell: string): Pick<Row, "tools" | "packs"> {
  const [own = "", ...rest] = cell.split(/from the office's ([a-z][a-z0-9-]*) pack:/);
  const packs: Record<string, string[]> = {};
  for (let index = 0; index < rest.length; index += 2) {
    packs[rest[index] ?? ""] = ticked(rest[index + 1] ?? "");
  }
  return { tools: ticked(own), packs };
}

/** A manifest's tools as a catalog row lists them: its own, then each pack's. */
function manifestTools(manifest: Manifest): Pick<Row, "tools" | "packs"> {
  const packs: Record<string, string[]> = {};
  for (const tool of manifest.tools ?? []) {
    if (tool.pack !== undefined) packs[tool.pack] = [...(packs[tool.pack] ?? []), tool.name].sort();
  }
  const tools = (manifest.tools ?? []).filter((tool) => tool.pack === undefined);
  return { tools: tools.map((tool) => tool.name).sort(), packs };
}

const readme = readFileSync(join(agentsDirectory, "README.md"), "utf8");
const catalog = new Map<string, Row>();
for (const line of readme.split("\n")) {
  // A catalog row starts with the role folder in backticks: | `sales` | `@officehum/sales` | ...
  const cells = line.split("|").map((cell) => cell.trim());
  const folder = /^`([a-z-]+)`$/.exec(cells[1] ?? "")?.[1];
  if (folder === undefined || cells.length < 7) continue;
  catalog.set(folder, {
    folder,
    packageName: ticked(cells[2] ?? "")[0] ?? "",
    ...toolsCell(cells[4] ?? ""),
    approvals: ticked(cells[5] ?? ""),
  });
}

const roles = readdirSync(agentsDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => {
    try {
      readFileSync(join(agentsDirectory, name, "officehum.json"));
      return true;
    } catch {
      return false;
    }
  })
  // A role Office Hum installs itself (`"officehum": { "catalog": false }`) is not in the catalogue
  // table: it is not a department role, and its own README describes it.
  .filter((name) => freeCatalogRole(join(agentsDirectory, name)))
  .sort();

describe("agents/README.md catalog", () => {
  it("finds the roles", () => {
    expect(roles.length).toBeGreaterThan(0);
  });

  it("has no row for a folder that is not a role", () => {
    expect([...catalog.keys()].sort()).toEqual(roles);
  });

  for (const role of roles) {
    it(`lists ${role} with exactly its manifest's tools and approvals`, () => {
      const manifest = JSON.parse(
        readFileSync(join(agentsDirectory, role, "officehum.json"), "utf8"),
      ) as Manifest;
      const packageJson = JSON.parse(
        readFileSync(join(agentsDirectory, role, "package.json"), "utf8"),
      ) as { name: string };
      const row = catalog.get(role);
      expect(row, `agents/README.md has no catalog row for ${role}`).toBeDefined();
      expect(row?.packageName).toBe(packageJson.name);
      const listed = {
        tools: [...(row?.tools ?? [])].sort(),
        packs: Object.fromEntries(
          Object.entries(row?.packs ?? {}).map(([pack, names]) => [pack, [...names].sort()]),
        ),
      };
      expect(listed).toEqual(manifestTools(manifest));
      expect([...(row?.approvals ?? [])].sort()).toEqual(
        (manifest.approvals ?? []).map((approval) => approval.id).sort(),
      );
    });
  }
});

describe("catalog tools cells", () => {
  it("reads a pack's tools apart from the package's own", () => {
    expect(
      toolsCell(
        "`list_periods`, `read_company`; from the office's data pack: `data_query`, `chart_render`",
      ),
    ).toEqual({
      tools: ["list_periods", "read_company"],
      packs: { data: ["data_query", "chart_render"] },
    });
    expect(toolsCell("None")).toEqual({ tools: [], packs: {} });
  });
});

describe("catalog hand-offs", () => {
  it("unroutedDispatches flags a type nobody accepts or routes", () => {
    const manifests = [
      { id: "desk", accepts: [{ type: "desk.ask" }], dispatches: [{ type: "books.ask" }] },
      {
        id: "books",
        accepts: [{ type: "books.ask" }],
        dispatches: [{ type: "finance.review" }, { type: "lost.type" }, { type: "books.ask" }],
      },
    ];
    expect(unroutedDispatches(manifests, [{ type: "finance.review" }])).toEqual([
      "books: lost.type",
      "books: books.ask",
    ]);
    expect(unroutedDispatches(manifests, [])).toContain("books: finance.review");
  });

  it("every catalog dispatch is accepted by a role or routed to a person", () => {
    const manifests = roles.map(
      (role) =>
        JSON.parse(readFileSync(join(agentsDirectory, role, "officehum.json"), "utf8")) as Manifest,
    );
    const company = JSON.parse(readFileSync(companyFile, "utf8")) as {
      ticketRoutes?: { type: string }[];
    };
    expect(unroutedDispatches(manifests, company.ticketRoutes ?? [])).toEqual([]);
  });
});

/**
 * Two honesty checks every catalog role carries: a decline whose block names nobody is
 * reported without naming a decider, and a request the role cannot act on is never claimed as handed
 * on. Fixed ids let this test find them, and `critical` keeps a single miss from passing a suite.
 */
const HONESTY_SCENARIOS = ["decline-names-no-decider", "unhandled-request-claims-no-hand-off"];

describe("catalog honesty scenarios", () => {
  it("every catalog role carries both honesty scenarios as critical", () => {
    const missing: string[] = [];
    for (const role of catalog.keys()) {
      const suite = JSON.parse(
        readFileSync(join(agentsDirectory, role, "evals", "situations.json"), "utf8"),
      ) as { scenarios: { id: string; severity?: string }[] };
      for (const id of HONESTY_SCENARIOS) {
        const scenario = suite.scenarios.find((candidate) => candidate.id === id);
        if (scenario === undefined) missing.push(`${role}: no ${id}`);
        else if (scenario.severity !== "critical") missing.push(`${role}: ${id} is not critical`);
      }
    }
    expect(catalog.size).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
});

/**
 * The safeguard declarations every catalog role makes (docs/design/overlay-rules.md): a
 * limit only code reads says which way it guards, so an overlay change to it is judged mechanically
 * rather than counted as lowering a safeguard either way; and the channel's send tools say they reach
 * people outside the business, so the declaration is the one place a reader looks for the floor.
 */
describe("catalog safeguard declarations", () => {
  const manifests = roles.map(
    (role) =>
      JSON.parse(
        readFileSync(join(agentsDirectory, role, "officehum.json"), "utf8"),
      ) as AgentManifest,
  );

  it("every limit says which way it guards, by an approval comparing with it or its guard", () => {
    const undeclared = manifests.flatMap((manifest) =>
      Object.keys(manifest.limits ?? {})
        .filter((name) => limitDirection(manifest, name) === "both")
        .map((name) => `${manifest.id}: ${name}`),
    );
    expect(undeclared).toEqual([]);
  });

  it("every catalog tool the channel sends with declares outside", () => {
    const undeclared = manifests.flatMap((manifest) =>
      manifest.tools
        .filter((tool) => SEND_TOOLS.includes(tool.name) && tool.outside !== true)
        .map((tool) => `${manifest.id}: ${tool.name}`),
    );
    expect(undeclared).toEqual([]);
  });
});

describe("catalog company responsibilities", () => {
  it("the default company has someone for every responsibility a catalog role hands work to", () => {
    const company = JSON.parse(
      readFileSync(companyFile, "utf8"),
    ) as ResponsibilitySource<ResponsiblePerson>;
    const unfilled = roles.flatMap((role) => {
      const manifest = JSON.parse(
        readFileSync(join(agentsDirectory, role, "officehum.json"), "utf8"),
      ) as AgentManifest;
      return (manifest.company?.responsibilities ?? [])
        .filter((id) => responsible(company, id) === undefined)
        .map((id) => `${manifest.id}: ${id}`);
    });
    expect(unfilled).toEqual([]);
  });

  it("every catalog role that hands work to a person says which responsibilities", () => {
    const silent = roles.filter((role) => {
      const manifest = JSON.parse(
        readFileSync(join(agentsDirectory, role, "officehum.json"), "utf8"),
      ) as AgentManifest;
      return (manifest.dispatches ?? []).length > 0 && manifest.company === undefined;
    });
    expect(silent).toEqual([]);
  });
});
