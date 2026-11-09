/**
 * The catalog test: `agents/README.md` lists every role, with its tools and the actions it asks a
 * person about. Those lists are copied from each role's `officehum.json`, so this reads every
 * manifest and fails when the catalog misses a role, names a tool or approval the manifest does not
 * have, or leaves one out.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const agentsDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "agents");
const companyFile = join(agentsDirectory, "..", "company", "default", "company.json");

interface Manifest {
  id: string;
  tools?: { name: string }[];
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
  tools: string[];
  approvals: string[];
}

const ticked = (cell: string): string[] => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");

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
    tools: ticked(cells[4] ?? ""),
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
      expect([...(row?.tools ?? [])].sort()).toEqual(
        (manifest.tools ?? []).map((tool) => tool.name).sort(),
      );
      expect([...(row?.approvals ?? [])].sort()).toEqual(
        (manifest.approvals ?? []).map((approval) => approval.id).sort(),
      );
    });
  }
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
 * Two honesty checks every catalog role carries (RASF-3483): a decline whose block names nobody is
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
