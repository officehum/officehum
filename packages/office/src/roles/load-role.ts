/**
 * Loading one role package from a directory, for the host that runs it.
 *
 * A host that runs a role must answer three questions before any work starts: is this package valid
 * and portable (`validatePackage`), does it accept the Pi Durable release we run (its peer range must
 * include `PI_DURABLE_VERSION`), and are the programs its engine needs installed (`checkRuntimes`).
 * Only then is the package's entry point imported and its factory called, and its returned bundle
 * checked against the manifest (`checkAgent`).
 *
 * The factory is a role package's default export. It is called with the caller's overlays, approver,
 * an engine built from the manifest when the package declares one, and the named app clients the
 * caller passes (`calendar`, `quickbooks`, …). A role package keeps its own app clients; the host
 * decides which concrete client each name resolves to. See docs/design/agent-package.md.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type AgentManifest,
  type Approver,
  checkAgent,
  checkRuntimes,
  type Engine,
  engineFromManifest,
  formatIssue,
  type Issue,
  type RoleBundle,
  type RolePackage,
  supportsPiDurable,
  validatePackage,
} from "@officehum/sdk";
import { PI_DURABLE_VERSION } from "../version.js";

/** The names `loadRole` passes to a role factory itself; a client may not reuse them. */
export const RESERVED_ROLE_OPTIONS = ["overlays", "approve", "engine"] as const;

/** Options a host gives `loadRole`; everything here reaches the role's factory. */
export interface LoadRoleOptions {
  /** Overlay directories, lowest first, on top of the package. */
  readonly overlays?: readonly string[];
  /** Decides the role's gated actions. Omitted: they are blocked. */
  readonly approve?: Approver | undefined;
  /** The host's input-data directory, given to the engine as `OFFICEHUM_DATA_DIR`. */
  readonly dataDir?: string;
  /** The host's working directory, given to the engine as `OFFICEHUM_WORK_DIR`. */
  readonly workDir?: string;
  /** Named app clients the factory receives, e.g. `{ calendar, quickbooks }`. */
  readonly clients?: Readonly<Record<string, unknown>>;
}

/** A role package, validated and loaded: what a host installs into an office. */
export interface LoadedRole {
  readonly dir: string;
  readonly package: RolePackage;
  readonly manifest: AgentManifest;
  readonly bundle: RoleBundle;
  /** The engine built from the manifest, when it declares one; the operator commands use it too. */
  readonly engine?: Engine;
  /**
   * Re-reads the role's files and overlays, when the factory returned a `defineRole` result. The host
   * reconfigures the conversation with `bundle.agent` so any change takes effect.
   */
  readonly reload?: () => readonly Issue[];
}

type PackageManifest = {
  readonly main?: unknown;
  readonly exports?: unknown;
};

function issuesError(subject: string, issues: readonly Issue[]): Error {
  const lines = issues.map((issue) => `  ${formatIssue(issue)}`).join("\n");
  return new Error(`${subject}:\n${lines}`);
}

/** The package's entry point: the `exports` root, or `main`, resolved from the package directory. */
async function entryPoint(dir: string): Promise<string> {
  let manifest: PackageManifest;
  try {
    manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as PackageManifest;
  } catch (error) {
    throw new Error(`Could not read ${join(dir, "package.json")}: ${String(error)}`);
  }
  const entry = declaredEntry(manifest);
  if (entry === undefined) {
    throw new Error(
      `${join(dir, "package.json")} declares no entry point; add "exports" or "main" so the role can be loaded.`,
    );
  }
  return resolve(dir, entry);
}

function declaredEntry(manifest: PackageManifest): string | undefined {
  const { exports } = manifest;
  if (typeof exports === "string") return exports;
  if (exports !== null && typeof exports === "object") {
    const root = (exports as Record<string, unknown>)["."] ?? exports;
    if (typeof root === "string") return root;
    if (root !== null && typeof root === "object") {
      const condition = root as Record<string, unknown>;
      for (const key of ["import", "module", "default"]) {
        if (typeof condition[key] === "string") return condition[key] as string;
      }
    }
  }
  return typeof manifest.main === "string" ? manifest.main : undefined;
}

/**
 * Imports the resolved entry, adding context a bare Node `ERR_MODULE_NOT_FOUND` lacks. A published
 * role package ships compiled JavaScript; a package whose entry is TypeScript source (an SDK fixture,
 * or a checkout that has not been built) fails here with the reason spelled out.
 */
async function loadEntry(entry: string, name: string): Promise<unknown> {
  try {
    return await import(pathToFileURL(entry).href);
  } catch (error) {
    throw new Error(
      `Could not import ${name}'s entry point ${entry}: ${error instanceof Error ? error.message : String(error)}. ` +
        "A published role package ships compiled JavaScript; if this is a TypeScript source package, build it first.",
      { cause: error },
    );
  }
}

/**
 * Validates, imports and builds one role package. Refuses a package whose Pi Durable peer range
 * excludes this release, or whose required runtimes are missing, with every problem named at once.
 */
export async function loadRole(dir: string, options: LoadRoleOptions = {}): Promise<LoadedRole> {
  const checked = await validatePackage(dir);
  if (!checked.ok) throw issuesError(`The role package in ${dir} is not valid`, checked.issues);
  const rolePackage = checked.value;
  const { manifest } = rolePackage;

  if (!supportsPiDurable(rolePackage.piDurableRange, PI_DURABLE_VERSION)) {
    throw new Error(
      `${rolePackage.name} ${rolePackage.version} supports Pi Durable ${rolePackage.piDurableRange}, ` +
        `but this Office runs ${PI_DURABLE_VERSION}. Ask the role's author to widen its ` +
        `@earendil-works/pi-durable peer range, e.g. "${PI_DURABLE_VERSION.split(".").slice(0, 2).join(".")}.x".`,
    );
  }

  const runtimeIssues = await checkRuntimes(manifest);
  if (runtimeIssues.length > 0) {
    throw issuesError(`${rolePackage.name} needs programs this machine is missing`, runtimeIssues);
  }

  const engine =
    manifest.engine === undefined
      ? undefined
      : engineFromManifest(dir, manifest, {
          ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
          ...(options.workDir === undefined ? {} : { workDir: options.workDir }),
        });

  const clients = options.clients ?? {};
  for (const name of RESERVED_ROLE_OPTIONS) {
    if (name in clients) {
      throw new Error(
        `The client named "${name}" is reserved: loadRole passes ${RESERVED_ROLE_OPTIONS.map((value) => `"${value}"`).join(", ")} to the role itself. Rename the client.`,
      );
    }
  }

  const factoryOptions: Record<string, unknown> = { ...clients };
  if (options.overlays !== undefined) factoryOptions.overlays = options.overlays;
  if (options.approve !== undefined) factoryOptions.approve = options.approve;
  if (engine !== undefined) factoryOptions.engine = engine;

  const entry = await entryPoint(dir);
  const module = (await loadEntry(entry, rolePackage.name)) as { default?: unknown };
  const factory = module.default;
  if (typeof factory !== "function") {
    throw new Error(
      `The default export of ${rolePackage.name} is not a function; a role package must export a factory returning its bundle.`,
    );
  }

  const bundle = (factory as (value: Record<string, unknown>) => RoleBundle)(factoryOptions);
  const agent = checkAgent(bundle, manifest);
  if (!agent.ok)
    throw issuesError(
      `The ${rolePackage.name} factory returned an inconsistent bundle`,
      agent.issues,
    );

  const reload = (bundle as unknown as { reload?: unknown }).reload;
  return {
    dir,
    package: rolePackage,
    manifest,
    bundle,
    ...(engine === undefined ? {} : { engine }),
    ...(typeof reload === "function"
      ? { reload: () => (bundle as unknown as { reload: () => readonly Issue[] }).reload() }
      : {}),
  };
}
