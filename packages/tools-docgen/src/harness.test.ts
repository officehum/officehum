/**
 * The pack in a fixture role, in a bare Pi Durable harness: in-memory storage, a scripted model, a
 * fake `typst`, and nothing from Office Hum. The role passes `checkAgent`; a conversation lists the
 * templates, makes a statement PDF, and gets every field-level problem for data that does not fit.
 */

import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { checkAgent, localVersionedFileStore, type VersionedFileStore } from "@officehum/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sampleData } from "./schema.js";
import { builtinTemplates } from "./templates.js";
import {
  callTools,
  documentDesk,
  type FakeTypst,
  FIXTURE_MANIFEST,
  fakeTypst,
  removeTempDirs,
  scriptedModel,
  tempDir,
} from "./test-helpers.js";
import { documentGenerationPack } from "./tools.js";

const CTX = BACKGROUND_CONTEXT;

let store: VersionedFileStore;
let typst: FakeTypst;

beforeEach(() => {
  store = localVersionedFileStore(join(tempDir(), "files"));
  typst = fakeTypst();
});
afterEach(removeTempDirs);

function role() {
  const pack = documentGenerationPack({
    store,
    typst: typst.binary,
    createdBy: "role:document-desk",
    branding: { companyName: "Acme Supplies" },
  });
  return documentDesk(pack.tools);
}

async function open() {
  const model = scriptedModel();
  const desk = role();
  const registry = createRegistry();
  for (const extension of desk.extensions) registry.install(extension);
  const harness = await Harness.open(new MemoryStorage(), { models: model.models, registry }, CTX);
  const conversation = await harness.root(CTX, { agent: desk.agent });
  return { model, harness, conversation };
}

const statement = () =>
  structuredClone(
    sampleData(
      builtinTemplates().find((entry) => entry.name === "customer-statement")?.schema ?? {},
    ),
  ) as Record<string, unknown>;

describe("the fixture role", () => {
  it("passes checkAgent with the pack's two tools", async () => {
    expect((await checkAgent(role(), FIXTURE_MANIFEST, { strict: true })).issues).toEqual([]);
  });

  it("lists the templates, makes a statement and reports data that does not fit", async () => {
    const { model, harness, conversation } = await open();
    const wrong = statement();
    delete wrong.amountDue;
    const [templates, made, refused] = await callTools(model, conversation, [
      { tool: "document_templates", args: {} },
      {
        tool: "document_generate",
        args: {
          template: "customer-statement",
          data: statement() as never,
          format: "pdf",
          name: "statement-lee-hardware",
        },
      },
      {
        tool: "document_generate",
        args: { template: "customer-statement", data: wrong as never, format: "pdf", name: "x" },
      },
    ]);
    const listed = JSON.parse(templates?.text ?? "{}") as {
      templates: { name: string; formats: string[]; schema: Record<string, unknown> }[];
    };
    expect(listed.templates.map((template) => template.name)).toEqual([
      "customer-statement",
      "letter",
      "meeting-notes",
      "memo",
      "quote",
      "report",
    ]);
    // The examples hold sample figures; a model is never shown figures it could copy.
    expect(listed.templates.every((template) => !("examples" in template.schema))).toBe(true);

    expect(made?.text).toContain('"name":"statement-lee-hardware.pdf"');
    expect(made?.text).toContain('"template":"customer-statement"');
    expect(made?.images).toBe(1);
    const file = /"id":"(file_[0-9A-Z]+)"/u.exec(made?.text ?? "")?.[1] ?? "";
    expect((await store.info(file))?.metadata).toMatchObject({
      source: "generated",
      template: { name: "customer-statement" },
    });

    expect(JSON.parse(refused?.text ?? "{}")).toMatchObject({
      ok: false,
      code: "invalid-data",
      problems: [{ path: "data", message: "is missing amountDue" }],
    });
    await harness.close(CTX);
  });
});
