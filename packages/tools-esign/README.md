# @officehum/tools-esign

A **portable e-signature pack** for a Pi Durable role: one interface for whichever e-signature
provider the business uses, a fake for tests, and five tools to send documents to outside parties for
signature, follow them, save the signed copy and void a request. Every send and every void waits for a
person's approval, and what is sent is exactly what the person saw.

It depends on Pi Durable, pi-ai and pi-schema (peers) and `@officehum/sdk`. No other library (the
fake signs its webhooks with `node:crypto`). Never a host, so the same pack runs in a bare
Pi Durable harness (see `src/harness.test.ts`). No provider client is in this package: each provider
gets its own client implementing `ESignature`.

## Install

Not published to npm yet. In a clone of this repository, `npm ci && npm run build` builds it and
workspaces import it by name. For another project, pack it with the SDK
(`npm pack -w @officehum/sdk -w @officehum/tools-esign`) and install the tarballs beside Pi Durable
1.6.0 and its peers, as [Build a role](../../docs/build-a-role.md#use-a-role-in-your-own-harness)
shows for a role.

## The interface

```ts
interface ESignature {
  listTemplates(): Promise<{ id; name; roles[] }[]>;
  send({ documents | templateId, signers: { name, email, role?, order? }[], subject, message,
         expiresInDays?, requestId }): Promise<{ requestId, providerId, status }>;
  status(providerId): Promise<{ status, signers: { email, status, at? }[] }>;
  downloadCompleted(providerId): Promise<{ signed: Uint8Array, certificate?: Uint8Array }>;
  void(providerId, reason): Promise<void>;
  parseWebhook({ headers, body }): Promise<ESignEvent | undefined>;
}
```

- `status` is one of `sent`, `viewed`, `partially_signed`, `completed`, `declined`, `expired`,
  `voided`; a signer is `pending`, `viewed`, `signed` or `declined`.
- `send` takes the documents' bytes (with the file id, name and the hash the person approved), read
  by the pack from the office's file store, so a client never needs a store of its own. A client must
  **deduplicate on `requestId`**: a second send with the same id returns the first request.
- `parseWebhook` verifies the provider's own signature and returns `undefined` for anything it cannot
  verify. The raw body is passed because signatures cover the bytes.
- Whatever a client returns is held to this shape (`checkSendResult`, `checkStatusResult`,
  `checkEvent`): an unknown status, a provider id that is not a short label, or a signer the request
  never named is refused, never passed on.

`fakeESignature()` keeps requests in memory and has a controllable signer: `view`, `sign`, `decline`
and `expire` move a request and return the signed webhook the provider would post.

## Register it

```ts
import { defineRole, localVersionedFileStore } from "@officehum/sdk";
import { eSignaturePack } from "@officehum/tools-esign";

const store = localVersionedFileStore("/office/state/files");
const pack = eSignaturePack({ esign: providerClient, store, createdBy: "role:office-manager" });
defineRole({
  packageDir,
  manifest,
  tools: [...ownTools, ...pack.tools],
  approvalFacts: { ...ownFacts, ...pack.approvalFacts },
  approve,
});
```

## The manifest

Declare the tools and both approvals exactly so in the role's `officehum.json` (the fixture role,
`fixtures/signing-desk/officehum.json`, is the reference):

```json
"tools": [
  { "name": "esign_templates", "replay": "safe" },
  { "name": "esign_send", "replay": "unsafe" },
  { "name": "esign_status", "replay": "safe" },
  { "name": "esign_download", "replay": "safe", "writes": true,
    "noApproval": "saves a completed request's signed copy into the office file store as outside files, once per request; nothing leaves the office" },
  { "name": "esign_void", "replay": "unsafe" }
],
"approvals": [
  { "id": "send_for_signature", "tool": "esign_send",
    "description": "Sending documents to people outside the office for their signature" },
  { "id": "void_signature_request", "tool": "esign_void",
    "description": "Voiding a signature request so nobody can sign it" }
]
```

Neither approval has a `when`: every call asks. Office Hum has no catalog of tool packs yet (the
`"kind": "toolpack"` manifest in `docs/design/tool-sources.md` is not built), so this block and the
checklist below are the pack's catalog entry for now.

## The tools

| Tool | Replay | Arguments | What it does |
| --- | --- | --- | --- |
| `esign_templates` | safe | none | The provider's templates: id, name, signer roles (framed as outside data) |
| `esign_send` | unsafe | `document_file_ids` or `template_id`, `signers`, `subject`, `message`, `expires_in_days` | Sends for signature once a person approves; returns a `request_id` |
| `esign_status` | safe | `request_id` | The request's status and each signer's (framed as outside data) |
| `esign_download` | safe, writes | `request_id` | Saves the signed PDF and the certificate to the file store and returns them |
| `esign_void` | unsafe | `request_id`, `reason` | Voids a request that is not completed, once a person approves |

### What a person approves, and what is sent

- `send_for_signature` has a facts reader: the person is shown each document's name, file id and
  SHA-256 (read from the store, not from the model), or the template; every signer with role and
  order; the subject; and the message.
- On a yes the gate hands those facts to the tool. The tool reads them again and **refuses if anything
  differs**, and checks each document's bytes against the approved hash before sending. It sends the
  approved facts, not the model's arguments, so no signer the person did not see is ever added.
- `void_signature_request` shows the request id and the reason.
- Both tools refuse a call with no approved facts, so a role whose manifest forgot the approval does
  nothing. With no approver configured, the gate refuses both.
- No tool signs anything. Signers are always outside parties, and there is no tool that acts as one.

### Replay and restarts

- A send's request id is the call's durable identity (`requestId("esign", api)`, so
  `esign:<conversation>:<task>:<call>`), and the provider deduplicates on it.
- The record is written **before** the provider is called. A restart while a send's approval is open
  asks again and sends once on the yes. A restart while the provider is sending ends the call
  `interrupted`; the record is left without a provider id, and the next `esign_send` of the same
  approved facts from that conversation reuses its request id, so the provider returns the same request
  and nothing goes out twice.
- A restart during a void's approval asks again and voids once on the yes.
- `esign_download` saves under operation ids derived from the provider id, so it saves one copy
  whoever downloads first (the tool or the office on the completion event) and however often.

### Outside data

Signed copies are `source: "external"`, `provenance: "external"`, with the request's documents in
`derivedFrom` and `externalId: { system: "esign", id: <provider id> }`, so `fileResult` frames the
result as outside files. Status and template results are fenced with `frameOutsideOutput`. A
provider's error message stays in the result's details for the host; the model is told only that the
provider failed and, for an unsafe tool, not to retry on its own.

## In a host

A host takes a provider's webhook requests, verifies each with the provider client's `parseWebhook`
and holds the event to shape with `checkEvent`. An unverified one is dropped; a verified one can
update the request's status, block the work for a person on a decline or an expiry, and save the
signed copy with `saveSigned` on completion. No provider client is built yet, so nothing delivers
webhooks today.

## Review checklist

Before enabling this pack for a role:

- [ ] The role's `officehum.json` declares the five tools and both approvals exactly as above, with no
      `when`, and `checkAgent` passes.
- [ ] The role passes `pack.approvalFacts` to `defineRole`, so the person sees the documents, signers
      and message.
- [ ] The office has an approver; without one every send and void is refused.
- [ ] The provider client deduplicates `send` on `requestId`, verifies its webhook signature in
      `parseWebhook`, and returns PDFs from `downloadCompleted`.
- [ ] Its credentials come from the environment or the connector gateway, never a file.
- [ ] The role's instructions say it never signs for anyone and never adds a signer the user did not
      name (the code enforces the second; the first has no tool to break it).

## Tests

`npm run check` runs them: the fake and the output checks (`src/fake.test.ts`), the unsafe tools'
own checks (`src/tools.test.ts`), the fixture role in a bare harness with approvals, declines, no
approver, downloads and restarts (`src/harness.test.ts`), and the package boundary
(`src/portability.test.ts`).

## Not built

Provider clients, embedded signing, wiring into a catalog role, connector and credential work, and
routing a provider's webhooks to a host.
