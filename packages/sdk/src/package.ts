/**
 * `validatePackage` reads a role package from disk and enforces the portability boundary: a role
 * must install into any Pi Durable 1.0.x harness, with or without Office Hum.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import semver from "semver";
import { type EvalSuite, validateSuite } from "./evals/suite.js";
import { type Issue, show, type Validation } from "./issues.js";
import { type AgentManifest, MANIFEST_FILE, validateManifest } from "./manifest.js";
import { resolveRoleFiles } from "./resources.js";

/** The Pi Durable package a role must take as a peer dependency. */
export const PI_DURABLE_PACKAGE = "@earendil-works/pi-durable";

/** Packages that must be peer dependencies, so a role uses the host's single copy. */
export const PEER_ONLY_PACKAGES = [PI_DURABLE_PACKAGE, "@earendil-works/pi-ai"] as const;

/** Office Hum platform packages a role may never depend on: a role must run without the Office. */
export const PLATFORM_PACKAGES = ["@officehum/office", "@officehum/cli"] as const;

/** A role package as read from disk, once it passes validation. */
export interface RolePackage {
  readonly dir: string;
  readonly name: string;
  readonly version: string;
  /** The Pi Durable versions the role supports, from its peer dependency. */
  readonly piDurableRange: string;
  readonly manifest: AgentManifest;
  /** Eval files by path relative to the package, e.g. `evals/basic.json`. */
  readonly suites: Readonly<Record<string, EvalSuite>>;
}

type PackageJson = {
  name?: unknown;
  version?: unknown;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

/** Whether a role's Pi Durable range includes a given Pi Durable version. */
export function supportsPiDurable(range: string, version: string): boolean {
  return semver.satisfies(version, range);
}

/** Reads and validates a role package: package.json, officehum.json, its role files and every eval file. */
export async function validatePackage(dir: string): Promise<Validation<RolePackage>> {
  const issues: Issue[] = [];

  const pkg = await readJson(join(dir, "package.json"), "package.json", issues);
  const manifestJson = await readJson(join(dir, MANIFEST_FILE), MANIFEST_FILE, issues);

  let piDurableRange = "";
  if (pkg !== undefined) piDurableRange = packageJsonIssues(pkg as PackageJson, issues);

  let manifest: AgentManifest | undefined;
  if (manifestJson !== undefined) {
    const result = validateManifest(manifestJson);
    if (result.ok) manifest = result.value;
    else issues.push(...result.issues);
  }

  // The role's files: AGENTS.md, APPEND_SYSTEM.md and skills/, matched against the manifest.
  if (manifest !== undefined) {
    const files = resolveRoleFiles({ packageDir: dir, manifest });
    if (!files.ok) issues.push(...files.issues);
  }

  const suites: Record<string, EvalSuite> = {};
  if (manifest !== undefined) {
    const evalDir = join(dir, manifest.evals);
    let files: string[] = [];
    try {
      files = (await readdir(evalDir)).filter((file) => file.endsWith(".json")).sort();
    } catch {
      issues.push({
        source: MANIFEST_FILE,
        path: "evals",
        message: `directory ${show(manifest.evals)} does not exist`,
      });
    }
    if (files.length === 0 && issues.every((issue) => issue.path !== "evals")) {
      issues.push({
        source: MANIFEST_FILE,
        path: "evals",
        message: `directory ${show(manifest.evals)} has no .json eval files`,
      });
    }
    const scenarioFiles = new Map<string, string>();
    for (const file of files) {
      const source = `${manifest.evals.replace(/^\.\//, "").replace(/\/$/, "")}/${file}`;
      const json = await readJson(join(evalDir, file), source, issues);
      if (json === undefined) continue;
      const result = validateSuite(json, manifest, source);
      if (!result.ok) {
        issues.push(...result.issues);
        continue;
      }
      suites[source] = result.value;
      result.value.scenarios.forEach((scenario, index) => {
        const other = scenarioFiles.get(scenario.id);
        if (other !== undefined) {
          issues.push({
            source,
            path: `scenarios[${index}].id`,
            message: `${show(scenario.id)} is also used in ${other}`,
          });
        }
        scenarioFiles.set(scenario.id, source);
      });
    }
  }

  if (issues.length > 0 || manifest === undefined || pkg === undefined)
    return { ok: false, issues };
  const { name, version } = pkg as { name: string; version: string };
  return { ok: true, value: { dir, name, version, piDurableRange, manifest, suites }, issues: [] };
}

/** Checks package.json against the portability boundary; returns the Pi Durable range. */
function packageJsonIssues(pkg: PackageJson, issues: Issue[]): string {
  const add = (path: string, message: string) =>
    issues.push({ source: "package.json", path, message });

  if (typeof pkg.name !== "string" || pkg.name === "") add("name", "is required");
  if (typeof pkg.version !== "string" || semver.valid(pkg.version) === null) {
    add("version", `must be a semver version (got ${show(pkg.version)})`);
  }

  const dependencies = pkg.dependencies ?? {};
  for (const name of PEER_ONLY_PACKAGES) {
    if (name in dependencies) {
      add(
        `dependencies.${name}`,
        "must be a peer dependency, so the role uses the host's copy of Pi Durable",
      );
    }
  }
  for (const name of PLATFORM_PACKAGES) {
    if (name in dependencies) {
      add(
        `dependencies.${name}`,
        "is not allowed; a role must run on any Pi Durable install without Office Hum",
      );
    }
  }

  const range = pkg.peerDependencies?.[PI_DURABLE_PACKAGE];
  if (range === undefined) {
    add("peerDependencies", `must include ${show(PI_DURABLE_PACKAGE)}, e.g. "1.0.x"`);
    return "";
  }
  if (semver.validRange(range) === null) {
    add(`peerDependencies.${PI_DURABLE_PACKAGE}`, `must be a semver range (got ${show(range)})`);
  }
  return range;
}

async function readJson(path: string, source: string, issues: Issue[]): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    issues.push({ source, path: "", message: "file not found" });
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    issues.push({
      source,
      path: "",
      message: `is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    });
    return undefined;
  }
}
