/**
 * `--model local/<id>`: a role run against a model on the operator's own machine, behind an
 * OpenAI-compatible chat-completions endpoint (llama.cpp's `llama-server`, vLLM, Ollama's
 * `/v1`). The endpoint here is a fake served in-process on the loopback interface, so nothing leaves
 * the machine and no hosted key is set.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CliIo, runCli } from "./cli.js";
import { LOCAL_ENV } from "./local-model.js";

const sampleDesk = fileURLToPath(new URL("../../sdk/fixtures/sample-desk", import.meta.url));

const temps: string[] = [];
afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** `officehum run` of the sample desk on the local model, with its own database. */
function localRun(): string[] {
  const directory = mkdtempSync(join(tmpdir(), "officehum-local-model-"));
  temps.push(directory);
  return ["run", sampleDesk, "--model", "local/test-model", "--db", join(directory, "o.sqlite")];
}

interface Received {
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown>;
}

/** A chat-completions endpoint that answers every request with `reply`, or with `status`. */
async function fakeEndpoint(answer: { reply: string } | { status: number }): Promise<{
  readonly baseUrl: string;
  readonly received: Received[];
  close(): Promise<void>;
}> {
  const received: Received[] = [];
  const read = async (request: IncomingMessage): Promise<string> => {
    let text = "";
    for await (const chunk of request) text += String(chunk);
    return text;
  };
  const server: Server = createServer(async (request, response) => {
    received.push({
      path: request.url ?? "",
      authorization: request.headers.authorization,
      body: JSON.parse(await read(request)) as Record<string, unknown>,
    });
    if ("status" in answer) {
      response.writeHead(answer.status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "the model is not loaded" } }));
      return;
    }
    const chunk = (delta: Record<string, unknown>, finish: string | null) =>
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 0,
        model: "test-model",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(chunk({ role: "assistant", content: answer.reply }, null));
    response.write(chunk({}, "stop"));
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    received,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function terminal(lines: (string | undefined)[]) {
  const output: string[] = [];
  const errors: string[] = [];
  const io: CliIo = {
    output: (line) => output.push(line),
    error: (line) => errors.push(line),
    readLine: async () => lines.shift(),
    readApproval: async () => undefined,
  };
  return { io, output, errors };
}

const HOSTED_KEYS = ["PAPERINSTRUMENTS_API_KEY", "OPENAI_API_KEY"] as const;
const saved = new Map<string, string | undefined>();
beforeEach(() => {
  for (const name of [...HOSTED_KEYS, ...Object.values(LOCAL_ENV)]) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
});
afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("officehum run --model local/<id>", () => {
  it("runs a role against the local endpoint with no hosted key", async () => {
    const endpoint = await fakeEndpoint({ reply: "Hello from the local model." });
    try {
      process.env[LOCAL_ENV.baseUrl] = endpoint.baseUrl;
      const run = terminal(["hello", undefined]);
      const code = await runCli(localRun(), run.io);
      expect(run.errors).toEqual([]);
      expect(code).toBe(0);
      expect(run.output.join("\n")).toContain("Hello from the local model.");

      const [first] = endpoint.received;
      expect(first?.path).toBe("/v1/chat/completions");
      expect(first?.body.model).toBe("test-model");
      // The role's own tools go to the server as function tools.
      expect(Array.isArray(first?.body.tools)).toBe(true);
      // Local servers take the system prompt as `system` and no reasoning or store fields.
      const messages = (first?.body.messages ?? []) as { role: string }[];
      expect(messages[0]?.role).toBe("system");
      expect(first?.body).not.toHaveProperty("reasoning_effort");
      expect(first?.body).not.toHaveProperty("store");
      // A keyless server is sent a placeholder, never a hosted key.
      expect(first?.authorization).toBe("Bearer local");
    } finally {
      await endpoint.close();
    }
  });

  it("sends the endpoint's own key when one is set", async () => {
    const endpoint = await fakeEndpoint({ reply: "ok" });
    try {
      process.env[LOCAL_ENV.baseUrl] = endpoint.baseUrl;
      process.env[LOCAL_ENV.apiKey] = "test-local-key";
      const run = terminal(["hello", undefined]);
      expect(await runCli(localRun(), run.io)).toBe(0);
      expect(endpoint.received[0]?.authorization).toBe("Bearer test-local-key");
    } finally {
      await endpoint.close();
    }
  });

  it("surfaces the endpoint's failure and tries no other provider", async () => {
    const endpoint = await fakeEndpoint({ status: 503 });
    try {
      process.env[LOCAL_ENV.baseUrl] = endpoint.baseUrl;
      const run = terminal(["hello", undefined]);
      await runCli(localRun(), run.io);
      // The run reports the turn unanswered with the model's error, as for any provider.
      expect(run.output).toContain("Outcome: unanswered");
      expect(run.errors).toContain("Unanswered: model_error");
      expect(endpoint.received.length).toBeGreaterThan(0);
      expect(endpoint.received.every((request) => request.body.model === "test-model")).toBe(true);
    } finally {
      await endpoint.close();
    }
  });

  it("says which variable to set when no endpoint is given, before loading the role", async () => {
    const run = terminal([undefined]);
    expect(await runCli(localRun(), run.io)).toBe(1);
    expect(run.errors.join("\n")).toContain(
      `Set ${LOCAL_ENV.baseUrl} to your server's OpenAI-compatible base URL, e.g. http://localhost:8080/v1, before running against local.`,
    );
  });

  it("refuses an endpoint that is not an http URL and a context window that is not a number", async () => {
    process.env[LOCAL_ENV.baseUrl] = "localhost:8080";
    const url = terminal([undefined]);
    expect(await runCli(localRun(), url.io)).toBe(1);
    expect(url.errors.join("\n")).toContain(
      `${LOCAL_ENV.baseUrl} must be an http or https URL such as http://localhost:8080/v1 (got "localhost:8080").`,
    );

    process.env[LOCAL_ENV.baseUrl] = "http://localhost:8080/v1";
    process.env[LOCAL_ENV.contextWindow] = "lots";
    const context = terminal([undefined]);
    expect(await runCli(localRun(), context.io)).toBe(1);
    expect(context.errors.join("\n")).toContain(
      `${LOCAL_ENV.contextWindow} must be a whole number of tokens, e.g. 32768 (got "lots").`,
    );
  });

  it("grades a role's scenario on the local model with officehum eval", async () => {
    // The fake answers in words and calls no tool, so the booking scenario is graded as failed.
    const endpoint = await fakeEndpoint({ reply: "I can't book that." });
    try {
      process.env[LOCAL_ENV.baseUrl] = endpoint.baseUrl;
      const run = terminal([]);
      const code = await runCli(
        [
          "eval",
          sampleDesk,
          "--model",
          "local/test-model",
          "--scenario",
          "books-free-slot",
          "--trials",
          "1",
          "--retries",
          "0",
        ],
        run.io,
      );
      expect(code).toBe(1);
      const report = run.output.join("\n");
      expect(report).toContain("Judge: local/test-model");
      expect(report).toContain("FAIL  books-free-slot (normal, 0/1 trials)");
      expect(report).toContain("check_schedule");
      expect(endpoint.received.length).toBeGreaterThan(0);
      expect(endpoint.received.every((request) => request.body.model === "test-model")).toBe(true);
    } finally {
      await endpoint.close();
    }
  });

  it("names local among the providers it can run", async () => {
    const run = terminal([undefined]);
    expect(await runCli(["run", sampleDesk, "--model", "wat/thing"], run.io)).toBe(1);
    expect(run.errors.join("\n")).toContain("with one of: paper, local, ");
  });
});
