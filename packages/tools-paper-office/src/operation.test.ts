import { describe, expect, it } from "vitest";
import { DocumentError } from "./errors.js";
import { DEFAULT_LIMITS, type DocumentLease, validateLease } from "./lease.js";
import {
  codeSha256,
  intentForRun,
  intentSha256,
  operationIdForCall,
  outputOperationId,
  validateWorkerIdentity,
  workerImage,
} from "./operation.js";

const FILE_A = `file_${"A".repeat(26)}`;
const FILE_B = `file_${"B".repeat(26)}`;

function lease(): DocumentLease {
  return validateLease({
    leaseId: "lease:1",
    taskId: "task:1",
    inputs: [
      {
        fileId: FILE_A,
        versionId: FILE_A,
        name: "brief.docx",
        format: "docx",
        sha256: "a".repeat(64),
        size: 10,
        writable: true,
      },
      {
        fileId: FILE_B,
        versionId: FILE_B,
        name: "book.xlsx",
        format: "xlsx",
        sha256: "b".repeat(64),
        size: 20,
        writable: false,
      },
    ],
    outputFormats: ["docx", "xlsx"],
    limits: DEFAULT_LIMITS,
    expiresAt: "2030-01-01T00:00:00.000Z",
  });
}

function intent(overrides: Record<string, unknown> = {}) {
  return intentForRun({
    operationId: "conv:call",
    taskId: "task:1",
    policyVersion: "paper-documents:1",
    code: "documents.result(1)",
    arguments: { k: 1 },
    lease: lease(),
    ...overrides,
  });
}

describe("durable operation identity", () => {
  it("derives one operation ID from the Pi Durable conversation and call identity", () => {
    expect(operationIdForCall({ conversationId: "conv", callId: "call-7" })).toBe("conv:call-7");
    expect(operationIdForCall({ conversationId: "conv", callId: "call-7" })).toBe(
      operationIdForCall({ conversationId: "conv", callId: "call-7" }),
    );
    const long = operationIdForCall({ conversationId: "c".repeat(400), callId: "call" });
    expect(Buffer.byteLength(long, "utf8")).toBeLessThanOrEqual(256);
    expect(long.startsWith("call~")).toBe(true);
  });

  it("binds the code, the arguments, the sources, the formats, the limits and the policy", () => {
    const base = intentSha256(intent());
    expect(base).toMatch(/^[0-9a-f]{64}$/u);
    expect(intentSha256(intent())).toBe(base);
    expect(intentSha256(intent({ code: "documents.result(2)" }))).not.toBe(base);
    expect(intentSha256(intent({ arguments: { k: 2 } }))).not.toBe(base);
    expect(intentSha256(intent({ policyVersion: "paper-documents:2" }))).not.toBe(base);
    expect(intentSha256(intent({ taskId: "task:2" }))).not.toBe(base);
    expect(intentSha256(intent({ operationId: "conv:other" }))).not.toBe(base);
    const smaller = lease();
    const widened = validateLease({
      ...JSON.parse(JSON.stringify(smaller)),
      limits: { ...DEFAULT_LIMITS, outputBytes: DEFAULT_LIMITS.outputBytes + 1 },
    });
    expect(intentSha256(intent({ lease: widened }))).not.toBe(base);
    const readOnly = validateLease({
      ...JSON.parse(JSON.stringify(smaller)),
      inputs: [
        {
          fileId: FILE_A,
          versionId: FILE_A,
          name: "brief.docx",
          format: "docx",
          sha256: "a".repeat(64),
          size: 10,
          writable: false,
        },
      ],
    });
    expect(intentSha256(intent({ lease: readOnly }))).not.toBe(base);
  });

  it("binds the source hashes, not the order the lease lists them in", () => {
    const two = intent();
    expect(two.sources.map((source) => source.versionId)).toEqual([FILE_A, FILE_B]);
    const id = codeSha256("x");
    expect(id).toBe(codeSha256("x"));
    expect(id).not.toBe(codeSha256("y"));
  });

  it("derives one stable output operation ID per name and format", () => {
    const first = outputOperationId("conv:call", "report.docx", "docx");
    expect(outputOperationId("conv:call", "report.docx", "docx")).toBe(first);
    expect(outputOperationId("conv:call", "report.xlsx", "xlsx")).not.toBe(first);
    expect(outputOperationId("conv:other", "report.docx", "docx")).not.toBe(first);
    expect(Buffer.byteLength(first, "utf8")).toBeLessThanOrEqual(256);
  });

  it("validates the worker's identity before it can enter a receipt", () => {
    const identity = validateWorkerIdentity({
      python: "3.13.17",
      modules: {
        "paper-docx:dist": "0.2.0",
        "paper-pptx:dist": "0.2.0",
        "paper-xlsx:dist": "0.2.1",
        docx: "1.2.0",
        pptx: "1.0.2",
        openpyxl: "3.1.5",
      },
    });
    expect(identity.image).toBe(workerImage("3.13.17"));
    expect(identity.libraries["paper-xlsx"]).toBe("0.2.1");
    expect(identity.modules.openpyxl).toBe("3.1.5");

    const wrongPin = () =>
      validateWorkerIdentity({
        python: "3.13.17",
        modules: {
          "paper-docx:dist": "0.9.9",
          "paper-pptx:dist": "0.2.0",
          "paper-xlsx:dist": "0.2.1",
        },
      });
    expect(wrongPin).toThrow(DocumentError);
    expect(() => validateWorkerIdentity({ python: "3.12.0", modules: {} })).toThrow(DocumentError);
  });
});
