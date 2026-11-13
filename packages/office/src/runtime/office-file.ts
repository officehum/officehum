/**
 * The office file a runtime process is started with (`officehum runtime --office office.json`): which
 * role packages this office runs, each with its overlay directories.
 *
 * ```json
 * { "version": 1, "id": "office-7f3a", "roles": [{ "dir": "agents/sales", "overlays": ["overlays/sales"] }] }
 * ```
 *
 * A role may also name the outside systems it works in (RASF-3576), by the name its factory takes
 * the client under:
 *
 * ```json
 * { "dir": "agents/frontdesk", "connections": { "calendar": { "kind": "local", "file": "state/calendar.sqlite" } } }
 * { "dir": "agents/frontdesk", "connections": { "calendar": { "kind": "google", "calendarId": "…", "decisions": "state/calendar.sqlite" } } }
 * { "dir": "agents/bookkeeper", "connections": { "quickbooks": { "kind": "quickbooks", "realmId": "…", "environment": "sandbox" } } }
 * ```
 *
 * Relative paths are resolved against the file's own directory, so an office file and its overlays
 * can move together. It holds paths and ids only: no credentials (the host reads those from its
 * environment when it builds a client), and nothing that switches a role onto demonstration data
 * (that stays a host flag, `--demo`).
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadCompanyFacts } from "@officehum/sdk";
import type { Person } from "../board/index.js";
import type { PersonRoute } from "../extension/index.js";
import { type LoadedRole, type LoadRoleOptions, loadRole } from "../roles/load-role.js";

/** The longest an approval may wait: a year. */
const MAX_APPROVAL_TIMEOUT_MINUTES = 525_600;

/**
 * One outside system a role works in, as the office file names it. Paths are absolute once parsed.
 * A `google` calendar keeps its own record of what it booked in a local file (`decisions`), so a
 * repeated call is answered from the record instead of booking twice.
 */
export type OfficeConnection =
  | { readonly kind: "local"; readonly file: string }
  | { readonly kind: "google"; readonly calendarId: string; readonly decisions: string }
  | {
      readonly kind: "quickbooks";
      readonly realmId: string;
      readonly environment: "sandbox" | "production";
    };

/** The client names a connection may be filed under, and the kinds each takes. */
const CONNECTION_KINDS: Readonly<Record<string, readonly OfficeConnection["kind"][]>> = {
  calendar: ["local", "google"],
  quickbooks: ["quickbooks"],
};

/** Each kind's fields beside `kind`, all required, and which of them are paths. */
const CONNECTION_FIELDS: Readonly<
  Record<
    OfficeConnection["kind"],
    { readonly fields: readonly string[]; readonly paths: readonly string[] }
  >
> = {
  local: { fields: ["file"], paths: ["file"] },
  google: { fields: ["calendarId", "decisions"], paths: ["decisions"] },
  quickbooks: { fields: ["realmId", "environment"], paths: [] },
};

export interface OfficeFileRole {
  /** The role package directory, absolute. */
  readonly dir: string;
  /** The outside systems this role works in, by the name its factory takes the client under. */
  readonly connections?: Readonly<Record<string, OfficeConnection>>;
  /** Overlay directories, lowest first, absolute. */
  readonly overlays: readonly string[];
  /** How long this agent's approvals wait for a decision before they are declined. Default 240. */
  readonly approvalTimeoutMinutes?: number;
}

export interface OfficeFile {
  /** The office's id; the runtime's `serverId` in `welcome`. */
  readonly id: string;
  readonly roles: readonly OfficeFileRole[];
}

/** Reads and checks an office file, reporting every problem with its path at once. */
export async function readOfficeFile(path: string): Promise<OfficeFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Could not read the office file ${path}: ${String(error)}`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`The office file ${path} is not JSON: ${String(error)}`, { cause: error });
  }
  return parseOfficeFile(parsed, dirname(resolve(path)), path);
}

/** Checks parsed office-file content; `base` is the directory relative paths resolve against. */
export function parseOfficeFile(value: unknown, base: string, source = "office file"): OfficeFile {
  const problems: string[] = [];
  const problem = (path: string, message: string) => problems.push(`${path}: ${message}`);

  if (!isObject(value)) {
    throw new Error(`The ${source} must be a JSON object.`);
  }
  for (const key of Object.keys(value)) {
    if (!["version", "id", "roles"].includes(key)) problem(key, "is not a known field");
  }
  if (value.version !== 1) {
    problem("version", `must be 1 (got ${JSON.stringify(value.version) ?? "nothing"})`);
  }
  if (typeof value.id !== "string" || value.id.length === 0) {
    problem("id", "must be a non-empty string, the office's id");
  }

  const roles: OfficeFileRole[] = [];
  if (!Array.isArray(value.roles) || value.roles.length === 0) {
    problem("roles", 'must be a list of at least one role, e.g. [{ "dir": "agents/sales" }]');
  } else {
    value.roles.forEach((entry: unknown, index) => {
      const at = `roles[${index}]`;
      if (!isObject(entry)) {
        problem(at, "must be an object with a dir");
        return;
      }
      for (const key of Object.keys(entry)) {
        if (!["dir", "overlays", "approvalTimeoutMinutes", "connections"].includes(key)) {
          problem(`${at}.${key}`, "is not a known field");
        }
      }
      if (typeof entry.dir !== "string" || entry.dir.length === 0) {
        problem(`${at}.dir`, "must be the role package's directory");
      }
      const overlays = entry.overlays ?? [];
      if (
        !Array.isArray(overlays) ||
        overlays.some((dir) => typeof dir !== "string" || dir === "")
      ) {
        problem(`${at}.overlays`, "must be a list of overlay directories");
      }
      const timeout = entry.approvalTimeoutMinutes;
      if (
        timeout !== undefined &&
        (typeof timeout !== "number" ||
          !Number.isFinite(timeout) ||
          timeout <= 0 ||
          timeout > MAX_APPROVAL_TIMEOUT_MINUTES)
      ) {
        problem(
          `${at}.approvalTimeoutMinutes`,
          `must be a number of minutes above 0 and at most ${MAX_APPROVAL_TIMEOUT_MINUTES} (a year), e.g. 240`,
        );
      }
      const connections = connectionsOf(entry.connections, `${at}.connections`, base, problem);
      if (typeof entry.dir === "string" && Array.isArray(overlays)) {
        roles.push({
          ...(connections === undefined ? {} : { connections }),
          dir: resolve(base, entry.dir),
          overlays: overlays
            .filter((dir): dir is string => typeof dir === "string")
            .map((dir) => resolve(base, dir)),
          ...(typeof timeout === "number" ? { approvalTimeoutMinutes: timeout } : {}),
        });
      }
    });
  }

  if (problems.length > 0) {
    throw new Error(`The ${source} has ${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
  }
  return { id: value.id as string, roles };
}

/** Checks one role's `connections`, reporting every problem; `undefined` when it names none. */
function connectionsOf(
  value: unknown,
  at: string,
  base: string,
  problem: (path: string, message: string) => void,
): Record<string, OfficeConnection> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    problem(
      at,
      'must be an object, e.g. { "calendar": { "kind": "local", "file": "calendar.sqlite" } }',
    );
    return undefined;
  }
  const connections: Record<string, OfficeConnection> = {};
  for (const [name, entry] of Object.entries(value)) {
    const here = `${at}.${name}`;
    const kinds = CONNECTION_KINDS[name];
    if (kinds === undefined) {
      problem(
        here,
        `is not a connection this host can make; it makes ${Object.keys(CONNECTION_KINDS).join(" and ")}`,
      );
      continue;
    }
    if (!isObject(entry)) {
      problem(here, `must be an object with a kind: ${kinds.join(" or ")}`);
      continue;
    }
    const kind = kinds.find((candidate) => candidate === entry.kind);
    if (kind === undefined) {
      problem(
        `${here}.kind`,
        `must be ${kinds.map((candidate) => `"${candidate}"`).join(" or ")} (got ${JSON.stringify(entry.kind) ?? "nothing"})`,
      );
      continue;
    }
    const { fields, paths } = CONNECTION_FIELDS[kind];
    for (const key of Object.keys(entry)) {
      if (key !== "kind" && !fields.includes(key))
        problem(`${here}.${key}`, "is not a known field");
    }
    const settings: Record<string, string> = {};
    let complete = true;
    for (const field of fields) {
      const setting = entry[field];
      if (typeof setting !== "string" || setting.trim().length === 0) {
        problem(`${here}.${field}`, "must be a non-empty string");
        complete = false;
        continue;
      }
      settings[field] = paths.includes(field) ? resolve(base, setting) : setting.trim();
    }
    if (kind === "google" && settings.calendarId === "primary") {
      problem(`${here}.calendarId`, 'must name the calendar explicitly; "primary" is not allowed');
      complete = false;
    }
    if (
      kind === "quickbooks" &&
      settings.environment !== undefined &&
      settings.environment !== "sandbox" &&
      settings.environment !== "production"
    ) {
      problem(
        `${here}.environment`,
        `must be "sandbox" or "production" (got ${JSON.stringify(settings.environment)})`,
      );
      complete = false;
    }
    if (complete) connections[name] = { kind, ...settings } as OfficeConnection;
  }
  return connections;
}

/**
 * Loads every role the office file lists, in its order. Refuses two roles with the same manifest id,
 * since a command names its agent by that id. `approve` is the approver every role's gate asks (the
 * runtime's remote approvals); without one, gated actions are refused. `clientsFor` answers the app
 * clients the host built for a role's `connections`, by name; a host that builds none leaves it out,
 * and a role whose entry names connections is then refused rather than loaded without them.
 */
export async function loadOfficeRoles(
  file: OfficeFile,
  options: Pick<LoadRoleOptions, "demo" | "approve"> & {
    readonly clientsFor?: (role: OfficeFileRole) => Readonly<Record<string, unknown>>;
  } = {},
): Promise<LoadedRole[]> {
  const roles: LoadedRole[] = [];
  for (const entry of file.roles) {
    const named = Object.keys(entry.connections ?? {});
    const clients = options.clientsFor?.(entry) ?? {};
    const missing = named.filter((name) => !(name in clients));
    if (missing.length > 0) {
      throw new Error(
        `The office file names ${missing.join(" and ")} for the role in ${entry.dir}, but this host built no such client; nothing falls back to demonstration data.`,
      );
    }
    const role = await loadRole(entry.dir, {
      overlays: entry.overlays,
      ...(named.length === 0 ? {} : { clients }),
      ...(options.demo === true ? { demo: true } : {}),
      ...(options.approve === undefined ? {} : { approve: options.approve }),
    });
    const clash = roles.find((loaded) => loaded.manifest.id === role.manifest.id);
    if (clash !== undefined) {
      throw new Error(
        `Two roles in the office file are both ${role.manifest.id} (${clash.dir} and ${role.dir}); each agent needs its own id.`,
      );
    }
    roles.push(role);
  }
  return roles;
}

/**
 * Each agent's approval timeout in milliseconds, by agent name, for the agents whose office-file entry
 * sets one. `roles` is what `loadOfficeRoles` returned for this file, in the same order.
 */
export function approvalTimeoutsMs(
  file: OfficeFile,
  roles: readonly LoadedRole[],
): Record<string, number> {
  const timeouts: Record<string, number> = {};
  file.roles.forEach((entry, index) => {
    const role = roles[index];
    if (role !== undefined && entry.approvalTimeoutMinutes !== undefined) {
      timeouts[role.manifest.id] = entry.approvalTimeoutMinutes * 60_000;
    }
  });
  return timeouts;
}

/** Where a role package keeps the company record generated into it (`npm run sync-company`). */
export const COMPANY_FACTS = "skills/company-handbook/references/facts.json";

/** What a runtime with a workboard takes from its roles' company records. */
export interface OfficeCompany {
  /** The company's people, in the record's order: who the board can hand work and approvals to. */
  readonly people: readonly Person[];
  /** The record's `ticketRoutes`: ticket types that go to a person, not a role. */
  readonly personRoutes: readonly PersonRoute[];
}

/**
 * Reads the people and person routes from the company record in each role's package, in the roles'
 * order. Roles of one office carry copies of one record, so the first role to name a person or route
 * a type decides it. A role with no record (a generated role, say) adds nothing; a record that is
 * there and malformed is an error naming every problem, not an office that quietly knows nobody.
 */
export function readOfficeCompany(roles: readonly Pick<LoadedRole, "dir">[]): OfficeCompany {
  const people = new Map<string, Person>();
  const routes = new Map<string, PersonRoute>();
  for (const role of roles) {
    const path = resolve(role.dir, COMPANY_FACTS);
    if (!existsSync(path)) continue;
    const facts = loadCompanyFacts<{ people?: unknown; ticketRoutes?: unknown }>(
      pathToFileURL(path),
    );
    const problems: string[] = [];
    const entries = (key: "people" | "ticketRoutes"): unknown[] => {
      const value = facts[key] ?? [];
      if (Array.isArray(value)) return value;
      problems.push(`${key}: must be a list`);
      return [];
    };
    const text = (entry: unknown, at: string, field: string): string | undefined => {
      const value = isObject(entry) ? entry[field] : undefined;
      if (typeof value === "string" && value.trim().length > 0) return value;
      problems.push(`${at}.${field}: must be a non-empty string`);
      return undefined;
    };
    entries("people").forEach((entry, index) => {
      const id = text(entry, `people[${index}]`, "id");
      const name = text(entry, `people[${index}]`, "name");
      if (id !== undefined && name !== undefined && !people.has(id)) people.set(id, { id, name });
    });
    entries("ticketRoutes").forEach((entry, index) => {
      const type = text(entry, `ticketRoutes[${index}]`, "type");
      const personId = text(entry, `ticketRoutes[${index}]`, "toPersonId");
      if (type !== undefined && personId !== undefined && !routes.has(type)) {
        routes.set(type, { type, personId });
      }
    });
    if (problems.length > 0) {
      throw new Error(
        `The company record ${path} has ${problems.length} problem(s):\n  ${problems.join("\n  ")}\nIt is generated: run \`npm run sync-company\`.`,
      );
    }
  }
  return { people: [...people.values()], personRoutes: [...routes.values()] };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
