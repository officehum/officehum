import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadOfficeRoles, parseOfficeFile, readOfficeFile } from "./office-file.js";

const sales = fileURLToPath(new URL("../../../../agents/sales", import.meta.url));

const temps: string[] = [];
afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("parseOfficeFile", () => {
  it("resolves role and overlay paths against the file's directory", () => {
    expect(
      parseOfficeFile(
        { version: 1, id: "office-1", roles: [{ dir: "agents/sales", overlays: ["o/sales"] }] },
        "/srv/office",
      ),
    ).toEqual({
      id: "office-1",
      roles: [{ dir: "/srv/office/agents/sales", overlays: ["/srv/office/o/sales"] }],
    });
  });

  it("reports every problem with its path", () => {
    expect(() =>
      parseOfficeFile(
        { version: 2, roles: [{ overlays: "x" }, 7], extra: true },
        "/srv",
        "office.json",
      ),
    ).toThrow(
      [
        "The office.json has 6 problem(s):",
        "  extra: is not a known field",
        "  version: must be 1 (got 2)",
        "  id: must be a non-empty string, the office's id",
        "  roles[0].dir: must be the role package's directory",
        "  roles[0].overlays: must be a list of overlay directories",
        "  roles[1]: must be an object with a dir",
      ].join("\n"),
    );
  });

  it("requires at least one role", () => {
    expect(() => parseOfficeFile({ version: 1, id: "o", roles: [] }, "/srv")).toThrow(
      "roles: must be a list of at least one role",
    );
  });
});

describe("readOfficeFile and loadOfficeRoles", () => {
  it("loads the listed roles, on demonstration data when asked", async () => {
    const directory = mkdtempSync(join(tmpdir(), "officehum-office-file-"));
    temps.push(directory);
    const path = join(directory, "office.json");
    writeFileSync(path, JSON.stringify({ version: 1, id: "office-1", roles: [{ dir: sales }] }));
    const file = await readOfficeFile(path);
    const roles = await loadOfficeRoles(file, { demo: true });
    expect(roles.map((role) => role.manifest.id)).toEqual(["sales"]);
  });

  it("refuses two roles with the same id", async () => {
    await expect(
      loadOfficeRoles({
        id: "office-1",
        roles: [
          { dir: sales, overlays: [] },
          { dir: sales, overlays: [] },
        ],
      }),
    ).rejects.toThrow("Two roles in the office file are both sales");
  });

  it("says which file could not be read", async () => {
    await expect(readOfficeFile("/nowhere/office.json")).rejects.toThrow(
      "Could not read the office file /nowhere/office.json",
    );
  });
});
