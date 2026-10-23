import { describe, expect, it } from "vitest";
import { DocumentError } from "./errors.js";
import {
  DEFAULT_LIMITS,
  type DocumentLease,
  findLeasedInput,
  isLeaseExpired,
  permitsFormat,
  validateLease,
} from "./lease.js";

const FILE_A = `file_${"A".repeat(26)}`;

function lease(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    ],
    outputFormats: ["docx", "xlsx"],
    limits: DEFAULT_LIMITS,
    expiresAt: "2030-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function code(value: unknown): string {
  try {
    validateLease(value);
  } catch (error) {
    if (error instanceof DocumentError) return error.code;
    throw error;
  }
  return "accepted";
}

describe("the task lease", () => {
  it("accepts a well-formed lease and answers its questions", () => {
    const parsed = validateLease(lease());
    expect(parsed.leaseId).toBe("lease:1");
    expect(permitsFormat(parsed, "xlsx")).toBe(true);
    expect(permitsFormat(parsed, "pptx")).toBe(false);
    expect(findLeasedInput(parsed, FILE_A)?.name).toBe("brief.docx");
    expect(findLeasedInput(parsed, `file_${"B".repeat(26)}`)).toBeUndefined();
    expect(isLeaseExpired(parsed, new Date("2029-12-31T23:59:59.000Z"))).toBe(false);
    expect(isLeaseExpired(parsed, new Date("2030-01-01T00:00:00.000Z"))).toBe(true);
  });

  it("has no field for a path, a URL, a credential or a connector", () => {
    expect(code(lease({ root: "/etc" }))).toBe("invalid-lease");
    expect(code(lease({ url: "http://example.com" }))).toBe("invalid-lease");
    expect(code(lease({ apiKey: "sk-live" }))).toBe("invalid-lease");
    const input = {
      fileId: FILE_A,
      versionId: FILE_A,
      name: "brief.docx",
      format: "docx",
      sha256: "a".repeat(64),
      size: 10,
      writable: true,
      path: "/etc/passwd",
    };
    expect(code(lease({ inputs: [input] }))).toBe("invalid-lease");
  });

  it("refuses a lease that grants nothing usable", () => {
    expect(code(lease({ outputFormats: [] }))).toBe("invalid-lease");
    expect(code(lease({ outputFormats: ["pdf"] }))).toBe("invalid-lease");
    expect(code(lease({ outputFormats: ["docx", "docx"] }))).toBe("invalid-lease");
    expect(code(lease({ inputs: "everything" }))).toBe("invalid-lease");
    expect(code(lease({ expiresAt: "tomorrow" }))).toBe("invalid-lease");
    expect(code(lease({ leaseId: "" }))).toBe("invalid-lease");
  });

  it("refuses an input name that could leave the lease's directory", () => {
    const named = (name: string) => {
      const parsed = lease();
      return {
        ...parsed,
        inputs: [{ ...(parsed.inputs as Record<string, unknown>[])[0], name }],
      };
    };
    expect(code(named("../escape.docx"))).toBe("traversal");
    expect(code(named("a/b.docx"))).toBe("traversal");
    expect(code(named("a\\b.docx"))).toBe("traversal");
    expect(code(named(".."))).toBe("traversal");
  });

  it("refuses an input whose hash or size is not usable", () => {
    const input = (overrides: Record<string, unknown>) => {
      const parsed = lease();
      return {
        ...parsed,
        inputs: [{ ...(parsed.inputs as Record<string, unknown>[])[0], ...overrides }],
      };
    };
    expect(code(input({ sha256: "not-a-hash" }))).toBe("invalid-lease");
    expect(code(input({ size: -1 }))).toBe("invalid-lease");
    expect(code(input({ fileId: "brief.docx" }))).toBe("invalid-lease");
    expect(code(input({ writable: "yes" }))).toBe("invalid-lease");
  });

  it("refuses the same input version listed twice", () => {
    const parsed = lease();
    const first = (parsed.inputs as Record<string, unknown>[])[0] ?? {};
    expect(code({ ...parsed, inputs: [first, first] })).toBe("invalid-lease");
  });

  it("refuses a budget outside the range a lease may grant", () => {
    const limits = (overrides: Record<string, unknown>) =>
      lease({ limits: { ...DEFAULT_LIMITS, ...overrides } });
    expect(code(limits({ cpuSeconds: 0 }))).toBe("invalid-lease");
    expect(code(limits({ cpuSeconds: 10_000 }))).toBe("invalid-lease");
    expect(code(limits({ memoryBytes: 1_024 }))).toBe("invalid-lease");
    expect(code(limits({ fileCount: 0 }))).toBe("invalid-lease");
    expect(code(limits({ outputBytes: 0 }))).toBe("invalid-lease");
    expect(code(limits({ madeUpLimit: 1 }))).toBe("invalid-lease");
    expect(code(lease({ limits: {} }))).toBe("invalid-lease");
  });
});

describe("a lease is the whole grant", () => {
  it("never widens by reading a document or a prompt: the shape has nowhere to put it", () => {
    const parsed: DocumentLease = validateLease(lease());
    expect(Object.keys(parsed).sort()).toEqual([
      "expiresAt",
      "inputs",
      "leaseId",
      "limits",
      "outputFormats",
      "taskId",
    ]);
    expect(JSON.stringify(parsed)).not.toContain("http");
  });
});
