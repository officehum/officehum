/**
 * Test helpers: a fake `typst` that records how it was run, the real one when the host has it, a
 * store, and the fixture role. Kept out of the build (see `tsconfig.json`), typechecked by
 * `tsconfig.test.json`.
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import type { Conversation, JsonObject } from "@earendil-works/pi-durable";
import type { AgentManifest, DefinedRole } from "@officehum/sdk";
import { defineRole } from "@officehum/sdk";
import {
  DEFAULT_LIMITS,
  type DocumentLease,
  resolvePaperInterpreter,
} from "@officehum/tools-paper-office";
import { checkTypst, resolveTypst, TYPST_VERSION } from "./typst.js";

const temps: string[] = [];

export function tempDir(prefix = "docgen-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

export function removeTempDirs(): void {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** The real Typst the host configured, at the pinned version, or `undefined`. */
export function configuredTypst(): string | undefined {
  const binary = resolveTypst(process.env);
  if (binary === undefined) return undefined;
  return checkTypst(binary).ok ? binary : undefined;
}

/** The Paper worker's interpreter the host configured, or `undefined`. */
export function configuredInterpreter(): string | undefined {
  return resolvePaperInterpreter(process.env);
}

export interface FakeTypst {
  readonly binary: string;
  /** Every run, in order: its arguments, environment, working directory and the files it saw. */
  runs(): FakeRun[];
}

export interface FakeRun {
  readonly args: string[];
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly files: Record<string, string>;
}

/**
 * A stand-in `typst` (a Node script, run by absolute path so it needs no PATH). `--version` answers
 * `version`. `compile` writes a small PDF (`/Count` from a `FAKE_PAGES=n` marker in the template, 1
 * otherwise) or PNG, and obeys markers: `FAKE_ERROR` fails like a compile error, `FAKE_SLEEP` hangs,
 * `FAKE_BIG_PNG` writes a preview over 100 KB.
 */
export function fakeTypst(version = TYPST_VERSION): FakeTypst {
  const dir = tempDir("docgen-fake-typst-");
  const log = join(dir, "runs.jsonl");
  writeFileSync(log, "");
  const script = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("typst ${version} (fake)\\n"); process.exit(0); }
const root = args[args.indexOf("--root") + 1];
const input = args[args.length - 2];
const output = args[args.length - 1];
const files = {};
for (const name of fs.readdirSync(root)) files[name] = fs.readFileSync(path.join(root, name)).toString("latin1");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, env: process.env, cwd: process.cwd(), files }) + "\\n");
const source = fs.readFileSync(input, "utf8");
if (source.includes("FAKE_SLEEP")) { setTimeout(() => {}, 60000); return; }
if (source.includes("FAKE_ERROR")) {
  process.stderr.write(path.basename(input) + ":2:5: error: unknown variable: nope\\n");
  process.exit(1);
}
const format = args[args.indexOf("--format") + 1];
if (format === "png") {
  const size = source.includes("FAKE_BIG_PNG") && !args.includes("32") ? 200000 : 2000;
  const bytes = Buffer.alloc(size, 7);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  fs.writeFileSync(output, bytes);
} else {
  const pages = (/FAKE_PAGES=(\\d+)/.exec(source) || [])[1] || "1";
  fs.writeFileSync(output, "%PDF-1.7\\n1 0 obj\\n<<\\n  /Type /Pages\\n  /Count " + pages + "\\n  /Kids []\\n>>\\nendobj\\n" + JSON.stringify(files["data.json"] || "") + "\\n%%EOF\\n");
}
`;
  const binary = join(dir, "typst");
  writeFileSync(binary, script);
  chmodSync(binary, 0o755);
  return {
    binary,
    runs: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as FakeRun),
  };
}

export function leaseFor(outputFormats: DocumentLease["outputFormats"] = ["docx", "xlsx"]) {
  return {
    leaseId: "lease:docgen",
    taskId: "task:1",
    inputs: [],
    outputFormats,
    limits: DEFAULT_LIMITS,
    expiresAt: "2999-01-01T00:00:00.000Z",
  } satisfies DocumentLease;
}

export const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/document-desk", import.meta.url));
export const FIXTURE_MANIFEST = JSON.parse(
  readFileSync(new URL("../fixtures/document-desk/officehum.json", import.meta.url), "utf8"),
) as AgentManifest;

/** The fixture role: the pack's two tools and nothing else. */
export function documentDesk(tools: DefinedRole["extensions"][number]["tools"]): DefinedRole {
  return defineRole({ packageDir: FIXTURE_DIR, manifest: FIXTURE_MANIFEST, tools: tools ?? [] });
}

export type Turn = { readonly tool: string; readonly args: JsonObject } | { readonly text: string };

/** A scripted model: each request takes the next turn, and answers "Done." when there is none. */
export function scriptedModel() {
  const faux = fauxProvider({
    provider: "scripted",
    api: "scripted",
    models: [{ id: "scripted-1" }],
  });
  const turns: Turn[] = [];
  const respond: FauxResponseFactory = (_context, _options, _state, model) => {
    faux.appendResponses([respond]);
    const turn = turns.shift() ?? { text: "Done." };
    const message =
      "text" in turn
        ? fauxAssistantMessage(turn.text)
        : fauxAssistantMessage(fauxToolCall(turn.tool, turn.args), { stopReason: "toolUse" });
    return { ...message, provider: model.provider, model: model.id };
  };
  faux.setResponses([respond]);
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, turns };
}

/** Runs the queued tool calls in `conversation`, then returns each tool result's content. */
export async function callTools(
  model: ReturnType<typeof scriptedModel>,
  conversation: Conversation,
  calls: readonly { readonly tool: string; readonly args: JsonObject }[],
): Promise<{ text: string; images: number }[]> {
  const before = (await conversation.context(BACKGROUND_CONTEXT)).messages.length;
  model.turns.push(...calls);
  const submission = await conversation.submit(
    { type: "input", content: "Go ahead." },
    BACKGROUND_CONTEXT,
  );
  await submission.wait(BACKGROUND_CONTEXT);
  const messages = (await conversation.context(BACKGROUND_CONTEXT)).messages.slice(before);
  return messages
    .filter((message) => message.role === "toolResult")
    .map((message) => {
      const blocks = message.content as { type: string; text?: string }[];
      return {
        text: blocks.map((block) => block.text ?? "").join(""),
        images: blocks.filter((block) => block.type === "image").length,
      };
    });
}
