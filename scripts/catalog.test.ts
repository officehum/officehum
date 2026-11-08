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

interface Manifest {
  tools?: { name: string }[];
  approvals?: { id: string }[];
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
