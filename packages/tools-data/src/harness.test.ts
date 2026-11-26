/**
 * The pack in a fixture role, in a bare Pi Durable harness: in-memory storage, a scripted model and
 * nothing from Office Hum. The role declares the four tools as pack tools (`"pack": "data"`) and is
 * given the pack as `packs`, as an office gives it. It passes `checkAgent` with and without the pack,
 * and a conversation inspects, queries and charts the sales file through the real tools.
 */

import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  Harness,
  type JsonObject,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import {
  type AgentManifest,
  checkAgent,
  defineRole,
  localVersionedFileStore,
  type VersionedFileStore,
} from "@officehum/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dataPack } from "./pack.js";
import { decimalText, putFile, salesTotals } from "./test-helpers.js";

const CTX = BACKGROUND_CONTEXT;
const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/data-desk", import.meta.url));
const MANIFEST = JSON.parse(
  readFileSync(new URL("../fixtures/data-desk/officehum.json", import.meta.url), "utf8"),
) as AgentManifest;

let root = "";
let store: VersionedFileStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "data-harness-"));
  store = localVersionedFileStore(join(root, "files"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The fixture role, given the data pack as an office gives it, or built without it. */
function role(withPack = true) {
  const pack = dataPack({ filesFor: async () => store, createdBy: "role:data-desk" });
  return defineRole({
    packageDir: FIXTURE_DIR,
    manifest: MANIFEST,
    ...(withPack ? { packs: [pack] } : {}),
  });
}

type Turn = { readonly tool: string; readonly args: JsonObject };

/** A scripted model: each request takes the next turn, and answers "Done." when there is none. */
function scriptedModel(turns: Turn[]) {
  const faux = fauxProvider({
    provider: "scripted",
    api: "scripted",
    models: [{ id: "scripted-1" }],
  });
  const respond: FauxResponseFactory = (_context, _options, _state, model) => {
    faux.appendResponses([respond]);
    const turn = turns.shift();
    const message =
      turn === undefined
        ? fauxAssistantMessage("Done.")
        : fauxAssistantMessage(fauxToolCall(turn.tool, turn.args), { stopReason: "toolUse" });
    return { ...message, provider: model.provider, model: model.id };
  };
  faux.setResponses([respond]);
  const models = createModels();
  models.setProvider(faux.provider);
  return models;
}

describe("the fixture role", () => {
  it("passes checkAgent with the pack's four tools", async () => {
    expect((await checkAgent(role(), MANIFEST, { strict: true, packs: ["data"] })).issues).toEqual(
      [],
    );
  });

  it("loads without the pack and offers none of its tools", async () => {
    const bare = role(false);
    expect(
      bare.extensions.flatMap((extension) => extension.tools ?? []).map((t) => t.name),
    ).toEqual(["read_skill"]);
    expect((await checkAgent(bare, MANIFEST, { strict: true })).issues).toEqual([]);
  });

  it("inspects, queries and charts a sales file in a bare harness", async () => {
    const sales = await putFile(store, "sales.csv");
    const tables = [{ name: "sales", file_id: sales.id }];
    const models = scriptedModel([
      { tool: "data_inspect", args: { file_id: sales.id } },
      { tool: "data_query", args: { tables, sql: "SELECT sum(amount) AS total FROM sales" } },
      {
        tool: "chart_render",
        args: {
          tables,
          sql: "SELECT region, count(*) AS orders FROM sales GROUP BY region",
          spec: {
            mark: "arc",
            encoding: {
              theta: { field: "orders", type: "quantitative" },
              color: { field: "region", type: "nominal" },
            },
          },
        },
      },
    ]);
    const desk = role();
    const registry = createRegistry();
    for (const extension of desk.extensions) registry.install(extension);
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, CTX);
    const conversation = await harness.root(CTX, { agent: desk.agent });
    const submission = await conversation.submit({ type: "input", content: "Go ahead." }, CTX);
    await submission.wait(CTX);
    const results = (await conversation.context(CTX)).messages
      .filter((message) => message.role === "toolResult")
      .map((message) =>
        (message.content as { type: string; text?: string }[]).map((b) => b.text ?? "").join(""),
      );
    expect(results).toHaveLength(3);
    expect(results[0]).toContain("10000 rows, 8 columns.");
    expect(results[1]).toContain(`| ${decimalText(salesTotals().cents)} |`);
    expect(results[2]).toContain('"rows":4');
    await harness.close(CTX);
  });
});
