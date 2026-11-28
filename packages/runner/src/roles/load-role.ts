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
 * clock (`now`), verified sender (`sender`), whether to run on demonstration data (`demo`), an
 * engine built from the manifest when the package declares one, the tool packs the host supplies for
 * the tools its manifest declares with `"pack"` (`packs`), and the named app clients the caller
 * passes (`calendar`, `quickbooks`, …). A role package keeps its own app clients; the host decides
 * which concrete client each name resolves to. See docs/design/agent-package.md.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type AgentManifest,
  type ApprovalFactsReader,
  type Approver,
  type CompanyRecord,
  checkAgent,
  checkRuntimes,
  type Engine,
  engineFromManifest,
  formatIssue,
  type Issue,
  type ResolvedRole,
  type RoleBundle,
  type RolePackage,
  type SenderResolver,
  supportsPiDurable,
  type ToolPack,
  validatePackage,
} from "@officehum/sdk";
import { PI_DURABLE_VERSION } from "../version.js";

/** The names `loadRole` passes to a role factory itself; a client may not reuse them. */
export const RESERVED_ROLE_OPTIONS = [
  "overlays",
  "approve",
  "engine",
  "now",
  "sender",
  "demo",
  "company",
  "packs",
] as const;

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
  /**
   * The host's clock, passed to the factory as `now`: the role dates its prompt's `today` section
   * and its desk's records from it. Omitted: the role's own default.
   */
  readonly now?: () => Date;
  /**
   * Who is asking, passed to the factory as `sender`: the host's verified answer for each call (the
   * runtime's is `RuntimeSenders`, office-mode evals' `boardSenderResolver`). Reserved, so a client
   * or a user's config can never supply a
   * sender of its own. Omitted: the role treats every sender as unknown.
   */
  readonly sender?: SenderResolver;
  /**
   * Run on the role's demonstration data, passed to the factory as `demo`: a role that keeps its
   * records behind a desk builds its demonstration desk only when this is set and the host binds no
   * desk of its own. Reserved, so a client file or a user's config can never switch a production
   * role onto made-up records. Omitted: a role with no desk bound refuses its desk tools.
   */
  readonly demo?: boolean;
  /**
   * The company the role works for, passed to the factory as `company`: an installed
   * office's own (`roleCompanyFacts`), never the sample company's. Reserved, so no client file can
   * swap it. Omitted (a demo, an eval): the role reads the company generated into its package.
   */
  readonly company?: CompanyRecord;
  /**
   * The tool packs the host supplies this role, built once its manifest is read, passed
   * to the factory as `packs`: the role offers the pack tools its manifest declares from them, and
   * `checkAgent` then requires those. Reserved, so no client can supply tools of its own this way.
   * Omitted, or none built: the role loads without any pack and offers none of their tools.
   */
  readonly packs?: (manifest: AgentManifest) => readonly ToolPack[];
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
   * The role's approval facts readers, keyed by approval id, when its factory returned a `defineRole`
   * result (`DefinedRole.approvalFacts`); `{}` otherwise. The office's gate reads the same facts the
   * role's own gate does, so the Inbox shows what a person approves and a grant binds the tool to it.
   */
  readonly approvalFacts: Readonly<Record<string, ApprovalFactsReader>>;
  /**
   * Re-reads the role's files and overlays, when the factory returned a `defineRole` result. The host
   * reconfigures the conversation with `bundle.agent` so any change takes effect.
   */
  readonly reload?: () => readonly Issue[];
  /**
   * What the agent currently sees, overlays applied, when the factory returned a `defineRole` result
   * (`DefinedRole.current`). The office directory builds the agent's card from it.
   */
  readonly current?: () => ResolvedRole;
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
 * Imports the resolved entry, adding context a bare Node error lacks. Node 22.19+ strips TypeScript
 * types itself, so an entry that is TypeScript source (a package `officehum-role generate` wrote
 * inside a clone) loads directly when it uses only erasable syntax and sits outside `node_modules`.
 * Under `node_modules` Node refuses to strip types, so an installed package must ship compiled
 * JavaScript.
 */
async function loadEntry(entry: string, name: string): Promise<unknown> {
  try {
    return await import(pathToFileURL(entry).href);
  } catch (error) {
    throw new Error(
      `Could not import ${name}'s entry point ${entry}: ${error instanceof Error ? error.message : String(error)}. ` +
        "Check that the package can resolve its dependencies (such as @officehum/sdk) from where it sits, " +
        "for example by generating it inside a clone of this repository. A TypeScript source entry loads " +
        "directly only outside node_modules; a package installed under node_modules must ship compiled JavaScript.",
      { cause: error },
    );
  }
}

/**
 * Validates, imports and builds one role package. Refuses a package whose Pi Durable peer range
 * excludes this release, or whose required runtimes are missing, with every problem named at once.
 */
/**
 * The first of `overlays` that is not a shared layer (`@office`, `@department-…`) and holds a
 * `company-handbook` skill: an agent's own overlay with an old copy that would shadow an installed
 * office's own handbook (security review L3). `undefined` when none does.
 */
export function reservedHandbookOverlay(overlays: readonly string[]): string | undefined {
  return overlays.find(
    (dir) => !basename(dir).startsWith("@") && existsSync(join(dir, "skills", "company-handbook")),
  );
}

export async function loadRole(dir: string, options: LoadRoleOptions = {}): Promise<LoadedRole> {
  // In an installed office the office's own handbook is the only one: an agent's overlay that still
  // holds one is refused, naming it, rather than shadowing the office's.
  const shadow =
    options.company === undefined ? undefined : reservedHandbookOverlay(options.overlays ?? []);
  if (shadow !== undefined) {
    throw new Error(
      `The overlay ${shadow} holds a company-handbook skill, which only the office writes from its company record; remove skills/company-handbook from it, then start the office again.`,
    );
  }
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
  if (options.now !== undefined) factoryOptions.now = options.now;
  if (options.sender !== undefined) factoryOptions.sender = options.sender;
  if (options.demo !== undefined) factoryOptions.demo = options.demo;
  if (options.company !== undefined) factoryOptions.company = options.company;
  const packs = options.packs?.(manifest) ?? [];
  if (packs.length > 0) factoryOptions.packs = packs;

  const entry = await entryPoint(dir);
  const module = (await loadEntry(entry, rolePackage.name)) as { default?: unknown };
  const factory = module.default;
  if (typeof factory !== "function") {
    throw new Error(
      `The default export of ${rolePackage.name} is not a function; a role package must export a factory returning its bundle.`,
    );
  }

  const bundle = (factory as (value: Record<string, unknown>) => RoleBundle)(factoryOptions);
  const agent = await checkAgent(bundle, manifest, { packs: packs.map((pack) => pack.id) });
  if (!agent.ok)
    throw issuesError(
      `The ${rolePackage.name} factory returned an inconsistent bundle`,
      agent.issues,
    );

  const reload = (bundle as unknown as { reload?: unknown }).reload;
  const current = (bundle as unknown as { current?: unknown }).current;
  return {
    dir,
    package: rolePackage,
    manifest,
    bundle,
    approvalFacts: approvalFactsOf(bundle),
    ...(engine === undefined ? {} : { engine }),
    ...(typeof reload === "function"
      ? { reload: () => (bundle as unknown as { reload: () => readonly Issue[] }).reload() }
      : {}),
    ...(typeof current === "function"
      ? { current: () => (bundle as unknown as { current: () => ResolvedRole }).current() }
      : {}),
  };
}

/**
 * The readers a bundle exposes, keyed by approval id. Read by shape rather than by type: the bundle
 * may come from a different copy of the SDK than this host's, and a reader is only ever a function.
 */
function approvalFactsOf(bundle: RoleBundle): Readonly<Record<string, ApprovalFactsReader>> {
  const declared = (bundle as unknown as { approvalFacts?: unknown }).approvalFacts;
  if (declared === null || typeof declared !== "object") return {};
  return Object.fromEntries(
    Object.entries(declared).filter(([, reader]) => typeof reader === "function"),
  ) as Record<string, ApprovalFactsReader>;
}
