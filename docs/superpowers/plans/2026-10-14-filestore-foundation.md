# Portable FileStore Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the portable immutable attachment store needed before Paper document versions, leases and workers.

**Architecture:** Add the base SDK FileStore contract, a local reference backend, and bounded file tool results. Writes install a complete temporary directory by rename; reads verify stored hashes. This delivers the base portion of RASF-3192; its document version extension needs a separate plan before host or worker integration.

**Tech Stack:** TypeScript, Node >=22.19.0 built-ins, Vitest; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-14-paper-instruments-integration-design.md` (read fully before execution).

## Global Constraints

- “Pi Durable remains the only agent harness and the authority for conversation state, task checkpoints, approvals, and recovery.”
- “A tool never accepts an arbitrary server path.”
- “No existing business file is rewritten merely by enabling the tool pack.”
- SDK adds no dependencies. Base IDs match `^file_[0-9A-HJKMNP-TV-Z]{26}$`.
- `MAX_INLINE_IMAGE_BYTES = 100_000`.
- No document execution, publication, role grants or production enablement in this slice.

## Review Focus

- Unsafe names and malformed IDs fail before filesystem access (Task 1).
- Input mutation cannot change stored bytes or metadata (Task 1).
- Corrupt metadata, tampered bytes and symlinks fail closed (Task 1).
- Concurrent puts and abandoned staging never expose partial files (Task 1).
- Preview limits apply to decoded bytes and results contain small references (Task 2).

---

## Scope and dependency evidence

No FileStore implementation currently exists. RASF-3192 is Backlog with no blockers. RASF-3193 depends on 3192 and runtime RASF-3104; RASF-3283 depends on these FileStore issues and sandbox RASF-3111. Existing scalar Python engines do not provide document isolation. Starting a worker now would skip its byte/version/replay authority.

Smallest useful next slice: base RASF-3192. Subsequent independent plans: portable versioned refs and canonical operation receipts; durable Office SQLite/file reconciliation and task leases; isolated Paper worker with verified pinned installs; format adapters and exact-hash review. Do not mark RASF-3192 complete until its versioned extension ships. No blocker prevents this base slice.

## File map

- Create `packages/sdk/src/files.ts`: portable contracts and bounded `fileResult`.
- Create `packages/sdk/src/local-files.ts`: trusted-host local immutable backend.
- Create `packages/sdk/src/local-files.test.ts`: real temporary-directory persistence and validation.
- Create `packages/sdk/src/files.test.ts`: public exports and result boundaries.
- Modify `packages/sdk/src/index.ts`: exports.
- Create `docs/design/file-store.md`: usage, host ownership and capability limits.

### Task 1: Portable contracts and immutable local backend

**Files:** Create `files.ts`, `local-files.ts`, `local-files.test.ts` under `packages/sdk/src`; modify `packages/sdk/src/index.ts`.

**Interfaces:** Consumes Node bytes and a trusted host directory. Produces the following public types and `localFileStore(dir: string): FileStore`; no role sees server paths.

- [ ] **Step 1: Write failing round-trip and rejection tests**

```ts
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { localFileStore } from "./index.js";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "officehum-files-"));
  dirs.push(dir);
  return { dir, store: localFileStore(dir) };
}
const metadata = { createdBy: "role:test", source: "uploaded" as const };
it("persists immutable bytes across reopen", async () => {
  const { dir, store } = await setup();
  const bytes = new TextEncoder().encode("hello");
  const ref = await store.put({ bytes, name: "note.txt", mimeType: "text/plain", metadata });
  expect(ref.id).toMatch(/^file_[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(ref.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(ref.size).toBe(5);
  expect(await localFileStore(dir).get(ref.id)).toEqual({ ref, bytes });
  expect(await store.info(ref.id)).toEqual(ref);
  bytes[0] = 0;
  expect((await store.get(ref.id))?.bytes[0]).toBe(104);
});
it.each(["../x", "x/y", "x\\y", "", ".", "..", "meta.json"])("rejects name %j", async name => {
  const { store } = await setup();
  await expect(store.put({ bytes: new Uint8Array(), name, mimeType: "text/plain", metadata })).rejects.toThrow();
});
it.each(["../escape", "file_../../x", "file_bad"])("rejects id %j", async id => {
  const { store } = await setup();
  await expect(store.get(id)).rejects.toThrow();
  await expect(store.info(id)).rejects.toThrow();
});
```

- [ ] **Step 2: Run and confirm failure**

Run `npx vitest run packages/sdk/src/local-files.test.ts`. Expected missing export failure.

- [ ] **Step 3: Define contracts and implement backend**

```ts
export interface FileMetadata {
  readonly createdBy: string;
  readonly source: "generated" | "uploaded" | "external" | "derived";
  readonly aiGenerated?: { readonly model: string; readonly prompt: string };
  readonly derivedFrom?: readonly string[];
  readonly provenance?: "internal" | "external";
}
export interface FileRef {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly sha256: string;
  readonly createdAt: string;
  readonly metadata: FileMetadata;
}
export interface FileStore {
  put(input: { bytes: Uint8Array; name: string; mimeType: string; metadata: FileMetadata }): Promise<FileRef>;
  get(id: string): Promise<{ ref: FileRef; bytes: Uint8Array } | undefined>;
  info(id: string): Promise<FileRef | undefined>;
}
export const MAX_INLINE_IMAGE_BYTES = 100_000;
```

Generate ULIDs with no dependency: combine 48 bits of `Date.now()` and 80 cryptographically random bits, encode as 26 Crockford base32 characters using alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, prefix `file_`. Hash with `createHash('sha256')`.

Clone bytes and metadata before first await. Reject separators, empty/dot names, control characters, reserved `meta.json`, and names over 255 UTF-8 bytes. Validate metadata shape, nonempty createdBy, enums, derivedFrom IDs and optional string model/prompt. External sources must retain external provenance; reject explicit internal provenance. Reject unknown metadata keys.

Validate leading signatures for PNG (`89 50 4E 47 0D 0A 1A 0A`), JPEG (`FF D8 FF`), GIF (`GIF87a`/`GIF89a`), WebP (`RIFF` at 0 and `WEBP` at 8), PDF (`%PDF-`). A recognized signature with mismatched MIME or recognized MIME with mismatched signature rejects. Other formats are opaque; Office ZIP integrity is a later adapter responsibility.

Create root recursively; create 0700 staging directory using `mkdtemp(join(root,'.staging-'))`; write 0600 payload and meta.json exclusively; rename complete directory to `<root>/<id>`. Clean only this call's staging directory on error. Never replace an existing completed directory; retry on ID collision. Staging is never returned by get/info. This reference backend promises atomic visibility, not durable power-loss recovery or protection from a hostile owner of its configured root.

Validate ID before any filesystem access. Missing ID directory returns undefined; existing directory missing its payload/metadata rejects as corruption. Reject symlink directories, metadata and payload using lstat plus `O_NOFOLLOW` on file opens. Parse metadata as unknown and validate ID, name, MIME, nonnegative integer size, 64-character lowercase hash, ISO timestamp and FileMetadata. Read bytes and verify size/hash on both get and info. Return independent copies.

Export types/constant from files.ts and localFileStore from local-files.ts through index.ts.

- [ ] **Step 4: Add boundary tests**

Using setup above, add each concrete case: tamper payload with `writeFile(join(dir,ref.id,ref.name),'changed')` and require get/info rejection; replace meta.json with `{}` and require rejection; mutate original metadata.createdBy after put and require unchanged stored metadata; create `.staging-abandoned/payload` then reopen and successfully put/get another file; symlink a valid-ID directory to a second temp directory containing sentinel bytes and require rejection. Test 20 concurrent identical puts yield 20 unique IDs, each readable. Test unknown valid ID `file_00000000000000000000000000` returns undefined. Table-test all five signatures with correct and mismatched MIME, truncated signatures, control names and 256-byte names. Test external source cannot be relabeled internal.

- [ ] **Step 5: Verify and commit**

Run focused tests, `npm run build -w @officehum/sdk`, and `npm run typecheck -w @officehum/sdk`; all must pass.

```bash
git add packages/sdk/src/files.ts packages/sdk/src/local-files.ts packages/sdk/src/local-files.test.ts packages/sdk/src/index.ts
git commit -m "feat(sdk): add immutable local file store"
```

### Task 2: Bounded file results and documentation

**Files:** Modify `files.ts` and index.ts; create `files.test.ts` and `docs/design/file-store.md`.

**Interfaces:** Consumes Task 1 FileRefs. Produces `fileResult(refs: readonly FileRef[], options?: { preview?: { bytes: Uint8Array; mimeType: string } }): { content: Array<TextContent | ImageContent>; details: { files: string[] } }`, using pi-ai content types. Text JSON contains `{files:[{id,name,mimeType,size}]}` only. Limit refs to 100 and use safe ID/name/size validation. Preview supports verified PNG/JPEG/GIF/WebP signatures, maximum decoded size 100,000 bytes.

- [ ] **Step 1: Write failing result tests**

```ts
import { expect, it } from "vitest";
import { fileResult, MAX_INLINE_IMAGE_BYTES, type FileRef } from "./index.js";
const ref: FileRef = {
  id: "file_00000000000000000000000000", name: "draft.txt", mimeType: "text/plain",
  size: 5, sha256: "a".repeat(64), createdAt: "2026-10-14T00:00:00.000Z",
  metadata: { createdBy: "role:test", source: "generated" },
};
it("returns references only", () => {
  expect(MAX_INLINE_IMAGE_BYTES).toBe(100_000);
  expect(fileResult([ref])).toEqual({
    content: [{ type: "text", text: JSON.stringify({ files: [
      { id: ref.id, name: ref.name, mimeType: ref.mimeType, size: ref.size },
    ] }) }], details: { files: [ref.id] },
  });
});
it("refuses too many refs", () => {
  expect(() => fileResult(Array.from({length:101}, () => ref))).toThrow();
});
```

Add tests for empty refs, invalid IDs, invalid preview signature/MIME, and 100,000 versus 100,001 byte PNG buffers (prefix each with valid PNG magic). Accepted preview decodes to exactly 100,000 bytes; text/details still contain no bytes or metadata.

- [ ] **Step 2: Run and confirm missing fileResult failure**

Run `npx vitest run packages/sdk/src/files.test.ts`.

- [ ] **Step 3: Implement validated result assembly**

After validating refs and preview limits/signature, build:

```ts
const files = refs.map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size }));
const content: Array<TextContent | ImageContent> = [
  { type: "text", text: JSON.stringify({ files }) },
];
if (options.preview) content.push({
  type: "image", data: Buffer.from(options.preview.bytes).toString("base64"),
  mimeType: options.preview.mimeType,
});
return { content, details: { files: refs.map(ref => ref.id) } };
```

Default options to `{}`. Export function from index.ts. Share private validation helpers in a focused module if needed; do not expose them publicly.

- [ ] **Step 4: Write usage documentation**

Create file-store.md with runnable imports/put/get/fileResult example. Explain trusted host directory, immutable attachment IDs, no authorization from a bare ID, no automatic role tool grants, preview limit, and opaque Office payloads. State that local atomic visibility is not the durable Office recovery contract. Link approved spec and RASF-3192. List versioned refs, operation ledger, leases, quotas, backups and publication as subsequent slices.

- [ ] **Step 5: Verify and commit**

Run `npm run check` and `git diff --check`; all lint/build/typechecks/tests must pass. Inspect diff to ensure no new dependencies, unrelated default changes or worker enablement.

```bash
git add packages/sdk/src/files.ts packages/sdk/src/files.test.ts packages/sdk/src/index.ts docs/design/file-store.md
git commit -m "feat(sdk): add bounded file tool results"
```

## Self-review and handoff

All five review focus cases have test steps. The spec's versions, workspace revision CAS, receipts, worker isolation, format adapters and review are explicit future slices; this base API must not claim to satisfy them. Report focused/full check results and example result JSON. Keep RASF-3192 open as partial delivery. Preserve requested GPT-6 Sol planning and GPT-6 Luna implementation with subagent driven execution.

## Concrete code supplements (part of the owning steps)

### Task 1 Step 3: helper signatures and storage pseudocode

Private helpers have these exact signatures; share validation in `packages/sdk/src/file-validation.ts` when needed by both result and backend (include this file in the owning commit):

```ts
function assertId(id: string): void;
function assertName(name: string): void;
function assertMetadata(value: unknown): asserts value is FileMetadata;
function assertRef(value: unknown, expectedId: string): asserts value is FileRef;
function assertSignature(bytes: Uint8Array, mimeType: string): void;
function newId(): string;
async function readStored(root: string, id: string): Promise<{ ref: FileRef; bytes: Uint8Array } | undefined>;
```

Implement helper bodies according to the explicit checks above. Key persistence control flow, in exact pseudocode (the symbols are Node fs/promises operations):

```text
localFileStore(dir: string): FileStore
  root := resolve(dir)
  put(input):
    bytes := Uint8Array.from(input.bytes); metadata := structuredClone(input.metadata)
    assertName(input.name); assertMetadata(metadata); assertSignature(bytes,input.mimeType)
    mkdir(root,{recursive:true,mode:0700})
    staging := mkdtemp(join(root,'.staging-'))
    try:
      id := newId()
      ref := {id,name:input.name,mimeType:input.mimeType,size:bytes.length,
              sha256:sha256(bytes),createdAt:new Date().toISOString(),metadata}
      writeFile(join(staging,input.name),bytes,{flag:'wx',mode:0600})
      writeFile(join(staging,'meta.json'),JSON.stringify(ref),{flag:'wx',mode:0600})
      while lstat(join(root,id)) succeeds:
        id := newId(); ref.id := id
        writeFile(join(staging,'meta.json'),JSON.stringify(ref),{mode:0600})
      rename(staging,join(root,id))
      return structuredClone(ref)
    finally:
      rm(staging,{recursive:true,force:true})
  get(id): return readStored(root,id)
  info(id): return (await readStored(root,id))?.ref

readStored(root,id):
  assertId(id)
  lstat(join(root,id)); return undefined only if this throws ENOENT
  reject if directory is symlink or not a directory
  open meta.json using O_RDONLY|O_NOFOLLOW; require regular file; read and close in finally
  ref := JSON.parse(metadata text); assertRef(ref,id)
  open join(root,id,ref.name) using O_RDONLY|O_NOFOLLOW
  require regular file; bytes := Uint8Array.from(handle.readFile()); close in finally
  reject unless bytes.length == ref.size and sha256(bytes) == ref.sha256
  return {ref:structuredClone(ref),bytes}
```

The configured directory is host-owned; its owner must not race a read or install. Do not present lstat plus open as hostile-root race protection. The directory collision check uses unpredictable cryptographic IDs; never remove or overwrite a destination on collision. Handle a rename collision by regenerating ID and rewriting staging metadata.

Concrete ULID encoder:

```ts
import { randomBytes } from "node:crypto";
function newId(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let value = (BigInt(Date.now()) << 80n) | BigInt(`0x${randomBytes(10).toString("hex")}`);
  let encoded = "";
  for (let i = 0; i < 26; i += 1) {
    encoded = alphabet[Number(value & 31n)] + encoded;
    value >>= 5n;
  }
  return `file_${encoded}`;
}
```

### Task 1 Step 4: runnable corruption, staging, signature and symlink tests

Add `mkdir`, `symlink`, and `writeFile` to the existing fs/promises test import. Append:

```ts
const putText = (store: ReturnType<typeof localFileStore>) => store.put({
  bytes: new TextEncoder().encode("hello"), name: "a.txt", mimeType: "text/plain", metadata,
});
it("refuses tampered bytes on get and info", async () => {
  const { dir, store } = await setup();
  const ref = await putText(store);
  await writeFile(join(dir, ref.id, ref.name), "changed");
  await expect(store.get(ref.id)).rejects.toThrow();
  await expect(store.info(ref.id)).rejects.toThrow();
});
it("refuses corrupt metadata", async () => {
  const { dir, store } = await setup();
  const ref = await putText(store);
  await writeFile(join(dir, ref.id, "meta.json"), "{}");
  await expect(store.get(ref.id)).rejects.toThrow();
});
it("does not follow a version directory symlink", async () => {
  const { dir, store } = await setup();
  const target = await setup();
  const ref = await putText(target.store);
  await symlink(join(target.dir, ref.id), join(dir, ref.id), "dir");
  await expect(store.get(ref.id)).rejects.toThrow();
  await expect(store.info(ref.id)).rejects.toThrow();
});
it("ignores abandoned staging after reopen", async () => {
  const { dir } = await setup();
  await mkdir(join(dir, ".staging-abandoned"));
  await writeFile(join(dir, ".staging-abandoned", "payload"), "sentinel");
  const reopened = localFileStore(dir);
  const ref = await putText(reopened);
  expect(new TextDecoder().decode((await reopened.get(ref.id))?.bytes)).toBe("hello");
});
it("snapshots caller metadata", async () => {
  const { store } = await setup();
  const mutable = { ...metadata };
  const ref = await store.put({bytes:new Uint8Array(),name:"x.txt",mimeType:"text/plain",metadata:mutable});
  mutable.createdBy = "changed";
  expect((await store.info(ref.id))?.metadata.createdBy).toBe("role:test");
});
it.each([
  ["image/png", [137,80,78,71,13,10,26,10]],
  ["image/jpeg", [255,216,255]],
  ["image/gif", [...Buffer.from("GIF89a")]],
  ["image/webp", [...Buffer.from("RIFF0000WEBP")]],
  ["application/pdf", [...Buffer.from("%PDF-")]],
] as const)("checks signature for %s", async (mimeType, prefix) => {
  const { store } = await setup();
  const bytes = Uint8Array.from(prefix);
  await expect(store.put({bytes,name:"payload",mimeType,metadata})).resolves.toMatchObject({mimeType});
  await expect(store.put({bytes,name:"payload",mimeType:"text/plain",metadata})).rejects.toThrow();
  await expect(store.put({bytes:bytes.slice(0,1),name:"payload",mimeType,metadata})).rejects.toThrow();
});
it("keeps concurrent writes distinct", async () => {
  const { store } = await setup();
  const refs = await Promise.all(Array.from({length:20}, () => putText(store)));
  expect(new Set(refs.map(ref => ref.id)).size).toBe(20);
  for (const ref of refs) expect(await store.info(ref.id)).toEqual(ref);
});
it.each(["x".repeat(256), "a\u0000b"])("refuses oversized or control names", async name => {
  const { store } = await setup();
  await expect(store.put({bytes:new Uint8Array(),name,mimeType:"text/plain",metadata})).rejects.toThrow();
});
it("refuses external provenance relabeling", async () => {
  const { store } = await setup();
  await expect(store.put({bytes:new Uint8Array(),name:"a",mimeType:"text/plain",
    metadata:{createdBy:"email",source:"external",provenance:"internal"}})).rejects.toThrow();
});
it("returns undefined for absent valid IDs", async () => {
  const { store } = await setup();
  expect(await store.get("file_00000000000000000000000000")).toBeUndefined();
});
```

### Task 2 Steps 1 and 3: exact preview tests and type import

Verified against installed pi-ai 1.0.2 `dist/types.d.ts` and root `dist/index.d.ts`: both interfaces are exported at the package root. Use:

```ts
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
```

ImageContent has `type: 'image'`, base64 `data: string`, and `mimeType: string`; TextContent has `type: 'text'` and `text: string`.

Append these runnable tests to files.test.ts:

```ts
const png = (size: number) => {
  const bytes = new Uint8Array(size);
  bytes.set([137,80,78,71,13,10,26,10]);
  return bytes;
};
it("accepts exactly the decoded preview limit", () => {
  const result = fileResult([ref], {preview:{bytes:png(100_000),mimeType:"image/png"}});
  const image = result.content[1];
  expect(image?.type).toBe("image");
  if (image?.type !== "image") throw new Error("Expected image");
  expect(Buffer.from(image.data,"base64").length).toBe(100_000);
  expect(result.details).toEqual({files:[ref.id]});
});
it("rejects a decoded preview one byte above the limit", () => {
  expect(() => fileResult([ref], {preview:{bytes:png(100_001),mimeType:"image/png"}})).toThrow();
});
it.each(["text/plain","image/jpeg"])("refuses PNG preview mislabeled %s", mimeType => {
  expect(() => fileResult([ref], {preview:{bytes:png(20),mimeType}})).toThrow();
});
it("rejects bad preview bytes", () => {
  expect(() => fileResult([ref], {preview:{bytes:new Uint8Array(20),mimeType:"image/png"}})).toThrow();
});
it("supports an empty result", () => {
  expect(fileResult([])).toEqual({content:[{type:"text",text:'{"files":[]}'}],details:{files:[]}});
});
it("rejects malformed reference IDs", () => {
  expect(() => fileResult([{...ref,id:"../secret"}])).toThrow();
});
```

### Task 2 Step 4: exact documentation content

Write `docs/design/file-store.md` with this content:

````markdown
# File storage

The host supplies a trusted storage directory. Roles receive small immutable file references; a bare ID grants no role access. This SDK API registers no tools and grants no capabilities.

```ts
import { localFileStore, fileResult } from "@officehum/sdk";
const files = localFileStore("/office/state/attachments");
const ref = await files.put({
  bytes: new TextEncoder().encode("Draft notes"),
  name: "notes.txt", mimeType: "text/plain",
  metadata: { createdBy: "role:frontdesk", source: "generated" },
});
const saved = await files.get(ref.id);
if (!saved) throw new Error("Stored draft missing");
const result = fileResult([ref]);
```

A successful put creates a new immutable attachment ID. Reads verify content hashes. Local staging gives complete-directory visibility, not the Office durable crash/reconciliation contract. Keep the storage root host-owned and free of hostile concurrent filesystem writers.

Tool results contain refs. Optional inline image previews may contain at most 100,000 decoded bytes. Larger images remain files. Office payloads are opaque here: storing a ZIP container does not validate or approve an Office document.

Next slices add explicit document version IDs, canonical operation receipts and replay lookup, task leases, Office quotas/backups, and conditional publication with exact-hash approval. This base implementation does not enable document Python or publication.

See the [approved Paper Office design](../superpowers/specs/2026-10-14-paper-instruments-integration-design.md) and [RASF-3192](https://linear.app/riseandshinefutures/issue/RASF-3192).
````
