/**
 * The typed Word contract, without an interpreter.
 *
 * Everything here is enforced in process, before any Python is spawned: the file references against the
 * lease, the page bounds, the output name, the edit steps, and the shape of the answer the worker is
 * allowed to give. These tests always run — they never need `OFFICEHUM_PAPER_PYTHON` — which is what
 * keeps the refusals enforced on a host with no provisioned interpreter.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOCUMENT_REFUSAL_CODES, DocumentError } from "./errors.js";
import { DEFAULT_LIMITS, type DocumentLease } from "./lease.js";
import { intentForRun, intentSha256, POLICY_VERSION } from "./operation.js";
import { PPTX_TOOL_REGISTRATIONS } from "./pptx-tools.js";
import { paperOfficeToolPack, RUN_DOCUMENT_PYTHON } from "./run-document-python.js";
import { docxPackage, sha256, utf8 } from "./test-helpers.js";
import {
  COMPARE_DOCUMENT,
  CREATE_DOCUMENT,
  EDIT_DOCUMENT,
  INSPECT_DOCUMENT,
  MAX_WORD_PAGE,
  PREVIEW_DOCUMENT,
  parseWordResult,
  READ_DOCUMENT,
  resolveWordOutput,
  resolveWordRef,
  STEP_OPTIONAL,
  WORD_OPERATIONS,
  WORD_READ_SECTIONS,
  WORD_TOOL_NAMES,
  wordInstruction,
  wordProgram,
} from "./word-operations.js";
import { WORD_TOOL_REGISTRATIONS, wordTools } from "./word-tools.js";

const FILE_A = `file_${"A".repeat(26)}`;
const FILE_B = `file_${"B".repeat(26)}`;
const DOCX = docxPackage();

function leased(fileId: string, name: string, writable = true, bytes = DOCX) {
  return {
    fileId,
    versionId: fileId,
    name,
    format: "docx" as const,
    sha256: sha256(bytes),
    size: bytes.byteLength,
    writable,
  };
}

const LEASE: DocumentLease = {
  leaseId: "lease:word",
  taskId: "task:word",
  inputs: [leased(FILE_A, "brief.docx"), leased(FILE_B, "figures.docx", false)],
  outputFormats: ["docx"],
  limits: DEFAULT_LIMITS,
  expiresAt: "2999-01-01T00:00:00.000Z",
};

function refOf(fileId: string, bytes = DOCX) {
  return {
    fileId,
    versionId: fileId,
    name: fileId === FILE_A ? "brief.docx" : "figures.docx",
    sha256: sha256(bytes),
    size: bytes.byteLength,
  };
}

/** Whether any value anywhere in `value` is `undefined`, which the receipt's intent hash refuses. */
function hasUndefined(value: unknown): boolean {
  if (value === undefined) return true;
  if (Array.isArray(value)) return value.some(hasUndefined);
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some(hasUndefined);
  }
  return false;
}

function refusalOf(run: () => unknown): DocumentError {
  try {
    run();
  } catch (error) {
    if (error instanceof DocumentError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("a Word operation takes a leased file reference, never a path", () => {
  it("resolves a reference the lease pinned, and refuses anything else", () => {
    const leasedInput = resolveWordRef(LEASE, refOf(FILE_A), "the ref");
    expect(leasedInput.versionId).toBe(FILE_A);
    expect(leasedInput.writable).toBe(true);

    const ungranted = `file_${"C".repeat(26)}`;
    expect(
      refusalOf(() =>
        resolveWordRef(
          LEASE,
          { ...refOf(FILE_A), versionId: ungranted, fileId: ungranted },
          "the ref",
        ),
      ).code,
    ).toBe("ungranted-input");

    // A reference whose hash does not match the version the lease pinned is not that version.
    expect(
      refusalOf(() =>
        resolveWordRef(LEASE, { ...refOf(FILE_A), sha256: "a".repeat(64) }, "the ref"),
      ).code,
    ).toBe("ungranted-input");

    // There is no shape a caller can send that names a path: an extra field is refused outright.
    expect(
      refusalOf(() => resolveWordRef(LEASE, { ...refOf(FILE_A), path: "/etc/hosts" }, "the ref"))
        .code,
    ).toBe("invalid-request");
    expect(refusalOf(() => resolveWordRef(LEASE, refOf(FILE_A).versionId, "the ref")).code).toBe(
      "invalid-request",
    );
  });

  it("refuses a reference to a file that is not a Word document", () => {
    const lease: DocumentLease = {
      ...LEASE,
      inputs: [{ ...leased(FILE_A, "figures.xlsx"), format: "xlsx" }],
    };
    expect(
      refusalOf(() => resolveWordRef(lease, { ...refOf(FILE_A), name: "figures.xlsx" }, "the ref"))
        .code,
    ).toBe("invalid-request");
  });

  it("takes one staging file name for an output, and refuses a path or a format it may not write", () => {
    expect(resolveWordOutput(LEASE, "proposal.docx")).toBe("proposal.docx");
    expect(refusalOf(() => resolveWordOutput(LEASE, "../escape.docx")).code).toBe("traversal");
    expect(refusalOf(() => resolveWordOutput(LEASE, "folder/proposal.docx")).code).toBe(
      "traversal",
    );
    expect(refusalOf(() => resolveWordOutput(LEASE, "proposal.docm")).code).toBe("output-format");
    expect(
      refusalOf(() => resolveWordOutput({ ...LEASE, outputFormats: ["pptx"] }, "proposal.docx"))
        .code,
    ).toBe("output-format");
  });
});

describe("every operation sends a fixed program and checked arguments", () => {
  it("names the operation in the code, so the receipt's code hash does too", () => {
    for (const operation of WORD_OPERATIONS) {
      const code = wordInstruction(operation);
      expect(code).toContain(`documents.result(word_adapter.run(${JSON.stringify(operation)}`);
      expect(code).toContain("import word_adapter");
      expect(wordInstruction(operation)).toBe(code);
    }
  });

  it("builds the arguments the adapter expects, and nothing else", () => {
    const cases: [string, unknown][] = [
      ["inspect", { ref: refOf(FILE_A) }],
      ["read", { ref: refOf(FILE_A), section: "paragraphs", pageSize: 5, cursor: 10 }],
      ["preview", { ref: refOf(FILE_A), pageSize: 3 }],
      ["compare", { from: refOf(FILE_A), to: refOf(FILE_B) }],
      ["create", { output: "draft.docx", blocks: [{ kind: "paragraph", text: "Hello." }] }],
      [
        "edit",
        {
          ref: refOf(FILE_A),
          output: "proposal.docx",
          author: "Office Hum",
          steps: [
            {
              kind: "insertSection",
              anchor: { text: "Introduction" },
              heading: "Variance",
              paragraphs: ["Grew."],
            },
          ],
        },
      ],
    ];
    for (const [operation, args] of cases) {
      const program = wordProgram(operation as never, args, LEASE);
      expect(program.code).toBe(wordInstruction(operation as never));
      const expected: Record<string, string[]> = {
        inspect: ["ref"],
        read: ["ref", "section", "pageSize", "cursor"],
        preview: ["ref", "pageSize"],
        compare: ["from", "to"],
        create: ["output", "blocks"],
        edit: ["ref", "output", "steps", "author"],
      };
      expect(Object.keys(program.arguments).sort()).toEqual(expected[operation]?.sort());
    }
  });

  it("builds arguments a receipt can hash, for every operation and every optional field", () => {
    const everyStep = [
      {
        kind: "insertSection",
        anchor: { text: "Quarterly Close" },
        heading: "Variance",
        paragraphs: ["Grew."],
        headingStyle: "Heading2",
        bodyStyle: "BodyText",
        tracked: false,
        author: "Office Hum",
        date: "2026-10-23T00:00:00Z",
      },
      {
        kind: "replaceParagraphs",
        anchor: { story: "word/document.xml", index: 1, contentHash: "abcd1234" },
        paragraphs: ["Replaced."],
        count: 2,
        bodyStyle: "BodyText",
        tracked: true,
        author: "Office Hum",
      },
      { kind: "deleteParagraphs", anchor: { text: "Old." }, count: 1 },
      {
        kind: "replaceText",
        needle: "1250",
        text: "1400",
        story: "word/document.xml",
        nth: 1,
        tracked: true,
      },
      { kind: "updateCell", nearText: "Revenue", row: 1, column: 1, text: "1400", tracked: false },
      {
        kind: "insertRow",
        nearText: "Revenue",
        row: 1,
        values: ["Costs", "10"],
        copyFormatFrom: 1,
      },
      { kind: "deleteRow", nearText: "Revenue", row: 1 },
      { kind: "addComment", anchor: { text: "Revenue" }, text: "Confirm?", author: "Reviewer" },
      { kind: "replyComment", commentId: 0, text: "Confirmed.", author: "Bookkeeper" },
      { kind: "resolveComment", commentId: 0, resolved: false },
      { kind: "deleteComment", commentId: 0 },
      { kind: "acceptRevisions", revisionAuthor: "Reviewer" },
      { kind: "rejectRevisions" },
    ];
    const cases: [string, unknown][] = [
      ["inspect", { ref: refOf(FILE_A) }],
      [
        "read",
        { ref: refOf(FILE_A), section: "tables", pageSize: 50, cursor: 0, includeCells: false },
      ],
      ["preview", { ref: refOf(FILE_A), pageSize: 1, cursor: 0 }],
      ["compare", { from: refOf(FILE_A), to: refOf(FILE_B) }],
      [
        "create",
        {
          output: "draft.docx",
          blocks: [
            { kind: "heading", text: "Close", level: 1 },
            { kind: "paragraph", text: "Prepared.", style: "BodyText" },
            { kind: "list", items: ["One"], listKind: "decimal", level: 2 },
            { kind: "table", rows: [["a"]], style: "Table Grid" },
            { kind: "pageBreak" },
          ],
        },
      ],
      [
        "edit",
        {
          ref: refOf(FILE_A),
          output: "proposal.docx",
          steps: everyStep,
          author: "Office Hum",
          date: "2026-10-23T00:00:00Z",
          acknowledgeProtection: true,
        },
      ],
    ];
    for (const [operation, args] of cases) {
      const program = wordProgram(operation as never, args, LEASE);
      // An absent field must be *absent*: the receipt's intent hash refuses a value that is not JSON.
      expect(hasUndefined(program.arguments)).toBe(false);
      const intent = intentForRun({
        operationId: "conv:call",
        taskId: "task:word",
        policyVersion: POLICY_VERSION,
        code: program.code,
        arguments: program.arguments,
        lease: LEASE,
      });
      expect(() => intentSha256(intent)).not.toThrow();
      expect(intentSha256(intent)).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it("agrees with the Python adapter about every step kind and field it sends", () => {
    // The tool validates a request and the adapter validates it again on the far side. They must agree
    // about the vocabulary, or a well-formed call would arrive as an `invalid-request` refusal.
    const source = readFileSync(new URL("../python/word_adapter.py", import.meta.url), "utf8");
    expect(source).toContain("STEP_FIELDS");
    for (const kind of Object.keys(STEP_OPTIONAL)) {
      expect(source, `${kind} is not a step the adapter knows`).toContain(`"${kind}": (`);
    }
    for (const field of Object.values(STEP_OPTIONAL).flat()) {
      expect(source, `${field} is not a field the adapter accepts`).toContain(`"${field}"`);
    }
    for (const section of WORD_READ_SECTIONS) {
      expect(source).toContain(`"${section}"`);
    }
    for (const kind of ["heading", "paragraph", "list", "table", "pageBreak"]) {
      expect(source, `${kind} is not a block the adapter knows`).toContain(`"${kind}"`);
    }
  });

  it("gives the adapter the version id, name, hash and size of the leased version", () => {
    const program = wordProgram("inspect", { ref: refOf(FILE_A) }, LEASE);
    expect(program.arguments.ref).toEqual({
      fileId: FILE_A,
      versionId: FILE_A,
      name: "brief.docx",
      sha256: sha256(DOCX),
      size: DOCX.byteLength,
    });
  });

  it("marks an edit's output as a proposal of the leased version, and a draft as a new file", () => {
    const edit = wordProgram(
      "edit",
      {
        ref: refOf(FILE_A),
        output: "proposal.docx",
        author: "Office Hum",
        steps: [{ kind: "deleteParagraphs", anchor: { text: "Introduction" } }],
      },
      LEASE,
    );
    expect(edit.output).toEqual({ name: "proposal.docx", editOf: FILE_A });
    const create = wordProgram(
      "create",
      { output: "draft.docx", blocks: [{ kind: "paragraph", text: "x" }] },
      LEASE,
    );
    expect(create.output).toEqual({ name: "draft.docx", editOf: null });
    expect(create.sources).toEqual([]);
  });

  it("refuses an edit of a version the lease holds read-only", () => {
    const program = refusalOf(() =>
      wordProgram(
        "edit",
        {
          ref: refOf(FILE_B),
          output: "proposal.docx",
          author: "Office Hum",
          steps: [{ kind: "deleteParagraphs", anchor: { text: "Introduction" } }],
        },
        LEASE,
      ),
    );
    expect(program.code).toBe("unleased-path");
  });
});

describe("the requests the typed tools refuse before any run", () => {
  const cases: [string, unknown, string][] = [
    ["read", { ref: refOf(FILE_A), section: "slides" }, "invalid-request"],
    [
      "read",
      { ref: refOf(FILE_A), section: "paragraphs", pageSize: MAX_WORD_PAGE + 1 },
      "invalid-request",
    ],
    ["read", { ref: refOf(FILE_A), section: "paragraphs", cursor: -1 }, "invalid-request"],
    ["preview", { ref: refOf(FILE_A), pagesize: 5 }, "invalid-request"],
    ["inspect", { ref: refOf(FILE_A), code: "print(1)" }, "invalid-request"],
    ["create", { output: "draft.docx", blocks: [] }, "invalid-request"],
    [
      "create",
      { output: "draft.docx", blocks: [{ kind: "table", rows: [["a"], ["b", "c"]] }] },
      "invalid-request",
    ],
    [
      "create",
      { output: "draft.docx", blocks: [{ kind: "heading", text: "H" }] },
      "invalid-request",
    ],
    [
      "edit",
      {
        ref: refOf(FILE_A),
        output: "proposal.docx",
        steps: [{ kind: "insertSection", anchor: { text: "x" }, heading: "H", paragraphs: ["p"] }],
      },
      "invalid-request",
    ],
    [
      "edit",
      {
        ref: refOf(FILE_A),
        output: "proposal.docx",
        author: "Office Hum",
        steps: [{ kind: "scrollTo", anchor: { text: "x" } }],
      },
      "invalid-request",
    ],
    [
      "edit",
      {
        ref: refOf(FILE_A),
        output: "proposal.docx",
        author: "Office Hum",
        steps: [
          {
            kind: "insertSection",
            anchor: { story: "word/document.xml", index: 0, contentHash: "zz" },
            heading: "H",
            paragraphs: ["p"],
          },
        ],
      },
      "invalid-request",
    ],
    [
      "edit",
      {
        ref: refOf(FILE_A),
        output: "proposal.docx",
        author: "Office Hum",
        steps: [{ kind: "replaceText", needle: "a", text: "b", tracked: "yes" }],
      },
      "invalid-request",
    ],
    [
      "edit",
      {
        ref: refOf(FILE_A),
        output: "proposal.docx",
        author: "Office Hum",
        steps: [{ kind: "replaceText", needle: "a", text: "b", extra: true }],
      },
      "invalid-request",
    ],
  ];

  it.each(cases)("%s refuses %o as %s", (operation, args, code) => {
    expect(refusalOf(() => wordProgram(operation as never, args, LEASE)).code).toBe(code);
  });

  it("leaves out what the caller did not send, rather than sending undefined", () => {
    const program = wordProgram("read", { ref: refOf(FILE_A), section: "blocks" }, LEASE);
    expect(program.arguments).toEqual({
      ref: {
        fileId: FILE_A,
        versionId: FILE_A,
        name: "brief.docx",
        sha256: sha256(DOCX),
        size: DOCX.byteLength,
      },
      section: "blocks",
    });
  });
});

describe("the typed Word surface", () => {
  it("maps the adapter's refusals onto codes the pack already knows", () => {
    for (const code of [
      "document-protected",
      "malformed-package",
      "unsupported-structure",
      "boundary-violation",
      "target-not-found",
      "ambiguous-target",
    ]) {
      expect(DOCUMENT_REFUSAL_CODES).toContain(code);
    }
  });

  it("names the six operations the design names, in order", () => {
    expect(WORD_OPERATIONS).toEqual(["inspect", "read", "create", "edit", "preview", "compare"]);
    expect(WORD_TOOL_NAMES.inspect).toBe(INSPECT_DOCUMENT);
    expect(WORD_TOOL_NAMES.read).toBe(READ_DOCUMENT);
    expect(WORD_TOOL_NAMES.create).toBe(CREATE_DOCUMENT);
    expect(WORD_TOOL_NAMES.edit).toBe(EDIT_DOCUMENT);
    expect(WORD_TOOL_NAMES.preview).toBe(PREVIEW_DOCUMENT);
    expect(WORD_TOOL_NAMES.compare).toBe(COMPARE_DOCUMENT);
    expect(WORD_TOOL_REGISTRATIONS).toEqual([
      INSPECT_DOCUMENT,
      READ_DOCUMENT,
      CREATE_DOCUMENT,
      EDIT_DOCUMENT,
      PREVIEW_DOCUMENT,
      COMPARE_DOCUMENT,
    ]);
  });

  it("registers each tool with the section list its own validator accepts", () => {
    // The schema is what a model sees; WORD_READ_SECTIONS is what the validator accepts. They must agree.
    const read = wordTools({ service: neverCalled(), leaseFor: async () => LEASE }).find(
      (tool) => tool.name === READ_DOCUMENT,
    );
    const parameters = read?.parameters as { properties?: Record<string, unknown> } | undefined;
    const section = parameters?.properties?.section as
      | { anyOf?: { const?: unknown }[] }
      | undefined;
    const literals = (section?.anyOf ?? []).map((item) => item.const);
    expect(literals).toEqual([...WORD_READ_SECTIONS]);
  });

  it("offers every tool as replay-safe, and can withhold the typed set", () => {
    const service = neverCalled();
    const full = paperOfficeToolPack({ service, leaseFor: async () => LEASE });
    expect(full.tools.map((tool) => tool.name)).toEqual([
      RUN_DOCUMENT_PYTHON,
      ...WORD_TOOL_REGISTRATIONS,
      ...PPTX_TOOL_REGISTRATIONS,
    ]);
    for (const tool of full.tools) expect(tool.replay).toBe("safe");
    // Withholding the Word set leaves the PowerPoint set, and withholding both leaves the workspace.
    const withoutWord = paperOfficeToolPack({
      service,
      leaseFor: async () => LEASE,
      includeWordTools: false,
    });
    expect(withoutWord.tools.map((tool) => tool.name)).toEqual([
      RUN_DOCUMENT_PYTHON,
      ...PPTX_TOOL_REGISTRATIONS,
    ]);
    const workspaceOnly = paperOfficeToolPack({
      service,
      leaseFor: async () => LEASE,
      includeWordTools: false,
      includePptxTools: false,
    });
    expect(workspaceOnly.tools.map((tool) => tool.name)).toEqual([RUN_DOCUMENT_PYTHON]);
  });
});

describe("the result validator", () => {
  const SOURCE = {
    fileId: FILE_A,
    versionId: FILE_A,
    name: "brief.docx",
    sha256: sha256(DOCX),
    size: DOCX.byteLength,
  };

  function reading(overrides: Record<string, unknown> = {}) {
    return {
      schema: "paper_word_operation",
      version: 1,
      operation: "read",
      ok: true,
      source: { ...SOURCE },
      document: {
        storyParts: 1,
        blocks: 1,
        paragraphs: 1,
        headings: 0,
        tables: 0,
        characters: 4,
      },
      page: {
        section: "paragraphs",
        pageSize: 2,
        cursor: 0,
        returned: 1,
        total: 1,
        nextCursor: null,
        hasMore: false,
        items: [
          {
            story: "word/document.xml",
            kind: "paragraph",
            index: 0,
            anchor: { story: "word/document.xml", index: 0, contentHash: "abcd1234" },
            text: "Hello.",
            truncated: false,
            styleId: null,
            headingLevel: null,
            inInsert: false,
            inDelete: false,
            inContentControl: false,
            inTextBox: false,
            hasField: false,
            table: null,
          },
        ],
      },
      ...overrides,
    };
  }

  it("accepts a well-formed page and reports what it carries", () => {
    const result = parseWordResult("read", reading(), [SOURCE]);
    expect(result.operation).toBe("read");
    if (result.operation !== "read") throw new Error("unreachable");
    expect(result.page.total).toBe(1);
    expect(result.page.nextCursor).toBeNull();
    expect(result.page.items[0]).toMatchObject({ kind: "paragraph", text: "Hello." });
  });

  it("refuses an answer about a version this call never named", () => {
    const error = refusalOf(() =>
      parseWordResult("read", reading({ source: { ...SOURCE, sha256: "b".repeat(64) } }), [SOURCE]),
    );
    expect(error.code).toBe("output-invalid");
  });

  it("refuses a page that is inconsistent with itself", () => {
    const page = reading();
    const broken = {
      ...page,
      page: { ...page.page, returned: 2 },
    };
    expect(refusalOf(() => parseWordResult("read", broken, [SOURCE])).code).toBe("output-invalid");
    const beyond = { ...page, page: { ...page.page, total: 0 } };
    expect(refusalOf(() => parseWordResult("read", beyond, [SOURCE])).code).toBe("output-invalid");
    const huge = { ...page, page: { ...page.page, pageSize: MAX_WORD_PAGE + 1 } };
    expect(refusalOf(() => parseWordResult("read", huge, [SOURCE])).code).toBe("output-invalid");
  });

  it("refuses the wrong operation, a bad envelope and a published file", () => {
    expect(refusalOf(() => parseWordResult("inspect", reading(), [SOURCE])).code).toBe(
      "output-invalid",
    );
    expect(
      refusalOf(() => parseWordResult("read", { ...reading(), ok: false }, [SOURCE])).code,
    ).toBe("output-invalid");
    expect(
      refusalOf(() =>
        parseWordResult(
          "edit",
          {
            schema: "paper_word_operation",
            version: 1,
            operation: "edit",
            ok: true,
            source: SOURCE,
            proposal: {
              status: "proposed",
              name: "proposal.docx",
              editOf: FILE_A,
              sha256: sha256(DOCX),
              size: DOCX.byteLength,
              published: true,
            },
            changes: [],
            changeSet: {
              schema: "paper_package_diff",
              version: 1,
              added: [],
              removed: [],
              changed: [],
              byteIdenticalCount: 0,
              semanticallyEmpty: false,
            },
            diff: {
              schema: "paper_text_diff",
              version: 1,
              changedLineCount: 0,
              stories: [],
              truncated: false,
            },
            redline: {
              schema: "paper_word_redline",
              version: 1,
              insertedBlocks: 0,
              deletedBlocks: 0,
              entries: [],
              total: 0,
              truncated: false,
              pendingChangedLineCount: 0,
              pendingLines: [],
            },
            preservation: {
              restoredParts: [],
              changedParts: [],
              addedParts: [],
              removedParts: [],
              verbatimCopy: false,
            },
            protection: { edit: null, formatting: false, enforced: false, acknowledged: false },
            reopened: {
              paragraphs: 1,
              headings: 0,
              tables: 0,
              comments: 0,
              revisions: 0,
              storyParts: ["word/document.xml"],
            },
          },
          [SOURCE],
        ),
      ).code,
    ).toBe("output-invalid");
  });

  it("refuses a compare answer that swaps the two versions it was given", () => {
    const answer = {
      schema: "paper_word_operation",
      version: 1,
      operation: "compare",
      ok: true,
      sources: {
        from: { ...SOURCE, fileId: FILE_B, versionId: FILE_B, sha256: sha256(utf8("b")) },
        to: SOURCE,
      },
      changeSet: {
        schema: "paper_package_diff",
        version: 1,
        added: [],
        removed: [],
        changed: [],
        byteIdenticalCount: 0,
        semanticallyEmpty: true,
      },
      diff: {
        schema: "paper_text_diff",
        version: 1,
        changedLineCount: 0,
        stories: [],
        truncated: false,
      },
      redline: {
        schema: "paper_word_redline",
        version: 1,
        insertedBlocks: 0,
        deletedBlocks: 0,
        entries: [],
        total: 0,
        truncated: false,
        pendingChangedLineCount: 0,
        pendingLines: [],
      },
      identical: true,
    };
    expect(refusalOf(() => parseWordResult("compare", answer, [SOURCE, SOURCE])).code).toBe(
      "output-invalid",
    );
  });
});

function neverCalled() {
  return {
    async runDocumentPython() {
      throw new Error("the contract tests never reach the service");
    },
  };
}
