import { describe, expect, it } from "vitest";
import { DocumentError } from "./errors.js";
import { inspectOfficePackage } from "./ooxml.js";
import { buildZip, docxLike, docxPackage, xlsxPackage } from "./test-helpers.js";

const LIMITS = { archiveBytes: 1_024 * 1_024, archiveEntries: 64, archiveRatio: 200 };

function refusalOf(bytes: Uint8Array, limits = LIMITS): string {
  try {
    inspectOfficePackage(bytes, limits, "the package");
  } catch (error) {
    if (error instanceof DocumentError) return error.code;
    throw error;
  }
  return "accepted";
}

describe("Office package inspection", () => {
  it("accepts a package whose relationships stay inside it", () => {
    const inspection = inspectOfficePackage(docxPackage(), LIMITS, "the package");
    expect(inspection.entries).toContain("[Content_Types].xml");
    expect(inspection.entries).toContain("word/document.xml");
    expect(inspection.uncompressedBytes).toBeGreaterThan(0);
  });

  it("accepts an xlsx package with internal relationships", () => {
    expect(refusalOf(xlsxPackage())).toBe("accepted");
  });

  it("refuses a zip bomb: declared expansion above the byte allowance", () => {
    const bomb = buildZip([
      { name: "[Content_Types].xml", data: "<Types/>" },
      { name: "word/document.xml", data: "a", declaredUncompressed: 200 * 1_024 * 1_024 },
    ]);
    expect(refusalOf(bomb)).toBe("archive-unsafe");
  });

  it("refuses a declared expansion ratio above the allowance", () => {
    const bomb = buildZip([
      { name: "[Content_Types].xml", data: "<Types/>" },
      { name: "word/document.xml", data: "a".repeat(5_000) },
    ]);
    expect(
      refusalOf(bomb, {
        archiveBytes: 2 * 1_024 * 1_024 * 1_024,
        archiveEntries: 64,
        archiveRatio: 5,
      }),
    ).toBe("archive-unsafe");
  });

  it("refuses more package entries than the allowance holds", () => {
    const many = buildZip([
      { name: "[Content_Types].xml", data: "<Types/>" },
      { name: "a.xml", data: "<a/>" },
      { name: "b.xml", data: "<b/>" },
      { name: "c.xml", data: "<c/>" },
    ]);
    expect(refusalOf(many, { ...LIMITS, archiveEntries: 3 })).toBe("archive-unsafe");
  });

  it("refuses an archive that is not an Office package", () => {
    const noTypes = buildZip([{ name: "word/document.xml", data: "<w:document/>" }]);
    expect(refusalOf(noTypes)).toBe("archive-invalid");
    expect(refusalOf(docxLike({ omitContentTypes: true }))).toBe("archive-invalid");
  });

  it("refuses a byte sequence that is not a ZIP archive at all", () => {
    expect(refusalOf(new TextEncoder().encode("this is not a package"))).toBe("archive-invalid");
    expect(refusalOf(new Uint8Array(4))).toBe("archive-invalid");
  });

  it("refuses a truncated archive", () => {
    expect(refusalOf(docxPackage().slice(0, 60))).toBe("archive-invalid");
  });

  it("refuses a package entry whose name traverses", () => {
    expect(
      refusalOf(
        docxLike({
          entries: [
            { name: "[Content_Types].xml", data: "<Types/>" },
            { name: "../escape.xml", data: "<e/>" },
          ],
        }),
      ),
    ).toBe("entry-name");
  });

  it("refuses an absolute package entry name", () => {
    expect(
      refusalOf(
        docxLike({
          entries: [
            { name: "[Content_Types].xml", data: "<Types/>" },
            { name: "/etc/passwd", data: "x" },
          ],
        }),
      ),
    ).toBe("entry-name");
  });

  it("refuses a macro payload", () => {
    expect(
      refusalOf(
        docxLike({ extra: [{ name: "word/vbaProject.bin", data: new Uint8Array([1, 2, 3]) }] }),
      ),
    ).toBe("macro-payload");
    expect(
      refusalOf(docxLike({ extra: [{ name: "word/embeddings/payload.exe", data: "MZ" }] })),
    ).toBe("macro-payload");
  });

  it("refuses a docx that links to an http URL", () => {
    expect(refusalOf(docxLike({ external: ["http://evil.example/steal"] }))).toBe(
      "external-relationship",
    );
  });

  it("refuses an xlsx external link", () => {
    const external = buildZip([
      { name: "[Content_Types].xml", data: "<Types/>" },
      { name: "xl/workbook.xml", data: "<workbook/>" },
      {
        name: "xl/_rels/workbook.xml.rels",
        data:
          '<Relationships><Relationship Id="rId1" Type="externalLink" ' +
          'Target="file:///Users/someone/secrets.xlsx" TargetMode="External"/></Relationships>',
      },
    ]);
    expect(refusalOf(external)).toBe("external-relationship");
  });

  it("refuses a pptx relationship pointing outside the package", () => {
    const escaping = buildZip([
      { name: "[Content_Types].xml", data: "<Types/>" },
      { name: "ppt/presentation.xml", data: "<p:presentation/>" },
      {
        name: "ppt/_rels/presentation.xml.rels",
        data:
          '<Relationships><Relationship Id="rId1" Type="slide" ' +
          'Target="../../../../etc/hosts"/></Relationships>',
      },
    ]);
    expect(refusalOf(escaping)).toBe("external-relationship");
  });

  it("accepts a relationship that climbs to a part still inside the package", () => {
    expect(
      refusalOf(
        docxLike({
          targets: ["styles.xml", "../docProps/core.xml"],
          extra: [{ name: "docProps/core.xml", data: "<core/>" }],
        }),
      ),
    ).toBe("accepted");
  });
});
