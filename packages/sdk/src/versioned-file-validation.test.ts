import { expect, it } from "vitest";
import type {
  CreateVersionInput,
  FileMetadata,
  PublishVersionInput,
  PutVersionInput,
} from "./files.js";
import { FileStoreError } from "./files.js";
import {
  intentHash,
  snapshotCreate,
  snapshotPublish,
  snapshotVersion,
} from "./versioned-file-validation.js";

const context = {
  taskId: "task:one",
  policyVersion: "policy:1",
  worker: { image: "reference:1", libraries: { paper: "test:1" } },
  argumentsSha256: "a".repeat(64),
};

const metadata = { createdBy: "test", source: "generated" as const };
const sparseIntentArray = new Array<unknown>(2);
sparseIntentArray[1] = 1;
const validCreate = (overrides: Partial<CreateVersionInput> = {}): CreateVersionInput => ({
  operationId: "op:task/call",
  bytes: Uint8Array.from([1, 2, 3]),
  name: "result.bin",
  mimeType: "application/octet-stream",
  metadata,
  context,
  ...overrides,
});
const validVersion = (overrides: Partial<PutVersionInput> = {}): PutVersionInput => ({
  ...validCreate(),
  fileId: "file_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  sourceVersionId: "file_01ARZ3NDEKTSV4RRFFQ69G5FAW",
  ...overrides,
});
const validPublish = (overrides: Partial<PublishVersionInput> = {}): PublishVersionInput => ({
  operationId: "op:task/call",
  fileId: "file_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  expectedPublishedVersionId: null,
  versionId: "file_01ARZ3NDEKTSV4RRFFQ69G5FAW",
  approvalId: "approval:one",
  ...overrides,
});

it("canonicalizes object keys recursively and preserves array order", () => {
  expect(intentHash({ b: { y: 2, x: 1 }, a: [1, 2] })).toBe(
    intentHash({ a: [1, 2], b: { x: 1, y: 2 } }),
  );
  expect(intentHash({ a: [1, 2] })).not.toBe(intentHash({ a: [2, 1] }));
});

it.each([NaN, Infinity, undefined, new Date(), { x: undefined }, sparseIntentArray])(
  "refuses noncanonical JSON %j",
  (value) => {
    expect(() => intentHash(value)).toThrow();
  },
);

it("refuses cycles", () => {
  const value: { self?: unknown } = {};
  value.self = value;
  expect(() => intentHash(value)).toThrow();
});

it.each([
  ["create name", () => snapshotCreate(validCreate({ name: "../x" }))],
  ["version file ID", () => snapshotVersion(validVersion({ fileId: "file_bad" }))],
  ["missing approval", () => snapshotPublish(validPublish({ approvalId: "" }))],
  [
    "undefined expected publication",
    () => snapshotPublish(validPublish({ expectedPublishedVersionId: undefined as never })),
  ],
  [
    "invalid context hash",
    () => snapshotCreate(validCreate({ context: { ...context, argumentsSha256: "bad" } })),
  ],
  [
    "unknown context fields",
    () => snapshotCreate(validCreate({ context: { ...context, extra: true } as never })),
  ],
  [
    "too many libraries",
    () =>
      snapshotCreate(
        validCreate({
          context: {
            ...context,
            worker: {
              ...context.worker,
              libraries: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`lib${i}`, "1"])),
            },
          },
        }),
      ),
  ],
  [
    "mismatched image signature",
    () =>
      snapshotCreate(
        validCreate({
          bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          mimeType: "image/jpeg",
        }),
      ),
  ],
] as const)("rejects %s with INVALID_INPUT", (_label, snapshot) => {
  try {
    snapshot();
    throw new Error("Expected snapshot to reject input");
  } catch (error) {
    expect(error).toBeInstanceOf(FileStoreError);
    expect(error).toMatchObject({ code: "INVALID_INPUT" });
  }
});

it("detaches bytes, metadata, and context before returning the snapshot", () => {
  const bytes = Uint8Array.from([1, 2, 3]);
  const mutableMetadata = { ...metadata };
  const mutableContext = structuredClone(context);
  const snapshot = snapshotCreate(
    validCreate({ bytes, metadata: mutableMetadata, context: mutableContext }),
  );
  bytes[0] = 9;
  mutableMetadata.createdBy = "changed";
  mutableContext.worker.image = "changed";
  expect([...snapshot.bytes]).toEqual([1, 2, 3]);
  expect(snapshot.metadata.createdBy).toBe("test");
  expect(snapshot.context.worker.image).toBe("reference:1");
});

it("snapshots version and publish inputs with explicit allowlisted fields", () => {
  expect(snapshotVersion(validVersion())).toMatchObject({
    operationId: "op:task/call",
    fileId: "file_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    sourceVersionId: "file_01ARZ3NDEKTSV4RRFFQ69G5FAW",
  });
  expect(snapshotPublish(validPublish())).toEqual(validPublish());
});

it("preserves own __proto__ worker library keys in canonical intent", () => {
  const libraryContext = (version: string) => ({
    ...context,
    worker: {
      ...context.worker,
      libraries: Object.fromEntries([["__proto__", version]]),
    },
  });
  const first = snapshotCreate(validCreate({ context: libraryContext("v1") }));
  const second = snapshotCreate(validCreate({ context: libraryContext("v2") }));

  expect(Object.hasOwn(first.context.worker.libraries, "__proto__")).toBe(true);
  expect(intentHash(first.context)).not.toBe(intentHash(second.context));
});

it("normalizes absent and undefined optional metadata fields identically", () => {
  const absent = snapshotCreate(validCreate({ metadata }));
  const explicitUndefined = snapshotCreate(
    validCreate({
      metadata: { ...metadata, provenance: undefined } as unknown as FileMetadata,
    }),
  );
  expect(absent.metadata).toEqual(explicitUndefined.metadata);
  expect(Object.hasOwn(explicitUndefined.metadata, "provenance")).toBe(false);
});
