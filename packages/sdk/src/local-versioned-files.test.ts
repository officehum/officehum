import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FileRef } from "./files.js";
import {
  fileStoreContract,
  versionedFileStoreContract,
  versionOf,
} from "./fixtures/file-store-contract.js";
import { localVersionedFileStore } from "./index.js";
import { localFileStore } from "./local-files.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "officehum-versions-"));
  dirs.push(dir);
  return { dir, store: localVersionedFileStore(dir) };
}
async function harness() {
  const { dir, store } = await setup();
  return {
    store,
    reopen: async () => localVersionedFileStore(dir),
    peer: async () => localVersionedFileStore(dir),
    corrupt: (ref: FileRef) => writeFile(join(dir, "blobs", versionOf(ref), ref.name), "tampered"),
    stored: async () => (await readdir(dir).catch(() => [])).length > 0,
  };
}

describe("the FileStore contract", () => fileStoreContract(harness));
describe("the VersionedFileStore contract", () => versionedFileStoreContract(harness));

const context = {
  taskId: "task:one",
  policyVersion: "policy:1",
  worker: { image: "reference:1", libraries: { paper: "test:1" } },
  argumentsSha256: "a".repeat(64),
};
const input = (operationId: string, text: string) => ({
  operationId,
  bytes: new TextEncoder().encode(text),
  name: "note.txt",
  mimeType: "text/plain",
  metadata: { createdBy: "role:test", source: "generated" as const },
  context,
});

it("fails closed on a corrupt manifest", async () => {
  const { dir, store } = await setup();
  const receipt = await store.create(input("create:1", "one"));
  await writeFile(join(dir, "manifest.json"), "{}");
  await expect(store.getHead(receipt.output.id)).rejects.toMatchObject({ code: "INTEGRITY" });
});

it("fails closed on a symlinked manifest", async () => {
  const one = await setup();
  await one.store.create(input("create:1", "one"));
  const two = await setup();
  await two.store.create(input("create:2", "two"));
  await unlink(join(two.dir, "manifest.json"));
  await symlink(join(one.dir, "manifest.json"), join(two.dir, "manifest.json"));
  await expect(two.store.lookupOperation("create:2")).rejects.toMatchObject({ code: "INTEGRITY" });
});

it("rejects a symlinked blob root before inherited put or reads", async () => {
  const outside = await setup();
  const inside = await setup();
  await symlink(join(outside.dir, "blobs"), join(inside.dir, "blobs"));
  await expect(
    inside.store.put({
      bytes: new TextEncoder().encode("outside"),
      name: "note.txt",
      mimeType: "text/plain",
      metadata: { createdBy: "test", source: "generated" },
    }),
  ).rejects.toMatchObject({ code: "INTEGRITY" });
  expect(await readdir(outside.dir)).not.toContain("blobs");
  await expect(inside.store.getHead("file_00000000000000000000000000")).rejects.toMatchObject({
    code: "INTEGRITY",
  });
});

it("fails closed on malformed manifest references, operation keys and fields", async () => {
  const { dir, store } = await setup();
  const one = await store.create(input("create:1", "one"));
  const two = await store.create(input("create:2", "two"));
  const valid = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as {
    files: Record<string, { initial: string; head: string; published: string | null }>;
    operations: Record<string, unknown>;
  };
  const existingOperationKey = Object.keys(valid.operations)[0];
  if (!existingOperationKey) throw new Error("Expected operation receipt");
  const cases = [
    {
      ...structuredClone(valid),
      files: {
        ...valid.files,
        [one.output.id]: { ...valid.files[one.output.id], head: "file_00000000000000000000000000" },
      },
    },
    {
      ...structuredClone(valid),
      files: {
        ...valid.files,
        [one.output.id]: { ...valid.files[one.output.id], head: two.output.versionId },
      },
    },
    {
      ...structuredClone(valid),
      operations: { ...valid.operations, ["0".repeat(64)]: valid.operations[existingOperationKey] },
    },
    { ...structuredClone(valid), unexpected: true },
  ];
  for (const malformed of cases) {
    await writeFile(join(dir, "manifest.json"), JSON.stringify(malformed));
    await expect(store.getHead(one.output.id)).rejects.toMatchObject({ code: "INTEGRITY" });
  }
});

it("fails closed on a symlinked committed blob payload", async () => {
  const one = await setup();
  const oneReceipt = await one.store.create(input("create:1", "one"));
  const two = await setup();
  const twoReceipt = await two.store.create(input("create:2", "two"));
  const payload = join(two.dir, "blobs", twoReceipt.output.versionId, "note.txt");
  await unlink(payload);
  await symlink(join(one.dir, "blobs", oneReceipt.output.versionId, "note.txt"), payload);
  await expect(
    two.store.getVersion(twoReceipt.output.id, twoReceipt.output.versionId),
  ).rejects.toMatchObject({ code: "INTEGRITY" });
});

it("does not commit through an occupied lock or adopt abandoned artifacts", async () => {
  const { dir, store } = await setup();
  const first = await store.create(input("create:1", "one"));
  await mkdir(join(dir, ".write-lock"));
  await expect(store.create(input("blocked:1", "blocked"))).rejects.toMatchObject({ code: "BUSY" });
  await rm(join(dir, ".write-lock"), { recursive: true, force: true });
  expect(await store.lookupOperation("blocked:1")).toBeUndefined();
  await localFileStore(join(dir, "blobs")).put({
    bytes: new TextEncoder().encode("orphan"),
    name: "orphan.txt",
    mimeType: "text/plain",
    metadata: { createdBy: "test", source: "generated" },
  });
  await writeFile(join(dir, ".manifest-abandoned.json"), "{}");
  const reopened = localVersionedFileStore(dir);
  expect(await reopened.getHead(first.output.id)).toEqual(first.output);
}, 10_000);
