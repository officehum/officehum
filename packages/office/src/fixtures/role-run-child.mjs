/**
 * Drives one role run in its own process, so a test can crash it mid-tool and resume on the same
 * SQLite file. Used by `run-role.test.ts`; the parent kills this process during the unsafe tool.
 *
 * The role is built inline (not loaded from a package directory) so this plain-node process needs no
 * TypeScript build step: it defines one safe tool and one unsafe tool, both recording their calls to
 * `calls.log`. Phase `first` submits the work and blocks inside the unsafe tool; phase `resume`
 * reacquires the settled submission and reports what it did.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { openRoleRun } from "@officehum/office";
import { scriptedProvider } from "@officehum/office/testing";

const directory = process.env.OFFICEHUM_TEST_DIRECTORY;
const phase = process.env.OFFICEHUM_TEST_PHASE ?? "first";
if (directory === undefined) throw new Error("OFFICEHUM_TEST_DIRECTORY is required");

const log = join(directory, "calls.log");
const record = (name) => appendFileSync(log, `${name}\n`);
const send = (message) =>
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
    record("safe_step");
    return { output: [{ type: "text", text: "safe step done" }] };
  },
});

const unsafeStep = defineTool({
  name: "unsafe_step",
  description: "A side-effecting step that must not run twice.",
  parameters: Type.Object({}),
  replay: "unsafe",
  execute: async () => {
    record("unsafe_step");
    await send({ status: "unsafe-started" });
    await new Promise(() => {});
  },
});

const extension = defineExtension({ name: "role-run-fixture", tools: [safeStep, unsafeStep] });
const bundle = {
  extensions: [extension],
  agent: { model: { provider: "scripted", modelId: "scripted-1" }, extensions: [extension] },
};
const role = {
  dir: directory,
  manifest: { id: "role-run-fixture" },
  bundle,
};

const script =
  phase === "resume"
    ? [{ toolCalls: [{ name: "safe_step" }] }, { text: "resumed and finished" }]
    : [{ toolCalls: [{ name: "safe_step" }] }, { toolCalls: [{ name: "unsafe_step" }] }];
const scripted = scriptedProvider(script);

try {
  const session = await openRoleRun({
    role,
    database: join(directory, "run.sqlite"),
    models: scripted.models,
    model: { provider: "scripted", modelId: "scripted-1" },
  });
  await send({ status: "opened" });
  if (phase === "resume") {
    const results = await session.resume();
    await session.close();
    await send({
      status: "resumed",
      outcomes: results.map((result) => result.settlement.status),
      text: results.map((result) => result.text ?? "").join(""),
    });
    process.exit(0);
  } else {
    // The unsafe tool blocks; the parent kills this process while it is running.
    void session.submit("run the steps", "kill-resume-1").catch(() => {});
  }
} catch (error) {
  await send({ status: "error", message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
}
