/**
 * A catalog role on a company that has only who it is: no price book, catalogue, crews,
 * policies or other role data. An office's own record will be like this until the office adds its
 * data, so each role must still build, render its prompt, and answer a tool that needs a missing
 * section with the SDK's one plain refusal rather than a crash or another company's data.
 *
 * The company is the default one with every role-data section taken out (`COMPANY_DATA_SECTIONS`);
 * who it is (profile, hours, people, ticket routes, escalation) stays. Roles are built with no desk,
 * as an office with nothing connected builds them.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import {
  COMPANY_DATA_SECTIONS,
  type CompanyDataSection,
  missingCompanyDataText,
} from "../packages/sdk/src/company-data.ts";
import { freeCatalogRole } from "./company.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

interface Tool {
  readonly name: string;
  readonly parameters?: unknown;
  execute(args: unknown, call: unknown, context: unknown): Promise<unknown>;
}

interface Bundle {
  readonly extensions: readonly {
    readonly tools?: readonly Tool[];
    readonly sections?: readonly {
      readonly key: string;
      render(a: unknown, b: unknown): unknown;
    }[];
  }[];
}

/** The default company with every section of role data removed. */
function identityOnly(): Record<string, unknown> {
  const company = JSON.parse(
    readFileSync(join(ROOT, "company", "default", "company.json"), "utf8"),
  ) as Record<string, unknown>;
  for (const section of Object.keys(COMPANY_DATA_SECTIONS)) delete company[section];
  // The role-specific sections the shared record type does not name.
  for (const section of ["payroll", "inventory", "quality", "safety", "it", "budget"]) {
    delete company[section];
  }
  return company;
}

/** The catalog roles whose factory takes a `company`. */
function roles(): string[] {
  return readdirSync(join(ROOT, "agents"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && freeCatalogRole(join(ROOT, "agents", entry.name)))
    .map((entry) => entry.name)
    .filter((name) => {
      try {
        return readFileSync(join(ROOT, "agents", name, "src", "company.ts"), "utf8").length > 0;
      } catch {
        return false;
      }
    })
    .sort();
}

async function build(role: string): Promise<Bundle> {
  const url = pathToFileURL(join(ROOT, "agents", role, "src", "index.ts")).href;
  const factory = (await import(url)).default as (options: Record<string, unknown>) => Bundle;
  return factory({ company: identityOnly() });
}

function sectionsOf(tool: Tool): string[] {
  const schema = tool.parameters as {
    properties?: { section?: { enum?: string[]; anyOf?: { const?: string }[] } };
  };
  const section = schema.properties?.section;
  return section?.enum ?? (section?.anyOf ?? []).flatMap((entry) => entry.const ?? []);
}

const call = { conversationId: "c", taskId: "t", callId: "x" };

describe("a catalog role on a company with no role data", () => {
  for (const role of roles()) {
    it(`${role} builds, renders its prompt, and refuses plainly where it needs data`, async () => {
      const bundle = await build(role);
      const declared =
        (
          JSON.parse(readFileSync(join(ROOT, "agents", role, "officehum.json"), "utf8")) as {
            company?: { data?: string[] };
          }
        ).company?.data ?? [];
      for (const extension of bundle.extensions) {
        for (const section of extension.sections ?? []) await section.render({}, {});
      }
      const tools = bundle.extensions.flatMap((extension) => [...(extension.tools ?? [])]);
      const readCompany = tools.find((tool) => tool.name === "read_company");
      if (readCompany === undefined) return;
      for (const section of sectionsOf(readCompany)) {
        const result = (await readCompany.execute({ section }, call, BACKGROUND_CONTEXT)) as {
          output: { text: string }[];
          isError?: boolean;
          details?: { code?: string; section?: CompanyDataSection };
        };
        if (result.isError === true) {
          expect(result.details?.code, `${role} ${section}`).toBe("company_data_missing");
          const missing = result.details?.section as CompanyDataSection;
          expect(result.output[0]?.text).toBe(missingCompanyDataText(missing));
          // The manifest declares every section its tools read: what the office is
          // told is missing at install and in \`officehum check\`.
          expect(
            declared,
            `${role} reads ${missing} but its manifest does not declare it`,
          ).toContain(missing);
        }
      }
    });
  }
});
