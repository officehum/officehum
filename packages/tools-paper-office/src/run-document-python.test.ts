import { describe, expect, it } from "vitest";
import type {
  DocumentRunOutcome,
  DocumentRunRequest,
  DocumentService,
} from "./document-service.js";
import { DEFAULT_LIMITS, type DocumentLease } from "./lease.js";
import {
  PAPER_OFFICE_PACK_ID,
  paperOfficeToolPack,
  RUN_DOCUMENT_PYTHON,
} from "./run-document-python.js";
import { docxPackage, sha256 } from "./test-helpers.js";

const FILE_A = `file_${"A".repeat(26)}`;

const LEASE: DocumentLease = {
  leaseId: "lease:1",
  taskId: "task:1",
  inputs: [
    {
      fileId: FILE_A,
      versionId: FILE_A,
      name: "brief.docx",
      format: "docx",
      sha256: sha256(docxPackage()),
      size: docxPackage().byteLength,
      writable: true,
    },
  ],
  outputFormats: ["docx"],
  limits: DEFAULT_LIMITS,
  expiresAt: "2999-01-01T00:00:00.000Z",
};

interface Recorded extends DocumentService {
  readonly requests: DocumentRunRequest[];
}

function fakeService(outcome?: DocumentRunOutcome): Recorded {
  const requests: DocumentRunRequest[] = [];
  return {
    requests,
    async runDocumentPython(request) {
      requests.push(request);
      return (
        outcome ?? {
          kind: "committed",
          receipt: {
            kind: "run",
            operationId: request.operationId,
            intentSha256: "a".repeat(64),
            taskId: request.taskId,
            policyVersion: "paper-documents:1",
            leaseId: request.lease.leaseId,
            codeSha256: "b".repeat(64),
            worker: {
              python: "3.13.17",
              image: "paper-worker:python-3.13",
              libraries: { python: "3.13.17", "paper-docx": "0.2.0" },
              modules: { docx: "1.2.0" },
            },
            reads: [],
            outputs: [
              {
                fileId: FILE_A,
                versionId: `file_${"B".repeat(26)}`,
                name: "reviewed.docx",
                format: "docx",
                sha256: sha256(docxPackage()),
                size: docxPackage().byteLength,
                sourceVersionId: FILE_A,
              },
            ],
            commit: [],
            result: { paragraphs: 3 },
            resultDeclared: true,
            reopen: ["reviewed.docx: 3 paragraphs"],
            notes: [],
            createdAt: "2026-10-23T00:00:00.000Z",
          },
        }
      );
    },
  };
}

interface Tool {
  readonly name: string;
  readonly replay?: string;
  execute(
    args: { code: string; arguments?: Record<string, unknown> },
    api: { taskId: string; conversationId: string; callId: string },
  ): Promise<{
    output: { type: string; text: string }[];
    isError?: boolean;
    details?: unknown;
  }>;
}

function toolOf(service: DocumentService, lease: DocumentLease | undefined) {
  const pack = paperOfficeToolPack({ service, leaseFor: async () => lease });
  const tool = pack.tools[0] as unknown as Tool;
  return { pack, tool };
}

const api = { taskId: "task:1", conversationId: "conv", callId: "call-1" };

describe("the portable Paper Office tool pack", () => {
  it("exposes run_document_python as a replay-safe tool with an explicit schema", () => {
    const { pack, tool } = toolOf(fakeService(), LEASE);
    expect(pack.id).toBe(PAPER_OFFICE_PACK_ID);
    expect(tool.name).toBe(RUN_DOCUMENT_PYTHON);
    expect(tool.replay).toBe("safe");
    const parameters = (tool as unknown as { parameters: { properties: Record<string, unknown> } })
      .parameters;
    expect(Object.keys(parameters.properties).sort()).toEqual(["arguments", "code"]);
  });

  it("derives the operation ID from the Pi Durable call, never from an argument", async () => {
    const service = fakeService();
    const { tool } = toolOf(service, LEASE);
    await tool.execute({ code: "documents.result(1)", arguments: { k: 1 } }, api);
    expect(service.requests[0]?.operationId).toBe("conv:call-1");
    expect(service.requests[0]?.arguments).toEqual({ k: 1 });
    expect(service.requests[0]?.lease).toBe(LEASE);
  });

  it("returns the receipt bounded for the model, with the output file IDs in the details", async () => {
    const { tool } = toolOf(fakeService(), LEASE);
    const result = await tool.execute({ code: "documents.result(1)" }, api);
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.output[0]?.text ?? "{}") as {
      ok: boolean;
      operationId: string;
      wrote: { fileId: string; versionOf: string }[];
    };
    expect(body.ok).toBe(true);
    expect(body.operationId).toBe("conv:call-1");
    expect(body.wrote[0]?.fileId).toBe(FILE_A);
    expect(body.wrote[0]?.versionOf).toBe(FILE_A);
    expect(result.details).toMatchObject({ operationId: "conv:call-1", files: [FILE_A] });
  });

  it("returns the same receipt for a replay of the same call", async () => {
    const service = fakeService();
    const { tool } = toolOf(service, LEASE);
    const first = await tool.execute({ code: "documents.result(1)" }, api);
    const second = await tool.execute({ code: "documents.result(1)" }, api);
    expect(second.output[0]?.text).toBe(first.output[0]?.text);
    expect(service.requests.map((request) => request.operationId)).toEqual([
      "conv:call-1",
      "conv:call-1",
    ]);
  });

  it("refuses when the task has no lease, without touching the service", async () => {
    const service = fakeService();
    const { tool } = toolOf(service, undefined);
    const result = await tool.execute({ code: "documents.result(1)" }, api);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output[0]?.text ?? "{}")).toMatchObject({
      ok: false,
      code: "no-lease",
    });
    expect(service.requests).toHaveLength(0);
  });

  it("returns a typed refusal from the service as an error result", async () => {
    const service = fakeService({
      kind: "refused",
      operationId: "conv:call-1",
      code: "symlink",
      message: "a staging entry was a symbolic link",
    });
    const { tool } = toolOf(service, LEASE);
    const result = await tool.execute({ code: "documents.result(1)" }, api);
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ operationId: "conv:call-1", code: "symlink" });
    expect(JSON.parse(result.output[0]?.text ?? "{}")).toMatchObject({
      ok: false,
      code: "symlink",
    });
  });

  it("refuses empty code without calling the service", async () => {
    const service = fakeService();
    const { tool } = toolOf(service, LEASE);
    const result = await tool.execute({ code: "   " }, api);
    expect(result.isError).toBe(true);
    expect(service.requests).toHaveLength(0);
  });
});
