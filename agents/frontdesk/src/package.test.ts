/**
 * Front Desk as another company would install it: nothing outside the generated handbook names the
 * default company, its people, their titles or its crews.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCompanyFacts } from "@officehum/sdk";
import { describe, expect, it } from "vitest";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));

interface Facts {
  readonly profile: {
    readonly legalName: string;
    readonly tradingName: string;
    readonly address: { readonly city: string };
  };
  readonly people: readonly { readonly name: string; readonly title: string }[];
  readonly crews?: readonly { readonly name: string }[];
}

const company = loadCompanyFacts<Facts>(
  new URL("../skills/company-handbook/references/facts.json", import.meta.url),
);

describe("frontdesk package", () => {
  it("names no company fact outside the generated handbook, so another company can run it", () => {
    // The company's facts reach the model only through the generated handbook. The evals and the
    // smoke script run against the default company (Northwind), as every role's do, so they may
    // name its people and titles; the README describes that demo. Everything else must read the
    // same for any company. Titles count as well as names: "Finance and Billing" in a skill is as
    // company-specific as "Eileen Hart". Department ids ("office", "maintenance") are plain words
    // and are left out; the titles and crew names are where a department is spelled out.
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
    expect(files.length).toBeGreaterThan(8);

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
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const fact of new Set(facts)) {
        const pattern = new RegExp(`\\b${fact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
        if (pattern.test(text)) found.push(`${relative(packageDirectory, file)}: ${fact}`);
      }
    }
    expect(found).toEqual([]);
  });
});
