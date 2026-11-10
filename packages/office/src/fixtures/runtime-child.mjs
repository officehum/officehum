/**
 * Serves the runtime over this process's stdin/stdout, so a test can kill it mid-tool and start it
 * again on the same SQLite file. Used by `runtime/runtime-kill.test.ts`.
 *
 * The role is built inline (not loaded from a package directory), like `role-run-child.mjs`, so this
 * plain-node process needs no TypeScript build step: one safe tool and one unsafe tool, both recording
 * their calls to `calls.log`. The unsafe tool tells the parent over IPC when it starts, then blocks.
 * On restart the model sees what Pi Durable reports for the interrupted unsafe call; the script writes
 * any tool result for it to `seen.log`.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { serveRuntime } from "@officehum/office";
import { scriptedProvider } from "@officehum/office/testing";

const directory = process.env.OFFICEHUM_TEST_DIRECTORY;
const phase = process.env.OFFICEHUM_TEST_PHASE ?? "first";
if (directory === undefined) throw new Error("OFFICEHUM_TEST_DIRECTORY is required");

const record = (file, line) => appendFileSync(join(directory, file), `${line}\n`);
const tell = (message) =>
  new Promise((resolve, reject) => {
    if (process.send === undefined) return resolve();
    process.send(message, (error) => (error === null ? resolve() : reject(error)));
  });

const safeStep = defineTool({
  name: "safe_step",
  description: "A read-only step that may run again after a crash.",
  parameters: Type.Object({}),
  replay: "safe",
  execute: async () => {
    record("calls.log", "safe_step");
    return { output: [{ type: "text", text: "safe step done" }] };
  },
});

const unsafeStep = defineTool({
  name: "unsafe_step",
  description: "A side-effecting step that must not run twice.",
  parameters: Type.Object({}),
  replay: "unsafe",
  execute: async () => {
    record("calls.log", "unsafe_step");
    await tell({ status: "unsafe-started" });
    await new Promise(() => {});
  },
});

const extension = defineExtension({ name: "runtime-fixture", tools: [safeStep, unsafeStep] });
const role = {
  dir: directory,
  manifest: {
    id: "worker",
    role: "Runs two steps",
    tools: [
      { name: "safe_step", replay: "safe" },
      { name: "unsafe_step", replay: "unsafe" },
    ],
  },
  bundle: { extensions: [extension], agent: { extensions: [extension] } },
  approvalFacts: {},
};

let turn = 0;
const script = (messages) => {
  for (const message of messages) {
    if (message.role === "toolResult" && message.toolName === "unsafe_step") {
      record("seen.log", JSON.stringify(message.content));
    }
  }
  turn += 1;
  if (phase === "first") {
    return turn === 1
      ? { toolCalls: [{ name: "safe_step" }] }
      : { toolCalls: [{ name: "unsafe_step" }] };
  }
  return turn === 1 ? { toolCalls: [{ name: "safe_step" }] } : { text: "resumed and finished" };
};
const scripted = scriptedProvider(script);

await serveRuntime({
  serverId: "office-kill",
  roles: [role],
  storage: { sqlite: join(directory, "office.sqlite") },
  models: scripted.models,
  model: scripted.model,
  input: process.stdin,
  output: process.stdout,
  log: (line) => process.stderr.write(`${line}\n`),
});
process.exit(0);
