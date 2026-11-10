/**
 * A runtime for the gateway's tests: the real runtime (`serveRuntime` from the built
 * `@officehum/office`) over stdin/stdout, with an inline role and the scripted model, so the gateway
 * supervises an actual child process and can kill it.
 *
 * The scripted model reads the transcript, so a restarted process carries on where the last one was:
 * - "unsafe …": `safe_step`, then `unsafe_step`, which writes `unsafe-started` and blocks until the
 *   process is killed; once the model sees the interrupted unsafe call it answers "resumed and finished".
 * - "lookup …": `safe_step`, then "Looked it up.".
 * - anything else: "Echo: <text>".
 * Every tool call is appended to `calls.log` in `FIXTURE_DIR`.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { serveRuntime } from "@officehum/office";
import { scriptedProvider } from "@officehum/office/testing";

const directory = process.env.FIXTURE_DIR;
if (directory === undefined) throw new Error("FIXTURE_DIR is required");
const record = (name) => appendFileSync(join(directory, "calls.log"), `${name}\n`);

const safeStep = defineTool({
  name: "safe_step",
  description: "A read-only step.",
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
    writeFileSync(join(directory, "unsafe-started"), "");
    await new Promise(() => {});
  },
});
const extension = defineExtension({ name: "gateway-fixture", tools: [safeStep, unsafeStep] });
const role = {
  dir: directory,
  manifest: {
    id: "worker",
    role: "Runs steps for the gateway's tests",
    tools: [
      { name: "safe_step", replay: "safe" },
      { name: "unsafe_step", replay: "unsafe" },
    ],
  },
  bundle: { extensions: [extension], agent: { extensions: [extension] } },
  approvalFacts: {},
};

const textOf = (message) =>
  typeof message.content === "string"
    ? message.content
    : message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");

const script = (messages) => {
  const lastUser = messages.findLastIndex((message) => message.role === "user");
  const request = lastUser === -1 ? "" : textOf(messages[lastUser]);
  const results = messages.slice(lastUser + 1).filter((message) => message.role === "toolResult");
  const last = results.at(-1)?.toolName;
  if (request.startsWith("unsafe")) {
    if (last === undefined) return { toolCalls: [{ name: "safe_step" }] };
    if (last === "safe_step" && !results.some((result) => result.toolName === "unsafe_step")) {
      return { toolCalls: [{ name: "unsafe_step" }] };
    }
    return { text: "resumed and finished" };
  }
  if (request.startsWith("lookup")) {
    return last === undefined ? { toolCalls: [{ name: "safe_step" }] } : { text: "Looked it up." };
  }
  return { text: `Echo: ${request}` };
};
const scripted = scriptedProvider(script);

await serveRuntime({
  serverId: "office-gw",
  roles: [role],
  storage: { sqlite: join(directory, "office.sqlite") },
  models: scripted.models,
  model: scripted.model,
  input: process.stdin,
  output: process.stdout,
  log: (line) => process.stderr.write(`${line}\n`),
});
process.exit(0);
