import { createHash } from "node:crypto";
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
import { afterEach, expect, it } from "vitest";
import { localVersionedFileStore } from "./index.js";
import { localFileStore } from "./local-files.js";
import { intentHash } from "./versioned-file-validation.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "officehum-versions-"));
  dirs.push(dir);
  return { dir, store: localVersionedFileStore(dir) };
}
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

it("commits initial draft, versions and receipts across reopening", async () => {
  const { dir, store } = await setup();
  const first = await store.create(input("create:1", "one"));
  expect(first.intentSha256).toBe(
    intentHash({
      kind: "create",
      fileId: null,
      sourceVersionId: null,
      sourceSha256: null,
      name: "note.txt",
      mimeType: "text/plain",
      metadata: input("x", "x").metadata,
      context,
      contentSha256: createHash("sha256").update("one").digest("hex"),
      size: 3,
    }),
  );
  const edit = {
    ...input("edit:1", "two"),
    fileId: first.output.id,
    sourceVersionId: first.output.versionId,
  };
  const receipt = await store.putVersion(edit);
  expect(receipt.intentSha256).toBe(
    intentHash({
      kind: "version",
      fileId: first.output.id,
      sourceVersionId: first.output.versionId,
      sourceSha256: first.output.sha256,
      name: edit.name,
      mimeType: edit.mimeType,
      metadata: edit.metadata,
      context: edit.context,
      contentSha256: createHash("sha256").update("two").digest("hex"),
      size: 3,
    }),
  );
  expect(receipt.output.id).toBe(first.output.id);
  expect(receipt.output.versionId).not.toBe(first.output.versionId);
  expect(receipt.output.sha256).toBe(createHash("sha256").update("two").digest("hex"));
  const reopened = localVersionedFileStore(dir);
  expect(await reopened.lookupOperation("edit:1")).toEqual(receipt);
  expect(await reopened.putVersion(edit)).toEqual(receipt);
  expect(await reopened.create(input("create:1", "one"))).toEqual(first);
  expect(await reopened.getHead(first.output.id)).toEqual(receipt.output);
  expect(await reopened.info(first.output.id)).toEqual(first.output);
  expect((await reopened.get(first.output.id))?.ref).toEqual(first.output);
  expect((await reopened.getVersion(first.output.id, first.output.versionId))?.bytes).toEqual(
    new TextEncoder().encode("one"),
  );
  expect(await reopened.getPublished(first.output.id)).toBeUndefined();
});

it("rejects stale edits and changed-intent replay", async () => {
  const { store } = await setup();
  const first = await store.create(input("create:1", "one"));
  const edit = {
    ...input("edit:1", "two"),
    fileId: first.output.id,
    sourceVersionId: first.output.versionId,
  };
  const receipt = await store.putVersion(edit);
  await expect(store.putVersion({ ...edit, operationId: "edit:2" })).rejects.toMatchObject({
    code: "VERSION_CONFLICT",
  });
  await expect(
    store.putVersion({ ...edit, bytes: new TextEncoder().encode("three") }),
  ).rejects.toMatchObject({ code: "OPERATION_COLLISION" });
  expect(await store.putVersion(edit)).toEqual(receipt);
  expect(await store.lookupOperation("edit:2")).toBeUndefined();
});

it("serializes competing instances and duplicate submissions", async () => {
  const { dir, store } = await setup();
  const first = await store.create(input("create:1", "one"));
  const edit = {
    ...input("edit:1", "two"),
    fileId: first.output.id,
    sourceVersionId: first.output.versionId,
  };
  const peer = localVersionedFileStore(dir);
  const duplicates = await Promise.all([store.putVersion(edit), peer.putVersion(edit)]);
  expect(duplicates[0]).toEqual(duplicates[1]);
  const committed = duplicates[0];
  if (!committed) throw new Error("Expected a committed duplicate result");
  const next = {
    ...input("edit:2", "three"),
    fileId: first.output.id,
    sourceVersionId: committed.output.versionId,
  };
  const race = await Promise.allSettled([
    store.putVersion(next),
    peer.putVersion({ ...next, operationId: "edit:3" }),
  ]);
  expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(
    race
      .filter((r) => r.status === "rejected")
      .map((r) => (r as PromiseRejectedResult).reason.code),
  ).toEqual(["VERSION_CONFLICT"]);
});

it("binds every edit intent field and accepts reordered context keys", async () => {
  const { store } = await setup();
  const first = await store.create(input("create:1", "one"));
  const edit = {
    ...input("edit:1", "two"),
    fileId: first.output.id,
    sourceVersionId: first.output.versionId,
  };
  const receipt = await store.putVersion(edit);
  const changes = [
    { bytes: new TextEncoder().encode("different") },
    { name: "other.txt" },
    { mimeType: "text/markdown" },
    { metadata: { ...edit.metadata, createdBy: "other" } },
    { context: { ...context, taskId: "task:other" } },
    { context: { ...context, policyVersion: "policy:2" } },
    { context: { ...context, argumentsSha256: "b".repeat(64) } },
    { context: { ...context, worker: { ...context.worker, image: "reference:2" } } },
    { context: { ...context, worker: { ...context.worker, libraries: { paper: "test:2" } } } },
    { sourceVersionId: receipt.output.versionId },
    { sourceVersionId: "file_00000000000000000000000000" },
    { fileId: "file_00000000000000000000000000" },
  ];
  for (const change of changes) {
    await expect(store.putVersion({ ...edit, ...change } as typeof edit)).rejects.toMatchObject({
      code: "OPERATION_COLLISION",
    });
  }
  expect(
    await store.putVersion({ ...edit, metadata: { source: "generated", createdBy: "role:test" } }),
  ).toEqual(receipt);
  await expect(store.create(input("edit:1", "two"))).rejects.toMatchObject({
    code: "OPERATION_COLLISION",
  });
});

it("refuses corrupt committed bytes through version and receipt reads", async () => {
  const { dir, store } = await setup();
  const receipt = await store.create(input("create:1", "one"));
  await writeFile(join(dir, "blobs", receipt.output.versionId, "note.txt"), "tampered");
  await expect(store.getVersion(receipt.output.id, receipt.output.versionId)).rejects.toMatchObject(
    { code: "INTEGRITY" },
  );
  await expect(store.lookupOperation("create:1")).rejects.toMatchObject({ code: "INTEGRITY" });
});

it("snapshots inputs and detaches returned receipts", async () => {
  const { store } = await setup();
  const mutable = { ...input("create:1", "one"), context: structuredClone(context) };
  const pending = store.create(mutable);
  mutable.bytes.fill(0);
  mutable.context.worker.libraries.paper = "changed";
  const receipt = await pending;
  const versionId = receipt.output.versionId;
  (receipt.output.metadata as { createdBy: string }).createdBy = "changed";
  expect((await store.getVersion(receipt.output.id, versionId))?.bytes).toEqual(
    new TextEncoder().encode("one"),
  );
  expect((await store.lookupOperation("create:1"))?.kind).toBe("create");
  expect((await store.getHead(receipt.output.id))?.metadata.createdBy).toBe("role:test");
});

it("returns undefined for a version owned by another file", async () => {
  const { store } = await setup();
  const first = await store.create(input("create:1", "one"));
  const second = await store.create(input("create:2", "two"));
  await expect(store.getVersion(first.output.id, second.output.versionId)).resolves.toBeUndefined();
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

it("normalizes invalid inherited put input without exposing it", async () => {
  const { store } = await setup();
  await expect(
    store.put({
      bytes: new TextEncoder().encode("secret payload"),
      name: "../secret.txt",
      mimeType: "text/plain",
      metadata: { createdBy: "test", source: "generated" },
    }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT", message: "Invalid file input" });
  await expect(
    store.put({
      bytes: new TextEncoder().encode("secret payload"),
      name: "note.txt",
      mimeType: "invalid",
      metadata: { createdBy: "test", source: "generated" },
    }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT", message: "Invalid file input" });
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

it("leaves no operation receipt for invalid snapshots", async () => {
  const { store } = await setup();
  await expect(
    store.create({ ...input("invalid:1", "one"), name: "../note.txt" }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect(await store.lookupOperation("invalid:1")).toBeUndefined();
});

it("keeps base put as an initial version after later edits", async () => {
  const { dir } = await setup();
  const store = localVersionedFileStore(dir);
  const first = await store.put({
    bytes: new TextEncoder().encode("base"),
    name: "note.txt",
    mimeType: "text/plain",
    metadata: input("x", "x").metadata,
  });
  expect(first.operationId).toBeNull();
  expect(first.context).toBeNull();
  const created = await store.create(input("create:1", "versioned"));
  await store.putVersion({
    ...input("edit:1", "edited"),
    fileId: created.output.id,
    sourceVersionId: created.output.versionId,
  });
  expect((await store.get(first.id))?.ref).toEqual(first);
  expect(await store.info(first.id)).toEqual(first);
});

it("publishes conditionally and replays without rewinding a newer pointer", async () => {
  const { dir, store } = await setup();
  const first = await store.create(input("create:1", "one"));
  const initial = {
    operationId: "publish:1",
    fileId: first.output.id,
    expectedPublishedVersionId: null,
    versionId: first.output.versionId,
    approvalId: "approval:1",
  };
  const firstPublish = await store.publish(initial);
  expect(firstPublish.intentSha256).toBe(
    intentHash({
      kind: "publish",
      fileId: initial.fileId,
      expectedPublishedVersionId: null,
      versionId: initial.versionId,
      approvalId: initial.approvalId,
    }),
  );
  const second = await store.putVersion({
    ...input("edit:1", "two"),
    fileId: first.output.id,
    sourceVersionId: first.output.versionId,
  });
  expect(await store.getPublished(first.output.id)).toEqual(first.output);
  const secondPublish = await store.publish({
    operationId: "publish:2",
    fileId: first.output.id,
    expectedPublishedVersionId: first.output.versionId,
    versionId: second.output.versionId,
    approvalId: "approval:2",
  });
  const reopened = localVersionedFileStore(dir);
  expect(await reopened.publish(initial)).toEqual(firstPublish);
  expect(await reopened.getPublished(first.output.id)).toEqual(second.output);
  expect(await reopened.lookupOperation("publish:2")).toEqual(secondPublish);
  await expect(reopened.publish({ ...initial, operationId: "publish:3" })).rejects.toMatchObject({
    code: "VERSION_CONFLICT",
  });
  await expect(
    reopened.publish({ ...initial, approvalId: "approval:changed" }),
  ).rejects.toMatchObject({
    code: "OPERATION_COLLISION",
  });
  expect(await reopened.lookupOperation("publish:3")).toBeUndefined();
});

it("rejects missing approval, foreign versions and cross-kind publish operations", async () => {
  const { store } = await setup();
  const first = await store.create(input("create:1", "one"));
  const other = await store.create(input("create:2", "other"));
  const request = {
    operationId: "publish:1",
    fileId: first.output.id,
    expectedPublishedVersionId: null,
    versionId: first.output.versionId,
    approvalId: "approval:1",
  };
  await expect(store.publish({ ...request, approvalId: "" })).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
  await expect(
    store.publish({ ...request, versionId: other.output.versionId }),
  ).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await expect(store.publish({ ...request, operationId: "create:1" })).rejects.toMatchObject({
    code: "OPERATION_COLLISION",
  });
  expect(await store.getPublished(first.output.id)).toBeUndefined();
});

it("serializes competing publication and duplicate publish submissions", async () => {
  const { dir, store } = await setup();
  const first = await store.create(input("create:1", "one"));
  const peer = localVersionedFileStore(dir);
  const requests = ["publish:1", "publish:2"].map((operationId) => ({
    operationId,
    fileId: first.output.id,
    expectedPublishedVersionId: null,
    versionId: first.output.versionId,
    approvalId: `${operationId}:approval`,
  }));
  const [firstRaceRequest, secondRaceRequest] = requests;
  if (!firstRaceRequest || !secondRaceRequest) throw new Error("Expected two publish requests");
  const race = await Promise.allSettled([
    store.publish(firstRaceRequest),
    peer.publish(secondRaceRequest),
  ]);
  expect(race.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(
    race
      .filter((result) => result.status === "rejected")
      .map((result) => (result as PromiseRejectedResult).reason.code),
  ).toEqual(["VERSION_CONFLICT"]);
  const winner = race.find((result) => result.status === "fulfilled");
  if (winner?.status !== "fulfilled") throw new Error("Expected a publish winner");
  expect(await peer.getPublished(first.output.id)).toEqual(winner.value.published);

  const firstRequest = requests[0];
  if (!firstRequest) throw new Error("Expected a publish request");
  const duplicates = await Promise.all([
    peer.publish({
      ...firstRequest,
      operationId: "publish:duplicate",
      approvalId: "approval:duplicate",
      expectedPublishedVersionId: winner.value.published.versionId,
    }),
    store.publish({
      ...firstRequest,
      operationId: "publish:duplicate",
      approvalId: "approval:duplicate",
      expectedPublishedVersionId: winner.value.published.versionId,
    }),
  ]);
  expect(duplicates[0]).toEqual(duplicates[1]);
});

it("binds file, expected published version and proposed version to publish replay", async () => {
  const { store } = await setup();
  const first = await store.create(input("create:1", "one"));
  const other = await store.create(input("create:2", "two"));
  const request = {
    operationId: "publish:1",
    fileId: first.output.id,
    expectedPublishedVersionId: null,
    versionId: first.output.versionId,
    approvalId: "approval:1",
  };
  const receipt = await store.publish(request);
  const changes = [
    { fileId: other.output.id },
    { fileId: "file_00000000000000000000000000" },
    { expectedPublishedVersionId: other.output.versionId },
    { expectedPublishedVersionId: "file_00000000000000000000000000" },
    { versionId: other.output.versionId },
    { versionId: "file_00000000000000000000000000" },
  ];
  for (const change of changes) {
    await expect(store.publish({ ...request, ...change })).rejects.toMatchObject({
      code: "OPERATION_COLLISION",
    });
  }
  expect(await store.publish(request)).toEqual(receipt);
});

it("replays edits with reordered context and worker library keys", async () => {
  const { store } = await setup();
  const first = await store.create(input("create:1", "one"));
  const edit = {
    ...input("edit:1", "two"),
    fileId: first.output.id,
    sourceVersionId: first.output.versionId,
    context: {
      taskId: context.taskId,
      policyVersion: context.policyVersion,
      worker: { image: context.worker.image, libraries: { alpha: "1", beta: "2" } },
      argumentsSha256: context.argumentsSha256,
    },
  };
  const receipt = await store.putVersion(edit);
  expect(
    await store.putVersion({
      ...edit,
      context: {
        argumentsSha256: context.argumentsSha256,
        worker: { libraries: { beta: "2", alpha: "1" }, image: context.worker.image },
        policyVersion: context.policyVersion,
        taskId: context.taskId,
      },
    }),
  ).toEqual(receipt);
});

it("keeps the same file's initial get and info stable after a base put edit", async () => {
  const { store } = await setup();
  const first = await store.put({
    bytes: new TextEncoder().encode("base"),
    name: "note.txt",
    mimeType: "text/plain",
    metadata: input("x", "x").metadata,
  });
  await store.putVersion({
    ...input("edit:1", "edited"),
    fileId: first.id,
    sourceVersionId: first.versionId,
  });
  expect((await store.get(first.id))?.ref).toEqual(first);
  expect(await store.info(first.id)).toEqual(first);
});
