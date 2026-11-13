import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { LoadedRole } from "../roles/load-role.js";
import {
  COMPANY_FACTS,
  loadOfficeRoles,
  parseOfficeFile,
  readOfficeCompany,
  readOfficeFile,
} from "./office-file.js";

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

  it("reads a role's named connections, resolving their paths and keeping no secret", () => {
    const parsed = parseOfficeFile(
      {
        version: 1,
        id: "office-1",
        roles: [
          {
            dir: "agents/frontdesk",
            connections: { calendar: { kind: "local", file: "state/calendar.sqlite" } },
          },
          {
            dir: "agents/frontdesk-east",
            connections: {
              calendar: {
                kind: "google",
                calendarId: " team@example.com ",
                decisions: "state/g.sqlite",
              },
            },
          },
          {
            dir: "agents/bookkeeper",
            connections: {
              quickbooks: { kind: "quickbooks", realmId: "4620816365", environment: "sandbox" },
            },
          },
          { dir: "agents/sales" },
        ],
      },
      "/srv/office",
    );
    expect(parsed.roles.map((role) => role.connections)).toEqual([
      { calendar: { kind: "local", file: "/srv/office/state/calendar.sqlite" } },
      {
        calendar: {
          kind: "google",
          calendarId: "team@example.com",
          decisions: "/srv/office/state/g.sqlite",
        },
      },
      { quickbooks: { kind: "quickbooks", realmId: "4620816365", environment: "sandbox" } },
      undefined,
    ]);
  });

  it("refuses an unknown connection, kind or field, and a credential, each with its path", () => {
    expect(() =>
      parseOfficeFile(
        {
          version: 1,
          id: "office-1",
          roles: [
            {
              dir: "a",
              connections: {
                crm: { kind: "salesforce" },
                calendar: { kind: "outlook" },
                quickbooks: {
                  kind: "quickbooks",
                  realmId: "1",
                  environment: "live",
                  accessToken: "not-a-real-token",
                },
              },
            },
            { dir: "b", connections: { calendar: { kind: "google", calendarId: "primary" } } },
            { dir: "c", connections: { calendar: { kind: "local" } } },
            { dir: "d", connections: { calendar: "local" } },
            { dir: "e", connections: ["calendar"] },
          ],
        },
        "/srv",
        "office.json",
      ),
    ).toThrowError(
      [
        "The office.json has 9 problem(s):",
        "  roles[0].connections.crm: is not a connection this host can make; it makes calendar and quickbooks",
        '  roles[0].connections.calendar.kind: must be "local" or "google" (got "outlook")',
        "  roles[0].connections.quickbooks.accessToken: is not a known field",
        '  roles[0].connections.quickbooks.environment: must be "sandbox" or "production" (got "live")',
        "  roles[1].connections.calendar.decisions: must be a non-empty string",
        '  roles[1].connections.calendar.calendarId: must name the calendar explicitly; "primary" is not allowed',
        "  roles[2].connections.calendar.file: must be a non-empty string",
        "  roles[3].connections.calendar: must be an object with a kind: local or google",
        '  roles[4].connections: must be an object, e.g. { "calendar": { "kind": "local", "file": "calendar.sqlite" } }',
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

  it("refuses a role whose connections the host did not build, and passes the ones it did", async () => {
    const file = parseOfficeFile(
      {
        version: 1,
        id: "office-1",
        roles: [{ dir: sales, connections: { calendar: { kind: "local", file: "c.sqlite" } } }],
      },
      "/",
    );
    await expect(loadOfficeRoles(file, { demo: true })).rejects.toThrow(
      /names calendar for the role in .*sales, but this host built no such client; nothing falls back/,
    );
    const asked: unknown[] = [];
    const [role] = await loadOfficeRoles(file, {
      demo: true,
      clientsFor: (entry) => {
        asked.push(entry.connections);
        return { calendar: {} };
      },
    });
    expect(role?.manifest.id).toBe("sales");
    expect(asked).toEqual([{ calendar: { kind: "local", file: "/c.sqlite" } }]);
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

describe("readOfficeCompany", () => {
  /** A role directory holding only a company record. */
  function roleWith(facts: unknown): LoadedRole {
    const dir = mkdtempSync(join(tmpdir(), "officehum-office-company-"));
    temps.push(dir);
    const path = join(dir, COMPANY_FACTS);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(facts));
    return { dir } as LoadedRole;
  }

  it("reads the people and person routes of a catalog role's company record", () => {
    const company = readOfficeCompany([{ dir: sales } as LoadedRole]);
    expect(company.people[0]).toEqual({ id: "dana-whitfield", name: "Dana Whitfield" });
    expect(company.people).toHaveLength(9);
    expect(company.personRoutes).toEqual([{ type: "finance.review", personId: "eileen-hart" }]);
  });

  it("lets the first role to name a person or route a type decide it, and skips a role with no record", () => {
    const empty = mkdtempSync(join(tmpdir(), "officehum-office-company-"));
    temps.push(empty);
    const company = readOfficeCompany([
      { dir: empty } as LoadedRole,
      roleWith({
        people: [{ id: "ada", name: "Ada" }],
        ticketRoutes: [{ type: "legal.review", toPersonId: "ada", when: "Contracts." }],
      }),
      roleWith({
        people: [
          { id: "ada", name: "Ada Again" },
          { id: "bo", name: "Bo" },
        ],
        ticketRoutes: [{ type: "legal.review", toPersonId: "bo", when: "Contracts." }],
      }),
    ]);
    expect(company).toEqual({
      people: [
        { id: "ada", name: "Ada" },
        { id: "bo", name: "Bo" },
      ],
      personRoutes: [{ type: "legal.review", personId: "ada" }],
    });
  });

  it("reports every problem in a malformed record with its path", () => {
    const role = roleWith({ people: [{ id: "ada" }, "bo"], ticketRoutes: {} });
    expect(() => readOfficeCompany([role])).toThrow(
      [
        "has 4 problem(s):",
        "  people[0].name: must be a non-empty string",
        "  people[1].id: must be a non-empty string",
        "  people[1].name: must be a non-empty string",
        "  ticketRoutes: must be a list",
      ].join("\n"),
    );
  });
});
