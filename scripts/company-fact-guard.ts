/**
 * The company-fact guard every catalog role's package test calls: nothing outside the generated
 * handbook names the default company, its people, their titles or its crews, so another company can
 * install the role and read the same prose.
 *
 * It lives here rather than in `@officehum/sdk` so no role gains a runtime dependency for a test, and
 * it reads the same generated `facts.json` the role's own code reads.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

interface Facts {
  readonly profile: {
    readonly legalName: string;
    readonly tradingName: string;
    readonly address: { readonly city: string };
  };
  readonly people: readonly { readonly name: string; readonly title: string }[];
  readonly crews?: readonly { readonly name: string }[];
}

/**
 * Every company fact found in a role package outside its generated handbook, as `"<file>: <fact>"`.
 *
 * The company's facts reach the model only through the generated handbook. The evals and the smoke
 * script run against the default company, as every role's do, so they may name its people and
 * titles, and the README describes that demo. Everything else must read the same for any company.
 * Titles count as well as names: "Finance and Billing" in a skill is as company-specific as a
 * person's name. Department ids ("office", "maintenance") are plain words and are left out; the titles
 * and crew names are where a department is spelled out.
 *
 * A fact is matched as whole words, ignoring case, with any run of whitespace between its words, so a
 * title wrapped across two lines of Markdown is still found.
 *
 * `allow` lists what is this package's own words rather than the company's. An entry is either a
 * fact, allowed anywhere in the package (a role named "People Ops" may say "People Ops" although one
 * person's title is the same words), or one finding exactly as this function reports it,
 * `"<file>: <fact>"`, allowed in that file only (demonstration data, a generic title pattern). An
 * entry that matches nothing is reported as `"allow entry matches nothing: <entry>"`.
 */
export function companyFactLeaks(
  packageDirectory: string,
  options: { readonly allow?: readonly string[] } = {},
): readonly string[] {
  const company = JSON.parse(
    readFileSync(
      join(packageDirectory, "skills", "company-handbook", "references", "facts.json"),
      "utf8",
    ),
  ) as Facts;
  const skipped = new Set(["dist", "node_modules", "evals", "evals.smoke.json", "README.md"]);
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const local = relative(packageDirectory, path);
      if (skipped.has(entry.name) || local === join("skills", "company-handbook")) continue;
      if (entry.isDirectory()) walk(path);
      else if (!entry.name.endsWith(".test.ts")) files.push(path);
    }
  };
  walk(packageDirectory);
  if (files.length < 5) {
    throw new Error(
      `${packageDirectory} holds only ${files.length} files to check; point the guard at the role package's root directory.`,
    );
  }

  const allowed = new Set((options.allow ?? []).map((entry) => entry.toLowerCase()));
  const facts = [
    company.profile.legalName,
    company.profile.tradingName,
    company.profile.address.city,
    ...company.people.flatMap((worker) => [
      worker.name,
      worker.name.split(" ")[0] ?? "",
      worker.title,
    ]),
    ...(company.crews ?? []).map((crew) => crew.name),
  ].filter((fact) => fact !== "");
  const found: string[] = [];
  // An allow entry that matches nothing is stale, and would hide a future leak: report it too.
  const used = new Set<string>();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const fact of new Set(facts)) {
      const pattern = new RegExp(
        `(?<![\\w])${fact
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          .split(/\s+/)
          .join("\\s+")}(?![\\w])`,
        "i",
      );
      if (!pattern.test(text)) continue;
      const finding = `${relative(packageDirectory, file)}: ${fact}`;
      if (allowed.has(fact.toLowerCase())) used.add(fact.toLowerCase());
      else if (allowed.has(finding.toLowerCase())) used.add(finding.toLowerCase());
      else found.push(finding);
    }
  }
  for (const entry of options.allow ?? []) {
    if (!used.has(entry.toLowerCase())) found.push(`allow entry matches nothing: ${entry}`);
  }
  return found;
}
