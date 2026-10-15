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
