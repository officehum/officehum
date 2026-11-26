/**
 * Word and Excel through the pinned Paper worker. These need a provisioned interpreter and skip
 * visibly when `OFFICEHUM_PAPER_PYTHON` is unset, exactly as the Paper Office suites do.
 */

import { join } from "node:path";
import { localVersionedFileStore, type VersionedFileStore } from "@officehum/sdk";
import {
  type DocumentService,
  localDocumentService,
  runLedger,
  subprocessPaperWorker,
} from "@officehum/tools-paper-office";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { documentGenerator } from "./generator.js";
import { sampleData } from "./schema.js";
import { builtinTemplates } from "./templates.js";
import { configuredInterpreter, leaseFor, removeTempDirs, tempDir } from "./test-helpers.js";

const interpreter = configuredInterpreter();
const suite = interpreter === undefined ? describe.skip : describe;

if (interpreter === undefined) {
  console.warn(
    "document generation Word and Excel suites skipped: set OFFICEHUM_PAPER_PYTHON to a provisioned " +
      "Python 3.13 (see packages/tools-paper-office/scripts/provision-worker.sh).",
  );
}

let root = "";
let store: VersionedFileStore;
let service: DocumentService;

beforeEach(() => {
  root = tempDir();
  store = localVersionedFileStore(join(root, "files"));
  service = localDocumentService({
    store,
    worker: subprocessPaperWorker({ interpreter: interpreter ?? "", graceSeconds: 30 }),
    ledger: runLedger(join(root, "ledger")),
    createdBy: "role:document-desk",
  });
});
afterEach(removeTempDirs);

const generator = () =>
  documentGenerator({
    store,
    service,
    createdBy: "role:document-desk",
    branding: { companyName: "Acme Supplies" },
  });

suite("the built-in templates as Word and Excel", () => {
  for (const template of builtinTemplates()) {
    for (const format of template.formats.filter((entry) => entry !== "pdf") as (
      | "docx"
      | "xlsx"
    )[]) {
      it(`${template.name} renders a ${format} draft that records its template`, async () => {
        const rendered = await generator().renderDocument({
          template: template.name,
          data: sampleData(template.schema),
          format,
          name: template.name,
          operationId: `conv:office:${template.name}:${format}`,
          taskId: "task:1",
          lease: leaseFor(),
        });
        expect(rendered.ref).toMatchObject({
          name: `${template.name}.${format}`,
          metadata: {
            createdBy: "role:document-desk",
            source: "generated",
            template: { name: template.name, version: template.version },
          },
        });
        expect(rendered.previewNote).toMatch(/^no preview/u);
      }, 60_000);
    }
  }

  it("keeps one draft per operation ID across a replay", async () => {
    const template = builtinTemplates().find((entry) => entry.name === "customer-statement");
    const request = {
      template: "customer-statement",
      data: sampleData(template?.schema ?? {}),
      format: "xlsx" as const,
      name: "statement",
      operationId: "conv:office:replay",
      taskId: "task:1",
      lease: leaseFor(),
    };
    const first = await generator().renderDocument(request);
    const again = await generator().renderDocument(request);
    expect(again.ref.versionId).toBe(first.ref.versionId);
    expect((await store.getHead(first.ref.id))?.versionId).toBe(first.ref.versionId);
  }, 60_000);
});
