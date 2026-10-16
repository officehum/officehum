/**
 * The prompt-cache check, run for every role in `agents/*`: over three scripted turns the system
 * message and the role's stable sections must stay byte-identical, and the system message must lead
 * the request. The scripted provider records each request. No network and no real model are used.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Scenario } from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import { scriptedProvider } from "../testing/scripted-model.js";
import { piDurableRunner } from "./pi-durable-runner.js";
import { type PromptCacheRequest, promptCacheFailures } from "./prompt-cache.js";

/** Every role package under `agents/`: a directory holding an `officehum.json`. */
function roleDirectories(): string[] {
  const agents = fileURLToPath(new URL("../../../../agents", import.meta.url));
  return readdirSync(agents, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(agents, entry.name))
    .filter((dir) => {
      try {
        return statSync(join(dir, "officehum.json")).isFile();
      } catch {
        return false;
      }
    });
}

/** Three model turns — two calls to the SDK's `read_skill`, then an answer — so three requests land. */
const SCRIPT = [
  { toolCalls: [{ name: "read_skill", args: { name: "not-a-skill" } }] },
  { toolCalls: [{ name: "read_skill", args: { name: "not-a-skill" } }] },
  { text: "Done." },
] as const;

function scenario(): Scenario {
  return {
    id: "prompt-cache",
    description: "Three scripted turns for the prompt-cache check.",
    input: { kind: "message", text: "Go." },
    stubs: {},
    expect: {},
  };
}

const directories = roleDirectories();

describe("prompt cache", () => {
  it("finds at least one role to check", () => {
    expect(directories.length).toBeGreaterThan(0);
  });

  for (const dir of directories) {
    const name = dir.split("/").pop() ?? dir;
    it(`keeps the system message and stable sections byte-identical and leading for ${name}`, async () => {
      const scripted = scriptedProvider(SCRIPT);
      const runner = piDurableRunner({ dir, model: () => scripted });
      const trace = await runner.run(scenario(), 1);

      expect(trace.error).toBeUndefined();
      expect(scripted.requests).toHaveLength(3);
      expect(promptCacheFailures(scripted.requests)).toEqual([]);
    });
  }
});

describe("promptCacheFailures", () => {
  const request = (over: Partial<PromptCacheRequest>): PromptCacheRequest => ({
    messages: [{ role: "system" }, { role: "user" }],
    system: "SYS",
    sections: { agents_md: "A", skills: "B" },
    ...over,
  });

  it("passes three identical requests", () => {
    expect(promptCacheFailures([request({}), request({}), request({})])).toEqual([]);
  });

  it("fails when the system message does not lead", () => {
    const failures = promptCacheFailures([
      request({}),
      request({ messages: [{ role: "user" }] }),
      request({}),
    ]);
    expect(failures).toContain(
      'prompt cache: request 2: the system message does not lead the context (the first message is "user"); Pi Durable 1.1.0 put it first',
    );
  });

  it("fails when the system prompt or a stable section changes", () => {
    const failures = promptCacheFailures([
      request({}),
      request({ system: "OTHER" }),
      request({ sections: { agents_md: "changed" } }),
    ]);
    expect(failures).toContain(
      "prompt cache: request 2: the system message is not byte-identical to request 1",
    );
    expect(failures).toContain(
      "prompt cache: request 3: the stable sections changed from request 1",
    );
  });

  it("fails when fewer than three requests were recorded", () => {
    expect(promptCacheFailures([request({})])).toContain(
      "prompt cache: needs 3 requests to compare; got 1",
    );
  });
});
