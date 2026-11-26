/**
 * The behaviour every `FileStore` and `VersionedFileStore` owes its callers, as one suite each store
 * runs: the SDK's local stores (`local-files.test.ts`, `local-versioned-files.test.ts`) and a host's
 * own. A store's own tests keep only what
 * is about its layout on disk: manifests, symlinks, locks.
 *
 * A store is reached through a harness, so the suite never knows where its state lives. Test-only:
 * the package's build excludes it, and the office's tests import it by path.
 */

import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import type { FileRef, FileStore, VersionedFileStore } from "../files.js";
import { fileResult } from "../files.js";
import { intentHash } from "../versioned-file-validation.js";

/** One store, newly made over empty state, and the ways the suite reaches the same state. */
export interface StoreHarness<S> {
  readonly store: S;
  /** The same state opened again, as a restarted process opens it. */
  reopen(): Promise<S>;
  /** A second store open on the same state at the same time, as a second process would be. */
  peer(): Promise<S>;
  /** Changes the stored bytes of `ref`'s version behind the store's back. */
  corrupt(ref: FileRef): Promise<void>;
  /** Whether anything at all, bytes or a record, has been stored. */
  stored(): Promise<boolean>;
}

/** Opens a fresh harness; the calling test file removes what it made after each test. */
export type OpenHarness<S> = () => Promise<StoreHarness<S>>;

const metadata = { createdBy: "role:test", source: "uploaded" as const };
const putText = (store: FileStore) =>
  store.put({
    bytes: new TextEncoder().encode("hello"),
    name: "a.txt",
    mimeType: "text/plain",
    metadata,
  });
/** The version a ref names: its `versionId`, or for a base `FileRef` its own id. */
export const versionOf = (ref: FileRef): string =>
  "versionId" in ref && typeof ref.versionId === "string" ? ref.versionId : ref.id;

/** The base `FileStore` contract: `put`, `get` and `info`. */
export function fileStoreContract(open: OpenHarness<FileStore>): void {
  it("persists immutable bytes across reopen", async () => {
    const { store, reopen } = await open();
    const bytes = new TextEncoder().encode("hello");
    const ref = await store.put({ bytes, name: "note.txt", mimeType: "text/plain", metadata });
    expect(ref.id).toMatch(/^file_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(ref.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(ref.size).toBe(5);
    expect(await (await reopen()).get(ref.id)).toEqual({ ref, bytes });
    expect(await store.info(ref.id)).toEqual(ref);
    bytes[0] = 0;
    expect((await store.get(ref.id))?.bytes[0]).toBe(104);
  });

  it("snapshots name and MIME before the first await", async () => {
    const { store } = await open();
    const input = {
      bytes: new TextEncoder().encode("hello"),
      name: "note.txt",
      mimeType: "text/plain",
      metadata,
    };
    const pending = store.put(input);
    input.name = "../escaped.txt";
    input.mimeType = "image/png";
    const ref = await pending;

    expect(ref.name).toBe("note.txt");
    expect(ref.mimeType).toBe("text/plain");
    expect(await store.get(ref.id)).toMatchObject({
      ref: { name: "note.txt", mimeType: "text/plain" },
    });
  });

  it.each(["../x", "x/y", "x\\y", "", ".", "..", "meta.json"])("rejects name %j", async (name) => {
    const { store } = await open();
    await expect(
      store.put({ bytes: new Uint8Array(), name, mimeType: "text/plain", metadata }),
    ).rejects.toThrow();
  });

  it.each(["../escape", "file_../../x", "file_bad"])("rejects id %j", async (id) => {
    const { store } = await open();
    await expect(store.get(id)).rejects.toThrow();
    await expect(store.info(id)).rejects.toThrow();
  });

  it("refuses tampered bytes on get and info", async () => {
    const { store, corrupt } = await open();
    const ref = await putText(store);
    await corrupt(ref);
    await expect(store.get(ref.id)).rejects.toThrow();
    await expect(store.info(ref.id)).rejects.toThrow();
  });

  it("snapshots caller metadata", async () => {
    const { store } = await open();
    const mutable = { ...metadata };
    const ref = await store.put({
      bytes: new Uint8Array(),
      name: "x.txt",
      mimeType: "text/plain",
      metadata: mutable,
    });
    mutable.createdBy = "changed";
    expect((await store.info(ref.id))?.metadata.createdBy).toBe("role:test");
  });

  it("rejects sparse derivedFrom metadata before storing anything", async () => {
    const { store, stored } = await open();
    const derivedFrom = new Array<string>(1);

    await expect(
      store.put({
        bytes: new Uint8Array(),
        name: "derived.txt",
        mimeType: "text/plain",
        metadata: { ...metadata, source: "derived", derivedFrom },
      }),
    ).rejects.toThrow();
    expect(await stored()).toBe(false);
  });

  it.each(["text/plain\u0000evil", "x".repeat(256)])(
    "rejects invalid MIME type %j before persistence",
    async (mimeType) => {
      const { store, stored } = await open();
      await expect(
        store.put({ bytes: new Uint8Array(), name: "mime.txt", mimeType, metadata }),
      ).rejects.toThrow();
      expect(await stored()).toBe(false);
    },
  );

  it("returns a FileRef from put that fileResult accepts", async () => {
    const { store } = await open();
    const ref = await putText(store);
    expect(fileResult([ref]).details.files).toEqual([ref.id]);
  });

  it.each([
    ["image/png", [137, 80, 78, 71, 13, 10, 26, 10]],
    ["image/jpeg", [255, 216, 255]],
    ["image/gif", [...Buffer.from("GIF89a")]],
    ["image/webp", [...Buffer.from("RIFF0000WEBP")]],
    ["application/pdf", [...Buffer.from("%PDF-")]],
  ] as const)("checks signature for %s", async (mimeType, prefix) => {
    const { store } = await open();
    const bytes = Uint8Array.from(prefix);
    await expect(store.put({ bytes, name: "payload", mimeType, metadata })).resolves.toMatchObject({
      mimeType,
    });
    await expect(
      store.put({ bytes, name: "payload", mimeType: "text/plain", metadata }),
    ).rejects.toThrow();
    await expect(
      store.put({ bytes: bytes.slice(0, 1), name: "payload", mimeType, metadata }),
    ).rejects.toThrow();
  });

  it("keeps concurrent writes distinct", async () => {
    const { store } = await open();
    const refs = await Promise.all(Array.from({ length: 20 }, () => putText(store)));
    expect(new Set(refs.map((ref) => ref.id)).size).toBe(20);
    for (const ref of refs) expect(await store.info(ref.id)).toEqual(ref);
  });

  it.each(["x".repeat(256), "a\u0000b"])("refuses oversized or control names", async (name) => {
    const { store } = await open();
    await expect(
      store.put({ bytes: new Uint8Array(), name, mimeType: "text/plain", metadata }),
    ).rejects.toThrow();
  });

  it("refuses external provenance relabeling", async () => {
    const { store } = await open();
    await expect(
      store.put({
        bytes: new Uint8Array(),
        name: "a",
        mimeType: "text/plain",
        metadata: { createdBy: "email", source: "external", provenance: "internal" },
      }),
    ).rejects.toThrow();
  });

  it("keeps the outside system's id for a file that came from one, and refuses a malformed one", async () => {
    const { store, reopen } = await open();
    const externalId = { system: "esign", id: "env-1234" };
    const ref = await store.put({
      bytes: new TextEncoder().encode("%PDF-1.7"),
      name: "signed.pdf",
      mimeType: "application/pdf",
      metadata: { createdBy: "role:test", source: "external", externalId },
    });
    expect(ref.metadata.externalId).toEqual(externalId);
    expect((await (await reopen()).info(ref.id))?.metadata.externalId).toEqual(externalId);
    for (const bad of [
      { system: "" },
      { system: "esign", id: 1 },
      { system: "e", id: "1", x: 1 },
    ]) {
      await expect(
        store.put({
          bytes: new Uint8Array(),
          name: "a",
          mimeType: "text/plain",
          metadata: { createdBy: "role:test", source: "external", externalId: bad as never },
        }),
      ).rejects.toThrow();
    }
  });

  it("keeps the template a generated file was rendered from, and refuses a malformed one", async () => {
    const { store, reopen } = await open();
    const template = { name: "customer-statement", version: "sha256:0123456789ab" };
    const ref = await store.put({
      bytes: new TextEncoder().encode("%PDF-1.7"),
      name: "statement.pdf",
      mimeType: "application/pdf",
      metadata: { createdBy: "role:test", source: "generated", template },
    });
    expect(ref.metadata.template).toEqual(template);
    expect((await (await reopen()).info(ref.id))?.metadata.template).toEqual(template);
    for (const bad of [
      { name: "" },
      { name: "quote", version: 1 },
      { name: "q", version: "1", x: 1 },
    ]) {
      await expect(
        store.put({
          bytes: new Uint8Array(),
          name: "a",
          mimeType: "text/plain",
          metadata: { createdBy: "role:test", source: "generated", template: bad as never },
        }),
      ).rejects.toThrow();
    }
  });

  it("returns undefined for absent valid IDs", async () => {
    const { store } = await open();
    expect(await store.get("file_00000000000000000000000000")).toBeUndefined();
  });
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

/** The versioned document extension: immutable versions, receipts, compare-and-swap, publication. */
export function versionedFileStoreContract(open: OpenHarness<VersionedFileStore>): void {
  it("commits initial draft, versions and receipts across reopening", async () => {
    const { store, reopen } = await open();
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
    const reopened = await reopen();
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
    const { store } = await open();
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
    const { store, peer: openPeer } = await open();
    const first = await store.create(input("create:1", "one"));
    const edit = {
      ...input("edit:1", "two"),
      fileId: first.output.id,
      sourceVersionId: first.output.versionId,
    };
    const peer = await openPeer();
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
    const { store } = await open();
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
      await store.putVersion({
        ...edit,
        metadata: { source: "generated", createdBy: "role:test" },
      }),
    ).toEqual(receipt);
    await expect(store.create(input("edit:1", "two"))).rejects.toMatchObject({
      code: "OPERATION_COLLISION",
    });
  });

  it("refuses corrupt committed bytes through version and receipt reads", async () => {
    const { store, corrupt } = await open();
    const receipt = await store.create(input("create:1", "one"));
    await corrupt(receipt.output);
    await expect(
      store.getVersion(receipt.output.id, receipt.output.versionId),
    ).rejects.toMatchObject({ code: "INTEGRITY" });
    await expect(store.lookupOperation("create:1")).rejects.toMatchObject({ code: "INTEGRITY" });
  });

  it("snapshots inputs and detaches returned receipts", async () => {
    const { store } = await open();
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
    const { store } = await open();
    const first = await store.create(input("create:1", "one"));
    const second = await store.create(input("create:2", "two"));
    await expect(
      store.getVersion(first.output.id, second.output.versionId),
    ).resolves.toBeUndefined();
  });

  it("normalizes invalid inherited put input without exposing it", async () => {
    const { store } = await open();
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

  it("snapshots inherited put name and MIME type before asynchronous work", async () => {
    const { store } = await open();
    const mutable = {
      bytes: new TextEncoder().encode("original"),
      name: "original.txt",
      mimeType: "text/plain",
      metadata: { createdBy: "test", source: "generated" as const },
    };
    const pending = store.put(mutable);
    mutable.name = "../replacement.txt";
    mutable.mimeType = "invalid";
    await expect(pending).resolves.toMatchObject({ name: "original.txt", mimeType: "text/plain" });
  });

  it("leaves no operation receipt for invalid snapshots", async () => {
    const { store } = await open();
    await expect(
      store.create({ ...input("invalid:1", "one"), name: "../note.txt" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await store.lookupOperation("invalid:1")).toBeUndefined();
  });

  it("keeps base put as an initial version after later edits", async () => {
    const { store } = await open();
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
    const { store, reopen } = await open();
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
    const reopened = await reopen();
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
    const { store } = await open();
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
    const { store, peer: openPeer } = await open();
    const first = await store.create(input("create:1", "one"));
    const peer = await openPeer();
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

    const duplicates = await Promise.all([
      peer.publish({
        ...firstRaceRequest,
        operationId: "publish:duplicate",
        approvalId: "approval:duplicate",
        expectedPublishedVersionId: winner.value.published.versionId,
      }),
      store.publish({
        ...firstRaceRequest,
        operationId: "publish:duplicate",
        approvalId: "approval:duplicate",
        expectedPublishedVersionId: winner.value.published.versionId,
      }),
    ]);
    expect(duplicates[0]).toEqual(duplicates[1]);
  });

  it("binds file, expected published version and proposed version to publish replay", async () => {
    const { store } = await open();
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
    const { store } = await open();
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
    const { store } = await open();
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

  it("commits several files together, and answers a replay with the same receipts", async () => {
    const { store, reopen } = await open();
    const base = await store.create(input("create:base", "one"));
    const batch = [
      input("create:new", "fresh"),
      {
        ...input("edit:base", "two"),
        fileId: base.output.id,
        sourceVersionId: base.output.versionId,
      },
    ];
    const receipts = await store.commitVersions(batch);
    expect(receipts.map((receipt) => receipt.kind)).toEqual(["create", "version"]);
    expect((await store.getHead(base.output.id))?.versionId).toBe(receipts[1]?.output.versionId);

    // Reopened, the same batch is the same commit: no second version of either file.
    const reopened = await reopen();
    expect(await reopened.commitVersions(batch)).toEqual(receipts);
    expect(await reopened.lookupOperation("create:new")).toEqual(receipts[0]);
  });

  it("commits none of several files when one edit's source is no longer the head", async () => {
    const { store } = await open();
    const base = await store.create(input("create:base", "one"));
    const stale = base.output.versionId;
    const moved = await store.putVersion({
      ...input("edit:first", "two"),
      fileId: base.output.id,
      sourceVersionId: stale,
    });
    await expect(
      store.commitVersions([
        input("create:new", "fresh"),
        { ...input("edit:late", "three"), fileId: base.output.id, sourceVersionId: stale },
      ]),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(await store.lookupOperation("create:new")).toBeUndefined();
    expect(await store.lookupOperation("edit:late")).toBeUndefined();
    expect((await store.getHead(base.output.id))?.versionId).toBe(moved.output.versionId);
  });

  it("commits none of several files when two of them edit the same version", async () => {
    const { store } = await open();
    const base = await store.create(input("create:base", "one"));
    const edit = (operationId: string, text: string) => ({
      ...input(operationId, text),
      fileId: base.output.id,
      sourceVersionId: base.output.versionId,
    });
    await expect(
      store.commitVersions([edit("edit:a", "two"), edit("edit:b", "three")]),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(await store.lookupOperation("edit:a")).toBeUndefined();
    expect((await store.getHead(base.output.id))?.versionId).toBe(base.output.versionId);
  });
}
