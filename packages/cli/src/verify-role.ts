/**
 * `officehum verify-role ROLE_DIR [--online]`: checks a role's `role.md` against `role.sources.json`.
 * Offline it is the same check CI runs inside `validatePackage`. `--online` also re-fetches every
 * source and looks for each claim's passage, which needs the network, so only this command does it.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  checkRoleMd,
  formatIssue,
  type Issue,
  ROLE_MD_FILE,
  ROLE_SOURCES_FILE,
  type RoleSources,
  sourcesShapeIssues,
  verifyRoleOnline,
} from "@officehum/sdk";
import type { CliDependencies, CliIo } from "./cli.js";
import { UsageError } from "./usage-error.js";

const VERIFY_ROLE_USAGE = "usage: officehum verify-role ROLE_DIR [--online]";

/** Fetches a page's text with the global `fetch`. */
async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.text();
}

export async function runVerifyRoleCommand(
  args: readonly string[],
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  let roleDir: string | undefined;
  let online = false;
  for (const token of args) {
    if (token === "--online") online = true;
    else if (token.startsWith("--")) {
      throw new UsageError(`Unknown option: ${token}\n${VERIFY_ROLE_USAGE}`);
    } else if (roleDir !== undefined) {
      throw new UsageError(`Only one role directory is allowed.\n${VERIFY_ROLE_USAGE}`);
    } else roleDir = token;
  }
  if (roleDir === undefined) {
    throw new UsageError(`verify-role requires a role directory.\n${VERIFY_ROLE_USAGE}`);
  }

  const issues: Issue[] = [];
  let markdown: string | undefined;
  let sources: RoleSources | undefined;
  try {
    markdown = await readFile(join(roleDir, ROLE_MD_FILE), "utf8");
  } catch {
    issues.push({ source: ROLE_MD_FILE, path: "", message: "file not found" });
  }
  try {
    sources = JSON.parse(await readFile(join(roleDir, ROLE_SOURCES_FILE), "utf8")) as RoleSources;
  } catch (error) {
    issues.push({
      source: ROLE_SOURCES_FILE,
      path: "",
      message:
        error instanceof SyntaxError ? `is not valid JSON: ${error.message}` : "file not found",
    });
  }
  if (markdown !== undefined && sources !== undefined) {
    issues.push(...checkRoleMd(markdown, sources));
    // Source pages can be wrong whatever else is: fetch whenever the file is readable.
    if (online && sourcesShapeIssues(sources).length === 0) {
      issues.push(...(await verifyRoleOnline(sources, dependencies.fetchText ?? fetchText)));
    }
  }

  for (const issue of issues) io.output(formatIssue(issue));
  if (issues.some((issue) => issue.severity !== "warning")) return 1;
  io.output(`${ROLE_MD_FILE} OK${online ? " (online)" : ""}`);
  return 0;
}
