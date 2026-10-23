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

## Versioned documents

The local versioned store keeps an immutable initial version, a mutable head pointer, and an optional published pointer. `get` and `info` continue to address the initial version; `getHead` returns the latest draft; `getPublished` returns the version currently published. `getVersion` reads a specific immutable version, and `lookupOperation` returns the receipt for an operation ID.

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

Callers compute `argumentsSha256` from their canonical arguments and code; the constant above is only a compact example. This stores opaque bytes and does not validate Office files. Before calling `publish`, the host must verify that real approval is bound to the file, source version, and proposed version hashes. The SDK checks the approval ID is present and records it, but does not verify the approval itself.

```ts
const publication = await documents.publish({
  operationId: "task:42/publish:1", fileId: edited.output.id,
  expectedPublishedVersionId: null, versionId: edited.output.versionId,
  approvalId: "example-host-verified-approval",
});
```

Publish compares `expectedPublishedVersionId` with the current published pointer under the manifest lock. A mismatch returns `VERSION_CONFLICT`; a successful receipt records the previous and published refs. Replaying the same operation and intent returns its receipt without rewinding a newer published pointer. A fresh host approval may publish any immutable version when its expected pointer matches. Publishing does not change the draft head or initial version.

The host verification the paragraph above relies on now exists: `@officehum/tools-paper-office`'s `publicationGate` opens a durable review bound to the file, the source version and hash, the proposed version and hash, the diff digest and the validation digest; a person's decision carries that whole binding; and `publish` is called only for an approved review whose binding still matches, so an approval made for one proposal cannot publish another. Every refusal — a missing or denied decision, a mismatched approval, a superseded proposal, or a published pointer that moved after the review — returns before `publish` is called, leaving the pointer unchanged. `packages/tools-paper-office/src/review.ts` is the implementation and `docs/superpowers/plans/2026-10-23-review-and-publish.md` the plan.

Create receipts bind the operation ID to the bytes hash, name, MIME type, metadata, and context. Version receipts also bind the file ID, source version ID, and source bytes hash. Publish receipts bind the file ID, expected published version ID, proposed version ID, and approval ID. Reusing an ID with changed intent or a different operation kind returns `OPERATION_COLLISION`. Version edits bind the source version and reject stale heads. The inherited base `put` remains compatible with `FileStore`, but has no replay identity; mutating document tools should use `create` and `putVersion`.

Keep each store root separate from attachment roots; this implementation does not migrate existing files. IDs do not grant role access. The host remains responsible for capabilities, quotas, backups, approval verification, Office document validation, and access policy. Writes use an exclusive local lock and return `BUSY` after waiting for a lock; an abandoned lock requires manual handling. A manifest rename provides complete-directory visibility, while a crash may leave unreferenced blobs. There is no production recovery guarantee or automatic lock recovery.

Remaining work is tracked in [RASF-3193](https://linear.app/riseandshinefutures/issue/RASF-3193) and [RASF-3283](https://linear.app/riseandshinefutures/issue/RASF-3283).

See the [approved Paper Office design](../superpowers/specs/2026-10-14-paper-instruments-integration-design.md) and [RASF-3192](https://linear.app/riseandshinefutures/issue/RASF-3192).
