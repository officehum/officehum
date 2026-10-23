/**
 * The typed Word tools against an injected `DocumentService`, with no interpreter and no Python.
 *
 * This is the bare-harness half of the portability gate: the pack is driven only through the service it
 * was handed, so the same six tools run in Office Hum with the local service and in a bare Pi Durable
 * harness with a scripted one. What is checked here is the part a fixture cannot: the operation ID is
 * derived from the Pi Durable call and never from an argument, a replay returns the same answer, and an
 * answer that names a version this call never asked for is refused rather than shown to a model.
 */

import { describe, expect, it } from "vitest";
import type {
  DocumentRunOutcome,
  DocumentRunRequest,
  DocumentService,
} from "./document-service.js";
import type { DocumentLease } from "./lease.js";
import { DEFAULT_LIMITS } from "./lease.js";
import { paperOfficeToolPack } from "./run-document-python.js";
import { docxPackage, sha256 } from "./test-helpers.js";
import {
  COMPARE_DOCUMENT,
  EDIT_DOCUMENT,
  INSPECT_DOCUMENT,
  READ_DOCUMENT,
  WORD_TOOL_NAMES,
  wordInstruction,
} from "./word-operations.js";

const FILE_A = `file_${"A".repeat(26)}`;
const FILE_B = `file_${"B".repeat(26)}`;
const DOCX = docxPackage();
const HASH = sha256(DOCX);

const REF = {
  fileId: FILE_A,
  versionId: FILE_A,
  name: "brief.docx",
  sha256: HASH,
  size: DOCX.byteLength,
};

const LEASE: DocumentLease = {
  leaseId: "lease:word",
  taskId: "task:word",
  inputs: [
    { ...REF, format: "docx", writable: true },
    {
      fileId: FILE_B,
      versionId: FILE_B,
      name: "figures.docx",
      format: "docx",
      sha256: HASH,
      size: DOCX.byteLength,
      writable: false,
    },
  ],
  outputFormats: ["docx"],
  limits: DEFAULT_LIMITS,
  expiresAt: "2999-01-01T00:00:00.000Z",
};

const COUNTS = { storyParts: 1, blocks: 1, paragraphs: 1, headings: 0, tables: 0, characters: 6 };

const BLOCK = {
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
};

const DIFF = {
  schema: "paper_text_diff",
  version: 1,
  changedLineCount: 2,
  stories: [
    {
      story: "word/document.xml",
      diffLines: ["-[paragraph] old", "+[paragraph] new"],
      omittedLines: 0,
    },
  ],
  truncated: false,
};

const CHANGE_SET = {
  schema: "paper_package_diff",
  version: 1,
  added: [],
  removed: [],
  changed: [
    {
      part: "word/document.xml",
      kind: "xml",
      beforeSha256: HASH,
      afterSha256: HASH,
      semanticChange: true,
    },
  ],
  byteIdenticalCount: 16,
  semanticallyEmpty: false,
};

const REDLINE = {
  schema: "paper_word_redline",
  version: 1,
  insertedBlocks: 2,
  deletedBlocks: 1,
  entries: [
    {
      story: "word/document.xml",
      kind: "paragraph",
      index: 1,
      marker: "insert",
      text: "Variance",
      truncated: false,
    },
  ],
  total: 1,
  truncated: false,
  pendingChangedLineCount: 2,
  pendingLines: ["-[paragraph] old", "+[paragraph] new"],
};

const PROTECTION = { edit: null, formatting: false, enforced: false, acknowledged: false };

function readResult() {
  return {
    schema: "paper_word_operation",
    version: 1,
    operation: "read",
    ok: true,
    source: {
      fileId: FILE_A,
      versionId: FILE_A,
      name: "brief.docx",
      sha256: HASH,
      size: DOCX.byteLength,
    },
    document: COUNTS,
    page: {
      section: "paragraphs",
      pageSize: 20,
      cursor: 0,
      returned: 1,
      total: 1,
      nextCursor: null,
      hasMore: false,
      items: [BLOCK],
    },
  };
}

function editResult() {
  return {
    schema: "paper_word_operation",
    version: 1,
    operation: "edit",
    ok: true,
    source: {
      fileId: FILE_A,
      versionId: FILE_A,
      name: "brief.docx",
      sha256: HASH,
      size: DOCX.byteLength,
    },
    proposal: {
      status: "proposed",
      name: "proposal.docx",
      editOf: FILE_A,
      sha256: HASH,
      size: DOCX.byteLength,
      published: false,
    },
    changes: [{ kind: "insertSection", tracked: true, evidence: { revisionIds: [1, 2] } }],
    changeSet: CHANGE_SET,
    diff: DIFF,
    redline: REDLINE,
    preservation: {
      restoredParts: [],
      changedParts: ["word/document.xml"],
      addedParts: [],
      removedParts: [],
      verbatimCopy: false,
    },
    protection: PROTECTION,
    reopened: {
      paragraphs: 6,
      headings: 3,
      tables: 1,
      comments: 1,
      revisions: 6,
      storyParts: ["word/document.xml", "word/header1.xml", "word/footer1.xml"],
    },
  };
}

interface Recorded extends DocumentService {
  readonly requests: DocumentRunRequest[];
}

function scriptedService(result: unknown, outcome?: DocumentRunOutcome): Recorded {
  const requests: DocumentRunRequest[] = [];
  return {
    requests,
    async runDocumentPython(request) {
      requests.push(request);
      if (outcome !== undefined) return outcome;
      return {
        kind: "committed",
        receipt: {
          kind: "run",
          operationId: request.operationId,
          intentSha256: "c".repeat(64),
          taskId: request.taskId,
          policyVersion: "paper-documents:1",
          leaseId: request.lease.leaseId,
          codeSha256: "d".repeat(64),
          worker: {
            python: "3.13.17",
            image: "paper-worker:python-3.13",
            libraries: { python: "3.13.17", "paper-docx": "0.2.0" },
            modules: { docx: "1.2.0" },
          },
          reads: [
            {
              fileId: FILE_A,
              versionId: FILE_A,
              name: "brief.docx",
              format: "docx",
              sha256: HASH,
              size: DOCX.byteLength,
              sourceVersionId: null,
            },
          ],
          outputs: [],
          commit: [],
          result,
          resultDeclared: true,
          reopen: [],
          notes: [],
          createdAt: "2026-10-23T00:00:00.000Z",
        },
      };
    },
  };
}

function toolOf(service: DocumentService, name: string, lease: DocumentLease | undefined) {
  const pack = paperOfficeToolPack({ service, leaseFor: async () => lease });
  const tool = pack.tools.find((item) => item.name === name) as unknown as {
    execute(
      args: unknown,
      api: { taskId: string; conversationId: string; callId: string },
    ): Promise<{
      output: { text: string }[];
      isError?: boolean;
      details?: Record<string, unknown>;
    }>;
  };
  return { tool, service };
}

const api = { taskId: "task:word", conversationId: "conv", callId: "call-1" };

describe("the typed Word tools run only through the injected service", () => {
  it("derives the operation ID from the Pi Durable call, never from an argument", async () => {
    const service = scriptedService(readResult());
    const { tool } = toolOf(service, READ_DOCUMENT, LEASE);
    await tool.execute({ ref: REF, section: "paragraphs" }, api);
    await tool.execute(
      { ref: REF, section: "paragraphs", pageSize: 5 },
      { ...api, callId: "call-2" },
    );
    expect(service.requests.map((request) => request.operationId)).toEqual([
      "conv:call-1",
      "conv:call-2",
    ]);
    expect(service.requests[0]?.code).toBe(wordInstruction("read"));
    expect(service.requests[0]?.lease).toBe(LEASE);
    expect(service.requests[0]?.taskId).toBe("task:word");
  });

  it("returns the typed result bounded for the model, and writes nothing for a read", async () => {
    const service = scriptedService(readResult());
    const { tool } = toolOf(service, READ_DOCUMENT, LEASE);
    const result = await tool.execute({ ref: REF, section: "paragraphs" }, api);
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.output[0]?.text ?? "{}") as {
      ok: boolean;
      operation: string;
      result: { operation: string; page: { total: number; items: { text: string }[] } };
    };
    expect(body.ok).toBe(true);
    expect(body.operation).toBe("read");
    expect(body.result.page.total).toBe(1);
    expect(body.result.page.items[0]?.text).toBe("Hello.");
    expect(result.details).toMatchObject({
      operationId: "conv:call-1",
      operation: "read",
      files: [],
    });
  });

  it("reports the file an edit proposed, and carries the change set and redline", async () => {
    const service = scriptedService(editResult());
    const { tool } = toolOf(service, EDIT_DOCUMENT, LEASE);
    const result = await tool.execute(
      {
        ref: REF,
        output: "proposal.docx",
        author: "Office Hum",
        steps: [
          {
            kind: "insertSection",
            anchor: { text: "Quarterly Close" },
            heading: "Variance",
            paragraphs: ["Grew."],
          },
        ],
      },
      api,
    );
    const body = JSON.parse(result.output[0]?.text ?? "{}") as {
      result: {
        proposal: { published: boolean; status: string; editOf: string };
        changeSet: { byteIdenticalCount: number };
        redline: { insertedBlocks: number };
      };
    };
    expect(result.isError).toBeUndefined();
    expect(body.result.proposal).toMatchObject({
      published: false,
      status: "proposed",
      editOf: FILE_A,
    });
    expect(body.result.changeSet.byteIdenticalCount).toBe(16);
    expect(body.result.redline.insertedBlocks).toBe(2);
    expect(result.details).toMatchObject({ operation: "edit" });

    // The adapter is handed a program that declares an output of the leased version, never a path.
    const request = service.requests[0];
    expect(request?.arguments).toMatchObject({ output: "proposal.docx", author: "Office Hum" });
    expect(request?.code).toBe(wordInstruction("edit"));
  });

  it("returns the same answer for a replay of the same call", async () => {
    const service = scriptedService(readResult());
    const { tool } = toolOf(service, READ_DOCUMENT, LEASE);
    const first = await tool.execute({ ref: REF, section: "paragraphs" }, api);
    const second = await tool.execute({ ref: REF, section: "paragraphs" }, api);
    expect(second.output[0]?.text).toBe(first.output[0]?.text);
    expect(service.requests.map((request) => request.operationId)).toEqual([
      "conv:call-1",
      "conv:call-1",
    ]);
  });

  it("refuses when the task has no lease, without reaching the service", async () => {
    const service = scriptedService(readResult());
    const { tool } = toolOf(service, READ_DOCUMENT, undefined);
    const result = await tool.execute({ ref: REF, section: "paragraphs" }, api);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output[0]?.text ?? "{}")).toMatchObject({
      ok: false,
      code: "no-lease",
    });
    expect(service.requests).toHaveLength(0);
  });

  it("refuses a request the lease does not grant, before the service is called", async () => {
    const service = scriptedService(readResult());
    const { tool } = toolOf(service, READ_DOCUMENT, LEASE);
    const result = await tool.execute(
      { ref: { ...REF, versionId: `file_${"C".repeat(26)}` }, section: "paragraphs" },
      api,
    );
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ code: "ungranted-input" });
    expect(service.requests).toHaveLength(0);
  });

  it("turns a service refusal into a typed error result the model can read", async () => {
    const service = scriptedService(readResult(), {
      kind: "refused",
      operationId: "conv:call-1",
      code: "external-relationship",
      message: "the leased input brief.docx links to an external resource",
    });
    const { tool } = toolOf(service, READ_DOCUMENT, LEASE);
    const result = await tool.execute({ ref: REF, section: "paragraphs" }, api);
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ code: "external-relationship", operation: "read" });
  });

  it("refuses an answer that names a version this call never asked for", async () => {
    const stray = { ...readResult(), source: { ...readResult().source, sha256: "e".repeat(64) } };
    const service = scriptedService(stray);
    const { tool } = toolOf(service, READ_DOCUMENT, LEASE);
    const result = await tool.execute({ ref: REF, section: "paragraphs" }, api);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output[0]?.text ?? "{}")).toMatchObject({
      ok: false,
      code: "output-invalid",
    });
  });

  it("withholds the typed tools from a pack that asks for the workspace alone", async () => {
    const service = scriptedService(readResult());
    const pack = paperOfficeToolPack({
      service,
      leaseFor: async () => LEASE,
      includeWordTools: false,
    });
    expect(pack.tools.some((tool) => tool.name === WORD_TOOL_NAMES.read)).toBe(false);
  });

  it("registers every typed tool as replay-safe with a closed argument schema", async () => {
    const service = scriptedService(readResult());
    const pack = paperOfficeToolPack({ service, leaseFor: async () => LEASE });
    const typed = pack.tools.filter((tool) => tool.name !== "run_document_python");
    expect(typed.map((tool) => tool.name)).toEqual([
      INSPECT_DOCUMENT,
      READ_DOCUMENT,
      "create_document",
      EDIT_DOCUMENT,
      "preview_document",
      COMPARE_DOCUMENT,
    ]);
    for (const tool of typed) {
      expect(tool.replay).toBe("safe");
      const parameters = (tool as unknown as { parameters: { additionalProperties?: unknown } })
        .parameters;
      expect(parameters.additionalProperties).toBe(false);
      expect(String(tool.description).length).toBeGreaterThan(120);
    }
    // Every operation that reads a file says the reference rule where a model will read it.
    for (const name of [
      INSPECT_DOCUMENT,
      READ_DOCUMENT,
      EDIT_DOCUMENT,
      "preview_document",
      COMPARE_DOCUMENT,
    ]) {
      const description = String(typed.find((tool) => tool.name === name)?.description);
      expect(description).toContain("file reference");
      expect(description).toContain("lease");
    }
  });
});
