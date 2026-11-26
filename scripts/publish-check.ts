/**
 * The pre-publish check: what must hold before any `@officehum/*` package goes to npm.
 * `publish-check.test.ts` runs it in the normal suite, and `npm run publish-check` runs it on its own
 * (the release job runs it before publishing). It reads the built `dist/` folders, so it runs after
 * `npm run build`.
 *
 * - **Metadata.** Every publishable workspace carries the repository's licence (field and `LICENSE`
 *   file), a README, `repository` with its directory, `engines`, Pi keywords and a public, provenance-
 *   signed `publishConfig`. A sibling dependency is pinned to that sibling's version (never `*` or a
 *   `workspace:` range, which npm would publish as written), and never names a private workspace. The
 *   changesets ignore list is exactly the private workspaces.
 * - **Tarballs.** What `npm pack` would ship holds the package's entry points, README and licence, and
 *   no tests, fixtures, env files or secrets (common API key and token shapes, and PEM private
 *   keys), and no source map that points outside the package.
 * - **Roles.** `validatePackage` passes on every role in `agents/`.
 * - **Bare install.** Each role, packed with the `@officehum/*` packages it depends on, loads in a
 *   fresh project holding only those tarballs and the third-party packages a role may use (Pi
 *   Durable, pi-ai, pi-schema, chord, typebox, semver, yaml), linked from this repository's
 *   `node_modules`.
 *   Nothing is fetched: Node's own resolution has to find every import in that project, and
 *   `validatePackage` runs again on the installed copy, so a file missing from `files` fails here.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { formatIssue, validatePackage } from "@officehum/sdk";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** One problem, with the package it belongs to. */
export interface PublishIssue {
  readonly package: string;
  readonly message: string;
}

interface PackageJson {
  readonly name: string;
  readonly version: string;
  readonly private?: boolean;
  readonly license?: string;
  readonly main?: string;
  readonly bin?: string | Record<string, string>;
  readonly exports?: unknown;
  readonly files?: readonly string[];
  readonly keywords?: readonly string[];
  readonly engines?: { readonly node?: string };
  readonly repository?: { readonly url?: string; readonly directory?: string };
  readonly publishConfig?: { readonly access?: string; readonly provenance?: boolean };
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

/** A workspace: its directory relative to the repository root, and its package.json. */
export interface Workspace {
  readonly dir: string;
  readonly pkg: PackageJson;
}

/** Third-party packages a role's installed dependency closure may contain, besides `@officehum/*`. */
export const ROLE_THIRD_PARTY = [
  "@earendil-works/pi-durable",
  "@earendil-works/pi-ai",
  // Every role takes pi-schema as a peer: Pi Durable reads the tool schemas it builds.
  "@earendil-works/pi-schema",
  // Pi Durable's own object runtime, which it always installs; a role whose published types name its
  // `Context` takes it as a peer, as it takes Pi Durable.
  "@earendil-works/chord",
  "typebox",
  "semver",
  "yaml",
] as const;

/** Keywords every published package carries, so it is found next to other Pi packages. */
export const REQUIRED_KEYWORDS = ["officehum", "pi-durable"] as const;

/** Every workspace the root package.json lists, in directory order. */
export function workspaces(): Workspace[] {
  const rootPkg = readJson<{ workspaces: string[] }>(join(root, "package.json"));
  return rootPkg.workspaces.flatMap((pattern) => {
    const parent = pattern.replace(/\/\*$/, "");
    return readdirSync(join(root, parent))
      .map((name) => `${parent}/${name}`)
      .filter((dir) => existsSync(join(root, dir, "package.json")))
      .sort()
      .map((dir) => ({ dir, pkg: readJson<PackageJson>(join(root, dir, "package.json")) }));
  });
}

/** Package metadata, sibling ranges, private dependencies and the changesets ignore list. */
export function metadataIssues(all: readonly Workspace[] = workspaces()): PublishIssue[] {
  const issues: PublishIssue[] = [];
  const rootLicense = readJson<{ license?: string }>(join(root, "package.json")).license;
  const licenseText = readFileSync(join(root, "LICENSE"), "utf8");
  const byName = new Map(all.map((workspace) => [workspace.pkg.name, workspace]));

  for (const { dir, pkg } of all) {
    if (pkg.private === true) continue;
    const add = (message: string): void => {
      issues.push({ package: pkg.name, message });
    };
    if (pkg.license !== rootLicense) {
      add(`license is ${show(pkg.license)}; set it to the repository's ${show(rootLicense)}`);
    }
    const licenseFile = join(root, dir, "LICENSE");
    if (!existsSync(licenseFile)) add(`${dir}/LICENSE is missing; copy the root LICENSE into it`);
    else if (readFileSync(licenseFile, "utf8") !== licenseText) {
      add(`${dir}/LICENSE differs from the root LICENSE; copy the root one over it`);
    }
    if (!existsSync(join(root, dir, "README.md"))) add(`${dir}/README.md is missing`);
    if (pkg.repository?.directory !== dir || pkg.repository.url === undefined) {
      add(`repository must give the git url and "directory": ${show(dir)}`);
    }
    if (pkg.engines?.node === undefined) add('engines.node is missing, e.g. ">=22.19.0"');
    if (pkg.files === undefined || pkg.files.length === 0) {
      add('files is missing; list what the tarball ships, e.g. ["dist"]');
    }
    if (pkg.publishConfig?.access !== "public" || pkg.publishConfig.provenance !== true) {
      add('publishConfig must be { "access": "public", "provenance": true }');
    }
    for (const keyword of REQUIRED_KEYWORDS) {
      if (!pkg.keywords?.includes(keyword)) add(`keywords must include ${show(keyword)}`);
    }

    const shipped = {
      dependencies: pkg.dependencies,
      peerDependencies: pkg.peerDependencies,
      optionalDependencies: pkg.optionalDependencies,
    };
    for (const [field, deps] of Object.entries(shipped)) {
      for (const [name, range] of Object.entries(deps ?? {})) {
        const sibling = byName.get(name);
        if (sibling === undefined) continue;
        if (sibling.pkg.private === true) {
          add(`${field}.${name}: ${name} is private and never published; drop the dependency`);
        } else if (range !== sibling.pkg.version) {
          add(
            `${field}.${name} is ${show(range)}; pin it to ${show(sibling.pkg.version)}, the version in ${sibling.dir} (npm publishes the range as written, and changesets moves the pin on release)`,
          );
        }
      }
    }
  }

  const ignored = [...readJson<{ ignore: string[] }>(join(root, ".changeset/config.json")).ignore];
  const privateNames = all.filter(({ pkg }) => pkg.private === true).map(({ pkg }) => pkg.name);
  if (JSON.stringify(ignored.sort()) !== JSON.stringify(privateNames.sort())) {
    issues.push({
      package: ".changeset/config.json",
      message: `ignore is ${show(ignored)}; it must list exactly the private workspaces ${show(privateNames)}`,
    });
  }
  return issues;
}

/** Common API key and token shapes, and PEM private keys. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|sk_live_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,}|AKIA[0-9A-Z]{16}|xox[abpr]-[0-9A-Za-z-]{10,}|AIza[0-9A-Za-z_-]{35}|PAPERINSTRUMENTS_API_KEY=[^\s"]+|OFFICEHUM_SECRET_KEY=[^\s"]+/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:\\n|\s)*[A-Za-z0-9+/]{40,}/g,
];
/**
 * Not key material: AWS's documented example key id, and a documented variable set to a placeholder
 * (`PAPERINSTRUMENTS_API_KEY=...`, `=<key>`, `=$KEY`), as READMEs show them.
 */
const SECRET_ALLOWED = /^AKIA[0-9A-Z]{9}EXAMPLE$|=(?:\.{3}|<[^>]*>|\$\{?[A-Z_]+\}?)[`'.,;)]*$/;

/** How many secret-shaped strings `text` holds, placeholders aside. */
export function secretShapes(text: string): number {
  let found = 0;
  for (const pattern of SECRET_PATTERNS) {
    for (const match of text.matchAll(pattern)) if (!SECRET_ALLOWED.test(match[0])) found += 1;
  }
  return found;
}

/** File names a tarball must never hold. */
const FORBIDDEN_FILES: readonly [RegExp, string][] = [
  [/\.(?:test|spec)\.[cm]?[jt]sx?(?:\.map)?$|\.test\.d\.[cm]?ts$/, "a test"],
  [/(?:^|\/)(?:fixtures|__fixtures__|__tests__)\//, "a fixture"],
  [/(?:^|\/)test-helpers\./, "a test helper"],
  [/(?:^|\/)\.env(?:\.[^/]*)?$/, "an env file"],
  [/(?:^|\/)\.npmrc$/, "an npm config"],
  [/(?:^|\/)__pycache__\/|\.pyc$/, "Python bytecode"],
];

interface PackResult {
  readonly name: string;
  readonly files: readonly { readonly path: string }[];
}

/** What `npm pack` would ship for every workspace, without writing a tarball. */
export function dryRunPack(): Map<string, string[]> {
  const out = npm(["pack", "--dry-run", "--json", "--ignore-scripts", "--workspaces"], root);
  const results = JSON.parse(out) as PackResult[];
  return new Map(results.map((result) => [result.name, result.files.map((file) => file.path)]));
}

/** Tarball contents of every publishable workspace: entry points, README, licence, nothing private. */
export function tarballIssues(
  all: readonly Workspace[] = workspaces(),
  packed: ReadonlyMap<string, readonly string[]> = dryRunPack(),
): PublishIssue[] {
  const issues: PublishIssue[] = [];
  for (const { dir, pkg } of all) {
    if (pkg.private === true) continue;
    const add = (message: string): void => {
      issues.push({ package: pkg.name, message });
    };
    const files = packed.get(pkg.name);
    if (files === undefined) {
      add("npm pack did not list it");
      continue;
    }
    const shipped = new Set(files);
    for (const required of ["package.json", "README.md", "LICENSE"]) {
      if (!shipped.has(required)) add(`the tarball has no ${required}`);
    }
    if (!files.some((file) => file.startsWith("dist/"))) {
      add("the tarball has no dist/; run npm run build first");
    }
    for (const entry of entryPoints(pkg)) {
      if (!shipped.has(entry)) add(`the tarball has no ${entry}, which package.json points at`);
    }
    for (const file of files) {
      const forbidden = FORBIDDEN_FILES.find(([pattern]) => pattern.test(file));
      if (forbidden !== undefined) add(`the tarball ships ${file}, ${forbidden[1]}`);
      const absolute = join(root, dir, file);
      const bytes = readFileSync(absolute);
      if (bytes.subarray(0, 8000).includes(0)) continue;
      const text = bytes.toString("utf8");
      // Never echo the match: a real secret must not reach a log.
      const found = secretShapes(text);
      if (found > 0) add(`${file} holds ${found} string(s) shaped like a secret; remove them`);
      if (file.endsWith(".map")) {
        for (const source of mapSources(text)) {
          const target = resolve(dirname(absolute), source);
          if (
            isAbsolute(source) ||
            /^[a-z]+:\/\//i.test(source) ||
            !inside(join(root, dir), target)
          ) {
            add(`${file} names a source outside the package: ${source}`);
          }
        }
      }
    }
  }
  return issues;
}

/** `validatePackage` on every role in `agents/`. */
export async function roleIssues(
  all: readonly Workspace[] = workspaces(),
): Promise<PublishIssue[]> {
  const issues: PublishIssue[] = [];
  for (const { dir, pkg } of all.filter(isRole)) {
    const result = await validatePackage(join(root, dir));
    if (!result.ok) {
      for (const issue of result.issues) {
        issues.push({ package: pkg.name, message: `validatePackage: ${formatIssue(issue)}` });
      }
    }
  }
  return issues;
}

/**
 * Packs every role and the `@officehum/*` packages they depend on, then, for each role, builds a
 * fresh project from its tarballs and the allowed third-party packages and loads it there.
 */
export function bareInstallIssues(all: readonly Workspace[] = workspaces()): PublishIssue[] {
  const issues: PublishIssue[] = [];
  const byName = new Map(all.map((workspace) => [workspace.pkg.name, workspace]));
  const roles = all.filter(isRole);
  const work = mkdtempSync(join(tmpdir(), "officehum-publish-check-"));
  try {
    // Pack each role's @officehum closure once, all in one npm call.
    const wanted = new Set<string>();
    for (const role of roles) for (const name of siblingClosure(role.pkg, byName)) wanted.add(name);
    const tarballs = join(work, "tarballs");
    mkdirSync(tarballs);
    const out = npm(
      [
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        tarballs,
        ...[...wanted].flatMap((name) => ["-w", name]),
      ],
      root,
    );
    const tarballOf = new Map(
      (JSON.parse(out) as { name: string; filename: string }[]).map((entry) => [
        entry.name,
        join(tarballs, entry.filename),
      ]),
    );

    for (const role of roles) {
      const add = (message: string): void => {
        issues.push({ package: role.pkg.name, message });
      };
      const project = join(work, role.pkg.name.replace("@officehum/", ""));
      const modules = join(project, "node_modules");
      mkdirSync(join(modules, "@officehum"), { recursive: true });
      writeFileSync(
        join(project, "package.json"),
        `${JSON.stringify({ name: "bare-harness", private: true, type: "module" })}\n`,
      );

      // Install: unpack each tarball where npm would put it, and read what it really declares.
      const installed: PackageJson[] = [];
      for (const name of siblingClosure(role.pkg, byName)) {
        const tarball = tarballOf.get(name);
        if (tarball === undefined) {
          add(`npm pack produced no tarball for ${name}`);
          continue;
        }
        const target = join(modules, name);
        mkdirSync(target, { recursive: true });
        run("tar", ["-xzf", tarball, "-C", target, "--strip-components=1"], project);
        installed.push(readJson<PackageJson>(join(target, "package.json")));
      }

      // The structural check: the closure, as published, needs nothing beyond the allowed set.
      const thirdParty = new Set<string>();
      for (const pkg of installed) {
        for (const name of requiredDependencies(pkg)) {
          if (name.startsWith("@officehum/")) {
            if (!existsSync(join(modules, name))) add(`${pkg.name} needs ${name}, not installed`);
          } else if (!(ROLE_THIRD_PARTY as readonly string[]).includes(name)) {
            add(
              `${pkg.name} depends on ${name}; a role may bring only ${ROLE_THIRD_PARTY.join(", ")}`,
            );
          } else thirdParty.add(name);
        }
      }
      for (const name of thirdParty) {
        mkdirSync(dirname(join(modules, name)), { recursive: true });
        symlinkSync(join(root, "node_modules", name), join(modules, name), "dir");
      }

      const loader = join(project, "load.mjs");
      writeFileSync(loader, LOADER);
      const result = spawnSync(process.execPath, [loader, role.pkg.name], {
        cwd: project,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "" },
      });
      if (result.status !== 0) {
        const output = result.stderr || result.stdout;
        // The thrown error from its first line on, without Node's source excerpt above it.
        const error = output.slice(Math.max(0, output.search(/^\w*Error\b/m))).trim();
        add(`does not load in a bare project: ${error}`);
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return issues;
}

/**
 * Runs in the bare project: imports the role through Node's resolution, from that project alone,
 * and validates the installed copy with the installed SDK.
 */
const LOADER = `import { fileURLToPath } from "node:url";
import { join } from "node:path";
const name = process.argv[2];
const role = await import(name);
if (typeof role.default !== "function") throw new Error(name + " has no default export to build the role");
const { validatePackage, formatIssue } = await import("@officehum/sdk");
const dir = join(fileURLToPath(new URL(".", import.meta.url)), "node_modules", name);
const result = await validatePackage(dir);
if (!result.ok) throw new Error(result.issues.map(formatIssue).join("\\n"));
`;

/** Every check, in order. */
export async function publishIssues(): Promise<PublishIssue[]> {
  const all = workspaces();
  return [
    ...metadataIssues(all),
    ...tarballIssues(all),
    ...(await roleIssues(all)),
    ...bareInstallIssues(all),
  ];
}

function isRole({ dir, pkg }: Workspace): boolean {
  return dir.startsWith("agents/") && pkg.private !== true;
}

/** The package and every `@officehum/*` workspace it needs at runtime, transitively. */
function siblingClosure(pkg: PackageJson, byName: ReadonlyMap<string, Workspace>): string[] {
  const seen = new Set<string>([pkg.name]);
  const queue = [pkg];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const name of requiredDependencies(next)) {
      const sibling = byName.get(name);
      if (sibling !== undefined && !seen.has(name)) {
        seen.add(name);
        queue.push(sibling.pkg);
      }
    }
  }
  return [...seen];
}

/** Dependencies and non-optional peers: what an install must provide. */
function requiredDependencies(pkg: PackageJson): string[] {
  const peers = Object.keys(pkg.peerDependencies ?? {}).filter(
    (name) => pkg.peerDependenciesMeta?.[name]?.optional !== true,
  );
  return [...Object.keys(pkg.dependencies ?? {}), ...peers];
}

/** The files `main`, `bin` and string `exports` targets point at, as tarball paths. */
function entryPoints(pkg: PackageJson): string[] {
  const targets: string[] = [];
  if (pkg.main !== undefined) targets.push(pkg.main);
  if (typeof pkg.bin === "string") targets.push(pkg.bin);
  else if (pkg.bin !== undefined) targets.push(...Object.values(pkg.bin));
  const walk = (value: unknown): void => {
    if (typeof value === "string") targets.push(value);
    else if (typeof value === "object" && value !== null) Object.values(value).forEach(walk);
  };
  walk(pkg.exports);
  return [...new Set(targets.filter((target) => !target.includes("*")))].map((target) =>
    target.replace(/^\.\//, ""),
  );
}

function mapSources(text: string): string[] {
  try {
    const sources = (JSON.parse(text) as { sources?: unknown }).sources;
    return Array.isArray(sources) ? sources.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

function inside(parent: string, path: string): boolean {
  const rel = relative(parent, path);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

function npm(args: readonly string[], cwd: string): string {
  return run("npm", args, cwd);
}

function run(command: string, args: readonly string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.stderr || result.error?.message}`,
    );
  }
  return result.stdout;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function show(value: unknown): string {
  return JSON.stringify(value) ?? "undefined";
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const issues = await publishIssues();
  for (const issue of issues) console.error(`${issue.package}: ${issue.message}`);
  if (issues.length > 0) {
    console.error(
      `publish-check: ${issues.length} problem(s); nothing may be published until they are fixed.`,
    );
    process.exit(1);
  }
  console.log("publish-check: every publishable package is ready.");
}
