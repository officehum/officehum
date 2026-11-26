import { defineTool } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";
import {
  COMPANY_DATA_SECTIONS,
  CompanyDataMissing,
  companyData,
  missingCompanyDataText,
} from "./company-data.js";
import { guardToolResult, textResult } from "./tool-result.js";

const call = { conversationId: "c", taskId: "t", callId: "x" } as never;

describe("companyData", () => {
  it("returns a section the company has, as it is", () => {
    const book = [{ id: "a" }];
    expect(companyData({ priceBook: book }, "priceBook")).toBe(book);
    expect(companyData({ crews: [] }, "crews")).toEqual([]);
  });

  it("throws CompanyDataMissing, naming the section in plain words, when it is absent", () => {
    const company: { priceBook?: readonly unknown[] } = {};
    expect(() => companyData(company, "priceBook")).toThrow(CompanyDataMissing);
    expect(() => companyData(company, "priceBook")).toThrow(
      "This office has not given me its price book",
    );
  });

  it("has words for every section, and says not to use anything else in its place", () => {
    for (const section of Object.keys(
      COMPANY_DATA_SECTIONS,
    ) as (keyof typeof COMPANY_DATA_SECTIONS)[]) {
      const text = missingCompanyDataText(section);
      expect(text).toContain(COMPANY_DATA_SECTIONS[section]);
      expect(text).toContain("Do not use a figure, a name or a rule from anywhere else");
    }
  });
});

describe("guardToolResult and missing role data", () => {
  const tool = (execute: () => Promise<unknown>) =>
    guardToolResult(
      defineTool({
        name: "quote",
        description: "Quotes.",
        parameters: obj({}),
        replay: "safe",
        execute: execute as never,
      }),
    );

  it("answers a tool that needs absent data with one plain refusal", async () => {
    const result = await tool(async () =>
      companyData({} as { priceBook?: [] }, "priceBook"),
    ).execute({}, call, undefined as never);
    expect(result).toEqual({
      output: [{ type: "text", text: missingCompanyDataText("priceBook") }],
      isError: true,
      details: { code: "company_data_missing", section: "priceBook" },
    });
  });

  it("passes a result and any other error through unchanged", async () => {
    expect(await tool(async () => textResult("ok")).execute({}, call, undefined as never)).toEqual(
      textResult("ok"),
    );
    await expect(
      tool(async () => {
        throw new Error("desk down");
      }).execute({}, call, undefined as never),
    ).rejects.toThrow("desk down");
  });
});
