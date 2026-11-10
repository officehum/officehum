/**
 * The office file a runtime process is started with (`officehum runtime --office office.json`): which
 * role packages this office runs, each with its overlay directories.
 *
 * ```json
 * { "version": 1, "id": "office-7f3a", "roles": [{ "dir": "agents/sales", "overlays": ["overlays/sales"] }] }
 * ```
 *
 * Relative paths are resolved against the file's own directory, so an office file and its overlays
 * can move together. It holds paths only: no credentials, and nothing that switches a role onto
 * demonstration data (that stays a host flag, `--demo`).
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { type LoadedRole, type LoadRoleOptions, loadRole } from "../roles/load-role.js";

export interface OfficeFileRole {
  /** The role package directory, absolute. */
  readonly dir: string;
  /** Overlay directories, lowest first, absolute. */
  readonly overlays: readonly string[];
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
        if (key !== "dir" && key !== "overlays") problem(`${at}.${key}`, "is not a known field");
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
      if (typeof entry.dir === "string" && Array.isArray(overlays)) {
        roles.push({
          dir: resolve(base, entry.dir),
          overlays: overlays
            .filter((dir): dir is string => typeof dir === "string")
            .map((dir) => resolve(base, dir)),
        });
      }
    });
  }

  if (problems.length > 0) {
    throw new Error(`The ${source} has ${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
  }
  return { id: value.id as string, roles };
}

/**
 * Loads every role the office file lists. Refuses two roles with the same manifest id, since a
 * command names its agent by that id.
 */
export async function loadOfficeRoles(
  file: OfficeFile,
  options: Pick<LoadRoleOptions, "demo"> = {},
): Promise<LoadedRole[]> {
  const roles: LoadedRole[] = [];
  for (const entry of file.roles) {
    const role = await loadRole(entry.dir, {
      overlays: entry.overlays,
      ...(options.demo === true ? { demo: true } : {}),
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
