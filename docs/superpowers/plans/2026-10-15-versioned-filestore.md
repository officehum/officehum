# Versioned FileStore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete RASF-3192 with a portable immutable document-version contract and a persistent local reference implementation supporting canonical operation replay, edit conflicts, and conditional publication.

**Architecture:** Preserve the existing FileStore and localFileStore unchanged. Add VersionedFileRef as a FileRef subtype and VersionedFileStore as an additive extension, with an explicit localVersionedFileStore factory. Store immutable payloads using the existing localFileStore in a private `blobs/` child; serialize manifest mutations under an exclusive local lock and atomically replace one manifest containing version heads, publication pointers, and operation receipts.

**Tech Stack:** TypeScript ESM, Node >=22.19.0 built-ins, Vitest 5.0.3; existing SDK dependencies only.

**Spec:** `docs/superpowers/specs/2026-10-14-paper-instruments-integration-design.md`, especially FileStore and review, durable lifecycle steps 2–6, and failure/compatibility rules. This is the SDK portion of the file foundation gate, not the whole gate.

## Global Constraints

- “No new dependencies.” (RASF-3192.)
- “Role packages remain independent of `@officehum/office` and `@officehum/cli`.”
- “FileStore is the byte/version authority; Pi Durable is the workflow and approval authority.”
- “Reuse of the ID with changed intent fails closed.”
- “A stale edit gets a conflict result and must rebase or explicitly fork; it cannot overwrite a newer revision.”
- “New documents enter FileStore as drafts automatically.”
- “Replaying an approved publish returns the same published version without a second pointer move.”
- Preserve base `FileRef`, `FileStore`, `localFileStore`, existing on-disk attachment layout, signature checks, provenance validation, `fileResult`, and its 100,000-byte preview limit.
- This plan adds no Office backend, SQLite, task leases, workspace revisions, worker, tools, review UI, approval verifier, retention, quotas, migration, or production deployment.

## Review Focus

1. Reordered metadata keys represent identical intent, but changed bytes, metadata, source, task, policy or worker identity must reject operation reuse (Task 3).
2. Concurrent instances editing one source permit exactly one next version; replay still succeeds after the head advances (Task 3).
3. A successful publish replay after a later publication returns its original receipt and never rewinds the pointer (Task 4).
4. Corrupt or symlinked manifest/payload and cross-file version references fail closed without silently creating an empty store (Task 3).
5. Mutable input/returned objects cannot alter stored intent, versions, hashes, or receipts; invalid input cannot leave a committed operation (Task 3).

---

## Status, boundary and decisions

Verified 2026-10-15: base FileStore PR #15 merged; branch `codex/paper-file-versions` starts from `dab5725`. RASF-3192 is In Progress. RASF-3193 is Backlog and blocked by 3192 and runtime RASF-3104. RASF-3283 is Backlog and blocked by 3192, 3193 and sandbox RASF-3111. This plan can finish the SDK extension without claiming those dependent tickets complete.

One independently shippable slice, delivered in four reviewable commits. Human review of this new plan precedes implementation. Preserve the user's execution choice: GPT-6 Luna implementers using subagent-driven execution; GPT-6 Sol planning. Do not start implementation from this planning turn.

IDs: logical file IDs and version IDs both use the existing validated `file_` ULID syntax. They occupy separate semantic fields. A version ID is the underlying immutable blob ID. The initial logical file ID equals its first version ID; later versions keep the logical ID and receive fresh version IDs, even if bytes are identical. Hashes identify content; version IDs identify commits.

The existing FileRef stays unchanged because its strict stored metadata validator rejects extra fields. The new type extends it only at the public versioned boundary. `id` always means logical file ID. `get(id)` and `info(id)` return the initial immutable version forever, preserving the attachment meaning of the inherited API. `getHead(id)` resolves the latest draft/proposal; `getPublished(id)` resolves the explicit published pointer. No method implicitly publishes. Store roots are distinct; no implicit adoption or migration of base-store directories.

Initial `put` preserves its existing signature and creates a draft; it has no caller operation ID and is not replay-safe. A new `create` method creates a replay-safe initial version using the same intent context as `putVersion`. Callers implementing mutating document tools must use `create`, not `put`. Both return the same initial-version shape; create returns a receipt. This avoids a replay hole for document creation while retaining the base API.

Mutation errors use exported `FileStoreError` codes `INVALID_INPUT`, `NOT_FOUND`, `VERSION_CONFLICT`, `OPERATION_COLLISION`, `INTEGRITY`, `BUSY`. Validation errors from reused base helpers are wrapped as INVALID_INPUT at entry; corrupted on-disk data becomes INTEGRITY. Failed conflicts are not committed receipts: their operation ID can be retried against unchanged intent, or a new operation ID used after rebase. Successful receipts are immutable and durable across reopening the reference store.

Publication accepts an explicit `operationId` in addition to the issue's four fields. It is globally unique in the same ledger as create/edit; `approvalId` identifies host approval evidence, not an idempotency key. The SDK requires a nonempty approval ID but does not verify an approval: trusted host code must check the Pi Durable record and exact hashes before calling publish. Tools must never expose this store directly. The contract provides a pointer CAS primitive, not a policy bypass.

Local durability: payload install precedes manifest commit; one atomic same-directory rename makes the new version/head/receipt or publication/receipt visible together. A failed manifest write can leave an unreferenced immutable blob, never a visible incomplete version. Readers validate blobs and refs. This is a host-owned local reference implementation, not a power-loss/fsync or automatic abandoned-lock recovery guarantee. An interrupted process may leave `.write-lock`; subsequent writes time out with BUSY. Reads and operation lookup remain available. A trusted operator must verify no live writer before removing that lock; automatic lock stealing and cleanup are outside scope. RASF-3193 owns robust restart reconciliation, quotas and garbage collection.

## File map

| File | Responsibility |
| --- | --- |
| Modify `packages/sdk/src/files.ts` | Add portable types, error and interface, retain base declarations verbatim |
| Create `packages/sdk/src/versioned-file-validation.ts` | Validate/snapshot mutation input and canonicalize known JSON intent |
| Create `packages/sdk/src/versioned-file-validation.test.ts` | Canonicalization and runtime rejection tests |
| Create `packages/sdk/src/local-versioned-files.ts` | Public factory and version/publication state transitions |
| Create `packages/sdk/src/local-versioned-state.ts` | Local manifest schema, strict reads, locking and atomic writes |
| Create `packages/sdk/src/local-versioned-state.test.ts` | Atomic snapshot/lock tests |
| Create `packages/sdk/src/local-versioned-files.test.ts` | Persistence, concurrency, corruption, replay, publication tests |
| Modify `packages/sdk/src/index.ts` | Export new public types/error and factory |
| Modify `docs/design/file-store.md` | Document new API, replay/CAS semantics and local limitations |

Existing `files.test.ts`, `local-files.test.ts`, and `file-validation.ts` are regression inputs, not refactor targets. Do not add package dependencies or modify lockfiles.

### Task 1: Portable contract and canonical intent

**Files:** Modify `packages/sdk/src/files.ts` and `packages/sdk/src/index.ts`; create `packages/sdk/src/versioned-file-validation.ts` and `packages/sdk/src/versioned-file-validation.test.ts`.

**Interfaces:** Consumes `FileRef`, `FileMetadata`, `FileStore`, existing validation helpers. Produces the following public contract (append to files.ts), and internal `snapshotCreate`, `snapshotVersion`, `snapshotPublish`, `intentHash` exports used by Tasks 3/4. Snapshot helpers return detached, fully validated inputs; bytes are copied synchronously before the first await.

- [ ] **Step 1: Add failing canonicalization tests.**

```ts
import { expect, it } from "vitest";
import { intentHash } from "./versioned-file-validation.js";

it("canonicalizes object keys recursively and preserves array order", () => {
  expect(intentHash({ b: { y: 2, x: 1 }, a: [1, 2] }))
    .toBe(intentHash({ a: [1, 2], b: { x: 1, y: 2 } }));
  expect(intentHash({ a: [1, 2] })).not.toBe(intentHash({ a: [2, 1] }));
});
it.each([NaN, Infinity, undefined, new Date(), { x: undefined }, [, 1]])(
  "refuses noncanonical JSON %j", (value) => {
    expect(() => intentHash(value)).toThrow();
  },
);
it("refuses cycles", () => {
  const value: { self?: unknown } = {};
  value.self = value;
  expect(() => intentHash(value)).toThrow();
});
```

Run: `npx vitest run packages/sdk/src/versioned-file-validation.test.ts`.
Expected: FAIL because module is absent.

- [ ] **Step 2: Add the public contract and exports.**

```ts
export interface VersionContext {
  readonly taskId: string;
  readonly policyVersion: string;
  readonly worker: {
    readonly image: string;
    readonly libraries: Readonly<Record<string, string>>;
  };
  readonly argumentsSha256: string;
}
export interface VersionedFileRef extends FileRef {
  readonly versionId: string;
  readonly sourceVersionId: string | null;
  readonly operationId: string | null;
  readonly context: VersionContext | null;
}
export interface CreateVersionInput {
  readonly operationId: string;
  readonly bytes: Uint8Array;
  readonly name: string;
  readonly mimeType: string;
  readonly metadata: FileMetadata;
  readonly context: VersionContext;
}
export interface PutVersionInput extends CreateVersionInput {
  readonly fileId: string;
  readonly sourceVersionId: string;
}
export interface PublishVersionInput {
  readonly operationId: string;
  readonly fileId: string;
  readonly expectedPublishedVersionId: string | null;
  readonly versionId: string;
  readonly approvalId: string;
}
export interface VersionCommitReceipt {
  readonly kind: "create" | "version";
  readonly operationId: string;
  readonly intentSha256: string;
  readonly source: VersionedFileRef | null;
  readonly output: VersionedFileRef;
}
export interface PublishReceipt {
  readonly kind: "publish";
  readonly operationId: string;
  readonly intentSha256: string;
  readonly approvalId: string;
  readonly previous: VersionedFileRef | null;
  readonly published: VersionedFileRef;
}
export type FileOperationReceipt = VersionCommitReceipt | PublishReceipt;
export class FileStoreError extends Error {
  constructor(
    readonly code: "INVALID_INPUT" | "NOT_FOUND" | "VERSION_CONFLICT" |
      "OPERATION_COLLISION" | "INTEGRITY" | "BUSY",
    message: string,
  ) { super(message); this.name = "FileStoreError"; }
}
export interface VersionedFileStore extends FileStore {
  put(input: Parameters<FileStore["put"]>[0]): Promise<VersionedFileRef>;
  get(id: string): Promise<{ ref: VersionedFileRef; bytes: Uint8Array } | undefined>;
  info(id: string): Promise<VersionedFileRef | undefined>;
  create(input: CreateVersionInput): Promise<VersionCommitReceipt>;
  putVersion(input: PutVersionInput): Promise<VersionCommitReceipt>;
  getVersion(fileId: string, versionId: string):
    Promise<{ ref: VersionedFileRef; bytes: Uint8Array } | undefined>;
  getHead(fileId: string): Promise<VersionedFileRef | undefined>;
  getPublished(fileId: string): Promise<VersionedFileRef | undefined>;
  lookupOperation(operationId: string): Promise<FileOperationReceipt | undefined>;
  publish(input: PublishVersionInput): Promise<PublishReceipt>;
}
```

Export all these names from index.ts. `context` carries the bound task, worker/library versions, policy and argument/code hash. Validation reports, previews and refusal receipts remain DocumentService concerns; do not fabricate them in a byte store.

- [ ] **Step 3: Implement canonical JSON hashing and snapshot validation.**

```ts
import { createHash } from "node:crypto";
import { FileStoreError } from "./files.js";

export function intentHash(value: unknown): string {
  const seen = new Set<object>();
  function encode(item: unknown): string {
    if (item === null || typeof item === "string" || typeof item === "boolean") {
      return JSON.stringify(item);
    }
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== "object" || item === null || seen.has(item)) {
      throw new FileStoreError("INVALID_INPUT", "Intent must be finite acyclic JSON");
    }
    seen.add(item);
    try {
      if (Array.isArray(item)) {
        for (let i = 0; i < item.length; i++) {
          if (!Object.hasOwn(item, i)) throw new FileStoreError("INVALID_INPUT", "Sparse intent array");
        }
        return `[${item.map(encode).join(",")}]`;
      }
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
        throw new FileStoreError("INVALID_INPUT", "Intent must contain plain objects");
      }
      const record = item as Record<string, unknown>;
      return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${encode(record[key])}`).join(",")}}`;
    } finally { seen.delete(item); }
  }
  return createHash("sha256").update(encode(value)).digest("hex");
}
```

Snapshot helpers have signatures `(input: CreateVersionInput): CreateVersionInput`, `(input: PutVersionInput): PutVersionInput`, `(input: PublishVersionInput): PublishVersionInput`. Clone bytes with Uint8Array.from and metadata/context with structuredClone. Require Uint8Array before copying. Reject unknown top-level/context/worker keys. Reuse assertName/assertMimeType/assertMetadata/assertSignature/assertId. `operationId`, `taskId`, `approvalId`, `policyVersion`, worker image, library keys/values: nonempty strings, no control characters, maximum 256 UTF-8 bytes each; worker libraries maximum 32 own entries. `argumentsSha256` must be lowercase 64 hex characters. Operation IDs are opaque strings, never filesystem path components: `op:task/call` is valid. `expectedPublishedVersionId` must be explicitly null or a valid ID; undefined is invalid. Optional FileMetadata fields are normalized by omitting undefined before hashing (the base validator permits those fields absent). Use explicit allowlisted object construction so canonical intent never contains accidental undefined values.

Canonical create/edit intent is `{ kind, fileId: string|null, sourceVersionId: string|null, sourceSha256: string|null, name, mimeType, metadata, context, contentSha256, size }`. Canonical publish intent is `{ kind: "publish", fileId, expectedPublishedVersionId, versionId, approvalId }`. Kind is mandatory to prevent cross-method reuse. Exclude timestamps, generated IDs, lock state and operation ID itself. Source hash is resolved from the immutable source ref before hashing. Validate/snapshot before filesystem access; wrap helper/clone errors with INVALID_INPUT, without echoing input content.

- [ ] **Step 4: Add and run snapshot tests.** Add executable table tests for invalid names (`../x`), invalid IDs (`file_bad`), missing approval, undefined expected publication, invalid context hash, unknown context fields, 33 library entries, and bytes that claim image/jpeg but begin with PNG signature. Construct valid context as below. Assert each snapshot helper throws FileStoreError with INVALID_INPUT. Test mutable bytes, metadata and context after snapshot leave the snapshot unchanged. Test missing optional metadata and explicitly undefined optional metadata normalize identically.

```ts
const context = {
  taskId: "task:one", policyVersion: "policy:1",
  worker: { image: "reference:1", libraries: { paper: "test:1" } },
  argumentsSha256: "a".repeat(64),
};
```

Run: `npx vitest run packages/sdk/src/versioned-file-validation.test.ts && npm run typecheck -w @officehum/sdk`.
Expected: PASS. Commit only Task 1 files: `git commit -m "feat(sdk): define versioned file and operation contracts"`.

### Task 2: Atomic local manifest and exclusive mutation helper

**Files:** Create `packages/sdk/src/local-versioned-state.ts` and `packages/sdk/src/local-versioned-state.test.ts`.

**Interfaces:** Consumes Task 1 types/validation. Produces `VersionedState`, `readState(root: string): Promise<VersionedState>`, and `mutateState<T>(root: string, change: (state: VersionedState) => Promise<T>): Promise<T>` for Task 3. Mutations persist atomically before returning detached results.

- [ ] **Step 1: Write failing state-helper tests.**

```ts
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readState, mutateState } from "./local-versioned-state.js";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "officehum-version-state-"));
  dirs.push(dir);
  return dir;
}
it("persists a detached manifest and serializes separate callers", async () => {
  const dir = await setup();
  let releaseFirst!: () => void;
  let markFirstEntered!: () => void;
  const held = new Promise<void>(resolve => { releaseFirst = resolve; });
  const firstEntered = new Promise<void>(resolve => { markFirstEntered = resolve; });
  let secondEntered = false;
  const firstPending = mutateState(dir, async state => {
    markFirstEntered();
    await held;
    return state;
  });
  await firstEntered;
  const secondPending = mutateState(dir, async state => {
    secondEntered = true;
    return state;
  });
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(secondEntered).toBe(false);
  } finally { releaseFirst(); }
  const [first, second] = await Promise.all([firstPending, secondPending]);
  expect(secondEntered).toBe(true);
  expect(first).toEqual({ schema: 1, files: {}, versions: {}, operations: {} });
  expect(second).toEqual(first);
  expect(JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"))).toEqual(first);
  (first.files as Record<string, unknown>).changed = {};
  expect(await readState(dir)).toEqual(second);
});
it("failed mutation preserves the prior snapshot and releases its lock", async () => {
  const dir = await setup();
  await mutateState(dir, async () => undefined);
  const before = await readFile(join(dir, "manifest.json"), "utf8");
  await expect(mutateState(dir, async () => { throw new Error("injected failure"); }))
    .rejects.toThrow("injected failure");
  expect(await readFile(join(dir, "manifest.json"), "utf8")).toBe(before);
  await expect(mutateState(dir, async () => "recovered")).resolves.toBe("recovered");
});
it("corrupt snapshots fail closed", async () => {
  const dir = await setup();
  await writeFile(join(dir, "manifest.json"), "{}");
  await expect(readState(dir)).rejects.toMatchObject({ code: "INTEGRITY" });
});
it("times out a preexisting lock without deleting it", async () => {
  const dir = await setup();
  await mkdir(join(dir, ".write-lock"));
  await expect(mutateState(dir, async () => undefined)).rejects.toMatchObject({ code: "BUSY" });
  await expect(mkdir(join(dir, ".write-lock"))).rejects.toMatchObject({ code: "EEXIST" });
}, 10_000);
```

Run: `npx vitest run packages/sdk/src/local-versioned-state.test.ts`.
Expected: FAIL because module is absent.

- [ ] **Step 2: Implement strict snapshot persistence and serialization.** Use this exact internal schema:

```ts
import type { FileOperationReceipt, VersionedFileRef } from "./files.js";
export interface VersionedState {
  schema: 1;
  files: Record<string, { initial: string; head: string; published: string | null }>;
  versions: Record<string, VersionedFileRef>;
  operations: Record<string, FileOperationReceipt>;
}
```

Root contains `blobs/`, `manifest.json`, ephemeral `.manifest-<random>.json`, and `.write-lock/`. Store operation map keys as SHA-256 of UTF-8 operation IDs; receipts retain and validate the exact ID. Use `Object.hasOwn` for lookups to avoid prototype-key confusion. Files/versions use validated file IDs only.

`readState`: validate root is a real directory if present; missing root/manifest yields a fresh schema-1 empty state. ENOENT alone means missing; JSON parse failure, unknown schema/fields, dangling refs and other filesystem errors must not become empty state. Open manifest with O_NOFOLLOW; lstat regular file before reading, stat the handle too. Strictly validate each ref's base projection using assertRef; validate all extension fields, context, IDs, hash formats and timestamps. Ensure each file's initial/head/published belongs to that file, source chains stay in that file, each non-null operation points to a matching commit receipt, operation digest keys match the stored IDs, and receipt output/source/publication refs exactly match stored immutable refs. Throw INTEGRITY on malformed state. Return detached state.

`mutateState`: mkdir root 0700, assert real directory, acquire `.write-lock` with exclusive mkdir (0700). On EEXIST retry with Node timers/promises setTimeout(10), at most 500 attempts, then BUSY. Do not follow or remove a preexisting symlink lock; fail INTEGRITY. After acquiring, re-read state from disk (never cache it), invoke callback, validate resulting state, write snapshot to random same-root temp using `wx` 0600, rename over manifest, clone result, release only this call's lock in finally. Cleanup only this call's temp on error. No lock stealing. Use a fixed lock path and hashed ledger keys; never concatenate opaque input into a path.

Storage validation helpers must be explicit functions in this file, not unchecked `JSON.parse(...) as VersionedState`. Convert stored snapshots to validated typed objects, reject extra fields. Reading an operation receipt must validate its referenced payload(s) through the blob store before returning success; do the same for getHead/getPublished/info/get/getVersion. This prevents replaying a successful receipt whose output was corrupted or removed.

- [ ] **Step 3: Run state-helper tests and commit.**

Run: `npx vitest run packages/sdk/src/local-versioned-state.test.ts && npm run typecheck -w @officehum/sdk`.
Expected: PASS. Review strict parsing, lock ownership, release-on-error and rename behavior before higher-level transitions. The five-second lock wait is bounded contention handling, not a lease; a slow active writer can cause BUSY and callers may retry unchanged intent. Tests using an existing lock have an explicit ten-second timeout. Never infer abandonment from elapsed time.

Commit: `git add packages/sdk/src/local-versioned-state.ts packages/sdk/src/local-versioned-state.test.ts && git commit -m "feat(sdk): add atomic local version manifest transactions"`.

### Task 3: Local immutable commits, replay and stale-source conflicts

**Files:** Create `packages/sdk/src/local-versioned-files.ts`, `packages/sdk/src/local-versioned-files.test.ts`; modify index.ts to export `localVersionedFileStore`.

**Interfaces:** Consumes Task 1 types/snapshots and `localFileStore`. Produces the interim `localVersionedFileStore(dir: string): Omit<VersionedFileStore, "publish">`; Task 4 completes the public implementation by adding publish and changing the return annotation to VersionedFileStore. Consumes the state helper from Task 2. Internal state exports: `readState(root: string): Promise<VersionedState>`, `mutateState<T>(root: string, change: (state: VersionedState) => Promise<T>): Promise<T>`. Mutation callback mutates detached state; helper persists it before returning detached result. The publication steps use this exact transaction helper.

- [ ] **Step 1: Create failing lifecycle/replay tests.** Include this test harness in the new test file:

```ts
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile, symlink, unlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { localVersionedFileStore } from "./index.js";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "officehum-versions-"));
  dirs.push(dir);
  return { dir, store: localVersionedFileStore(dir) };
}
const context = {
  taskId: "task:one", policyVersion: "policy:1",
  worker: { image: "reference:1", libraries: { paper: "test:1" } },
  argumentsSha256: "a".repeat(64),
};
const input = (operationId: string, text: string) => ({
  operationId, bytes: new TextEncoder().encode(text), name: "note.txt", mimeType: "text/plain",
  metadata: { createdBy: "role:test", source: "generated" as const }, context,
});
it("commits initial draft, versions and receipts across reopening", async () => {
  const { dir, store } = await setup();
  const first = await store.create(input("create:1", "one"));
  const edit = { ...input("edit:1", "two"), fileId: first.output.id, sourceVersionId: first.output.versionId };
  const receipt = await store.putVersion(edit);
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
  expect((await reopened.getVersion(first.output.id, first.output.versionId))?.bytes)
    .toEqual(new TextEncoder().encode("one"));
  expect(await reopened.getPublished(first.output.id)).toBeUndefined();
});
it("rejects stale edits and changed-intent replay", async () => {
  const { store } = await setup();
  const first = await store.create(input("create:1", "one"));
  const edit = { ...input("edit:1", "two"), fileId: first.output.id, sourceVersionId: first.output.versionId };
  const receipt = await store.putVersion(edit);
  await expect(store.putVersion({ ...edit, operationId: "edit:2" }))
    .rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  await expect(store.putVersion({ ...edit, bytes: new TextEncoder().encode("three") }))
    .rejects.toMatchObject({ code: "OPERATION_COLLISION" });
  expect(await store.putVersion(edit)).toEqual(receipt);
  expect(await store.lookupOperation("edit:2")).toBeUndefined();
});
it("serializes competing instances and duplicate submissions", async () => {
  const { dir, store } = await setup();
  const first = await store.create(input("create:1", "one"));
  const edit = { ...input("edit:1", "two"), fileId: first.output.id, sourceVersionId: first.output.versionId };
  const peer = localVersionedFileStore(dir);
  const duplicates = await Promise.all([store.putVersion(edit), peer.putVersion(edit)]);
  expect(duplicates[0]).toEqual(duplicates[1]);
  const next = { ...input("edit:2", "three"), fileId: first.output.id, sourceVersionId: duplicates[0]!.output.versionId };
  const race = await Promise.allSettled([store.putVersion(next), peer.putVersion({ ...next, operationId: "edit:3" })]);
  expect(race.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(race.filter(r => r.status === "rejected").map(r => r.reason.code)).toEqual(["VERSION_CONFLICT"]);
});
```

Run: `npx vitest run packages/sdk/src/local-versioned-files.test.ts`.
Expected: FAIL because factory is absent.

- [ ] **Step 2: Implement initial put/create, get variants, and putVersion.** Use these state transitions inside mutateState:

```ts
// after synchronous snapshot and source resolution, before checking a mutable head:
const previous = state.operations[operationKey];
if (previous) {
  if (previous.intentSha256 !== canonicalHash || previous.kind !== kind) {
    throw new FileStoreError("OPERATION_COLLISION", "Operation ID has different intent");
  }
  return structuredClone(previous);
}
// putVersion only, after replay lookup:
if (state.files[fileId]!.head !== sourceVersionId) {
  throw new FileStoreError("VERSION_CONFLICT", "Source version is no longer the head");
}
```

Validate membership/source existence without relying on the current head to compute intent. Replay check must precede head CAS: otherwise exact replay fails after another edit. If an existing ledger entry is a different kind, throw OPERATION_COLLISION before trying to interpret it. Source refs are immutable; changed source under a used operation ID is OPERATION_COLLISION even if the new source is absent. On an existing edit receipt, first compare request fileId/sourceVersionId to receipt.output.id/receipt.source.versionId; mismatch is immediately OPERATION_COLLISION. If they match, construct the full canonical intent using receipt.source.sha256, compare hashes, validate the receipt blobs, and return it without consulting the mutable head. For a new operation only, resolve source from state and compute its hash binding before CAS. For create/publish the complete intent can be hashed without resolving any new IDs. This ordering makes collision behavior deterministic even for nonexistent replacement IDs. Compare the canonical fields that can be computed before lookup/membership first; do not return NOT_FOUND for that changed intent.

For first put/create: call private blobStore.put with snapshot fields, construct VersionedFileRef with `id = versionId = blob.id`, sourceVersionId null, operationId null/context null for base put or operationId/context for create. Add files[id] with initial/head equal versionId and published null. For create add receipt atomically with the file row. For edit: verify file/source exists and belongs together, verify source bytes, require current head equals source, write new blob, construct output with `id = fileId`, `versionId = blob.id`, bound context/source/op; store version, update head and install receipt in one manifest update. Leave published unchanged. Validate blob reads by matching the base blob ref to the projected version ref with blob id substituted; compare name, size, MIME, SHA-256, metadata and timestamp. Missing committed blob is INTEGRITY, not ordinary missing version.

Implement `getVersion` with both IDs validated before filesystem access, return undefined for a valid absent pair or version owned by a different logical file. `get`/`info` select initial, getHead selects head. Return copies of refs, receipts and bytes. `lookupOperation` validates bounded opaque operation ID, hashes it, and returns undefined only when ledger entry is absent. Annotate the factory return as `Omit<VersionedFileStore, "publish">` for this commit and return the implemented methods only. Do not add a throwing publish stub or cast a partial implementation to VersionedFileStore. Task 4 adds the concrete publish method and changes the return annotation to the full interface before this slice ships.

- [ ] **Step 3: Add persistence/integrity/canonical-intent regression cases and run them.** Add table-driven tests with actual edits for every bound field:

```ts
it("binds every edit intent field and accepts reordered context keys", async () => {
  const { store } = await setup();
  const first = await store.create(input("create:1", "one"));
  const edit = { ...input("edit:1", "two"), fileId: first.output.id, sourceVersionId: first.output.versionId };
  const receipt = await store.putVersion(edit);
  const changes = [
    { bytes: new TextEncoder().encode("different") }, { name: "other.txt" },
    { mimeType: "text/markdown" }, { metadata: { ...edit.metadata, createdBy: "other" } },
    { context: { ...context, taskId: "task:other" } },
    { context: { ...context, policyVersion: "policy:2" } },
    { context: { ...context, argumentsSha256: "b".repeat(64) } },
    { context: { ...context, worker: { ...context.worker, image: "reference:2" } } },
    { context: { ...context, worker: { ...context.worker, libraries: { paper: "test:2" } } } },
    { sourceVersionId: receipt.output.versionId },
    { fileId: "file_00000000000000000000000000" },
  ];
  for (const change of changes) {
    await expect(store.putVersion({ ...edit, ...change }))
      .rejects.toMatchObject({ code: "OPERATION_COLLISION" });
  }
  expect(await store.putVersion({ ...edit, metadata: { source: "generated", createdBy: "role:test" } }))
    .toEqual(receipt);
  await expect(store.create(input("edit:1", "two")))
    .rejects.toMatchObject({ code: "OPERATION_COLLISION" });
});
it("refuses corrupt committed bytes even through receipt lookup", async () => {
  const { dir, store } = await setup();
  const receipt = await store.create(input("create:1", "one"));
  await writeFile(join(dir, "blobs", receipt.output.versionId, "note.txt"), "tampered");
  await expect(store.getVersion(receipt.output.id, receipt.output.versionId)).rejects.toMatchObject({ code: "INTEGRITY" });
  await expect(store.lookupOperation("create:1")).rejects.toMatchObject({ code: "INTEGRITY" });
});
it("snapshots input and detaches returned receipts", async () => {
  const { store } = await setup();
  const mutable = { ...input("create:1", "one"), context: structuredClone(context) };
  const pending = store.create(mutable);
  mutable.bytes.fill(0);
  mutable.context.worker.libraries.paper = "changed";
  const receipt = await pending;
  const versionId = receipt.output.versionId;
  (receipt.output.metadata as { createdBy: string }).createdBy = "changed";
  expect((await store.getVersion(receipt.output.id, versionId))?.bytes)
    .toEqual(new TextEncoder().encode("one"));
  expect((await store.lookupOperation("create:1"))?.kind).toBe("create");
  expect((await store.getHead(receipt.output.id))?.metadata.createdBy).toBe("role:test");
});
```

Add individually named tests with executable arrangements: create two files then assert getVersion(first.id, second.versionId) undefined; corrupt manifest to `{}` then assert getHead INTEGRITY; replace manifest with symlink to another test directory's manifest then assert lookup INTEGRITY; replace blob payload with symlink then assert getVersion INTEGRITY. Precreate `.write-lock` and assert create rejects BUSY without an operation; lookup unknown ID remains undefined. Write an unreferenced blob using localFileStore(join(dir,"blobs")) and a `.manifest-abandoned.json` sentinel, then reopen and assert getHead still points to the last committed version. Invalid snapshots must leave lookupOperation absent. Add base `put` test asserting operationId/context null and first-version get/info stable after an edit.

Run: `npx vitest run packages/sdk/src/versioned-file-validation.test.ts packages/sdk/src/local-versioned-files.test.ts packages/sdk/src/local-files.test.ts packages/sdk/src/files.test.ts`.
Expected: version/replay tests PASS.

- [ ] **Step 4: Typecheck and commit the create/edit implementation.**

Run: `npm run typecheck -w @officehum/sdk && git diff --check`. Expected: PASS. The exported factory is explicitly partial at this review gate; publishing is not present or advertised yet. The branch is shippable only after Task 4 completes the full VersionedFileStore contract.

Commit: `git add packages/sdk/src/local-versioned-files.ts packages/sdk/src/local-versioned-files.test.ts packages/sdk/src/index.ts && git commit -m "feat(sdk): persist immutable file versions and replay receipts"`.

### Task 4: Conditional publication and documented handoff

**Files:** Modify `packages/sdk/src/local-versioned-files.ts`, `packages/sdk/src/local-versioned-files.test.ts`, `docs/design/file-store.md`.

**Interfaces:** Consumes PublishVersionInput, PublishReceipt, snapshotPublish, intentHash, mutateState, and existing ref/blob verification from Task 3. Produces working `publish(input): Promise<PublishReceipt>` and getPublished behavior. No approval policy is implemented here.

- [ ] **Step 1: Add failing publish tests.** Reuse the Task 3 harness:

```ts
it("publishes conditionally and replays without rewinding a newer pointer", async () => {
  const { dir, store } = await setup();
  const first = await store.create(input("create:1", "one"));
  const initial = {
    operationId: "publish:1", fileId: first.output.id,
    expectedPublishedVersionId: null, versionId: first.output.versionId, approvalId: "approval:1",
  };
  const firstPublish = await store.publish(initial);
  const second = await store.putVersion({ ...input("edit:1", "two"), fileId: first.output.id, sourceVersionId: first.output.versionId });
  expect(await store.getPublished(first.output.id)).toEqual(first.output);
  const secondPublish = await store.publish({
    operationId: "publish:2", fileId: first.output.id,
    expectedPublishedVersionId: first.output.versionId, versionId: second.output.versionId, approvalId: "approval:2",
  });
  const reopened = localVersionedFileStore(dir);
  expect(await reopened.publish(initial)).toEqual(firstPublish);
  expect(await reopened.getPublished(first.output.id)).toEqual(second.output);
  expect(await reopened.lookupOperation("publish:2")).toEqual(secondPublish);
  await expect(reopened.publish({ ...initial, operationId: "publish:3" }))
    .rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  await expect(reopened.publish({ ...initial, approvalId: "approval:changed" }))
    .rejects.toMatchObject({ code: "OPERATION_COLLISION" });
  expect(await reopened.lookupOperation("publish:3")).toBeUndefined();
});
it("does not accept missing approval, foreign version or cross-kind operation", async () => {
  const { store } = await setup();
  const first = await store.create(input("create:1", "one"));
  const other = await store.create(input("create:2", "other"));
  const request = {
    operationId: "publish:1", fileId: first.output.id,
    expectedPublishedVersionId: null, versionId: first.output.versionId, approvalId: "approval:1",
  };
  await expect(store.publish({ ...request, approvalId: "" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(store.publish({ ...request, versionId: other.output.versionId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(store.publish({ ...request, operationId: "create:1" })).rejects.toMatchObject({ code: "OPERATION_COLLISION" });
  expect(await store.getPublished(first.output.id)).toBeUndefined();
});
```

Add a two-instance publication race with different publish operation IDs and expectedPublishedVersionId null, asserting one fulfillment, one VERSION_CONFLICT and a pointer equal to the winner. Add changed fileId/expectedPublishedVersionId/versionId under a successful publish operation ID and assert OPERATION_COLLISION, including valid but nonexistent IDs. Add same operation ID/same intent racing and assert identical receipts.

Run: `npx vitest run packages/sdk/src/local-versioned-files.test.ts`.
Expected: publish tests FAIL because store.publish is absent. Add the concrete method next; no stub is required.

- [ ] **Step 2: Implement publish transaction.** Change the factory annotation from `Omit<VersionedFileStore, "publish">` to `VersionedFileStore` and add `publish` to its returned object.

```ts
// Within mutateState after synchronous snapshot and canonical hash:
const prior = state.operations[operationKey];
if (prior) {
  if (prior.kind !== "publish" || prior.intentSha256 !== canonicalHash) {
    throw new FileStoreError("OPERATION_COLLISION", "Operation ID has different intent");
  }
  return structuredClone(prior);
}
const file = state.files[request.fileId];
const proposed = state.versions[request.versionId];
if (!file || !proposed || proposed.id !== request.fileId) {
  throw new FileStoreError("NOT_FOUND", "File version not found");
}
if (file.published !== request.expectedPublishedVersionId) {
  throw new FileStoreError("VERSION_CONFLICT", "Published version changed");
}
const receipt: PublishReceipt = {
  kind: "publish", operationId: request.operationId, intentSha256: canonicalHash,
  approvalId: request.approvalId,
  previous: file.published === null ? null : state.versions[file.published]!,
  published: proposed,
};
file.published = proposed.versionId;
state.operations[operationKey] = receipt;
return structuredClone(receipt);
```

Verify proposed/previous blobs before commit and prior receipt blobs before replay. Publishing does not change head or initial. A proposed version need not equal the latest draft: approval binds exact versions and expected published source, and newer drafts alone do not invalidate that binding. This CAS compares the published pointer only; DocumentService later governs workspaces and review validity. Explicit publication of an older immutable version is possible only through a fresh trusted host approval and matching expected pointer.

- [ ] **Step 3: Update docs with runnable usage and limitations.** Replace the existing “Next slices” paragraph with the following example and the stated semantics:

```ts
import { localVersionedFileStore } from "@officehum/sdk";
const documents = localVersionedFileStore("/office/state/reference-documents");
const created = await documents.create({
  operationId: "task:42/create:1", bytes: new TextEncoder().encode("Draft notes"),
  name: "notes.txt", mimeType: "text/plain",
  metadata: { createdBy: "role:frontdesk", source: "generated" },
  context: {
    taskId: "task:42", policyVersion: "documents:1",
    worker: { image: "text-example:1", libraries: {} },
    argumentsSha256: "a".repeat(64),
  },
});
const edited = await documents.putVersion({
  operationId: "task:42/edit:1", fileId: created.output.id,
  sourceVersionId: created.output.versionId, bytes: new TextEncoder().encode("Revised notes"),
  name: "notes.txt", mimeType: "text/plain",
  metadata: { createdBy: "role:frontdesk", source: "derived" },
  context: created.output.context!,
});
const receipt = await documents.lookupOperation("task:42/edit:1");
const exact = await documents.getVersion(edited.output.id, edited.output.versionId);
```

Explain that real callers compute argumentsSha256 from canonical arguments/code, not a constant; the example is opaque text storage, not Office validation. Include a publish example using `approvalId: "example-host-verified-approval"` and explicit null source, immediately stating the host must verify real approval bound to file/source/proposal hashes before this call. Document operation field coverage and collisions; initial get/info versus head/published; base put has no replay identity; IDs never authorize role access; separate roots/no migration; exclusive writer lock/BUSY/manual abandoned-lock handling; manifest rename visibility and unreferenced blobs; no production recovery guarantee; no automatic approval/document validation. Link RASF-3193, RASF-3283 and RASF-3285 as remaining work.

- [ ] **Step 4: Verify the slice and review the diff.**

Run: `npm run check` and `git diff --check`.
Expected: lint/build/typecheck/full Vitest suite PASS, whitespace check clean. Check diff contains only the ten mapped files, with no dependencies/lockfile/base layout changes. Present the API/doc diff to the reviewer; do not claim durable Office recovery, approval enforcement or Paper validation. Commit Task 4 files: `git add packages/sdk/src/local-versioned-files.ts packages/sdk/src/local-versioned-files.test.ts docs/design/file-store.md && git commit -m "feat(sdk): conditionally publish immutable file versions"`.

## Completion and self-review

The SDK slice is complete when all four commits pass review and npm run check, existing attachment tests still pass, exact replay survives reopen/head advancement/later publication, two instances cannot silently overwrite, and corrupt bytes fail through both reads and receipt lookup. RASF-3192 can then complete; RASF-3193/3283 remain blocked by their own host/runtime/sandbox work and must not be marked done by this slice.

Planning self-review: spec byte identity, task/source/worker/policy bindings, uniqueness, stale-source CAS, draft state and publication replay are covered above. DocumentService receipt validation reports, leases, workspace revision CAS, pending-operation/reconciliation state, actual Office validation, preview/review, human approval verification, power-loss durability and automatic lock recovery are deliberately assigned to RASF-3193/3283/3285, not silently omitted from the wider design. Type names and field names are consistent across all four tasks. No product code was changed by writing this plan.
