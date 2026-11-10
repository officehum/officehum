import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { type EventMessage, LineDecoder, type ServerMessage } from "@officehum/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OfficeStorage } from "../adapter/index.js";
import type { LoadedRole } from "../roles/load-role.js";
import { type ScriptedScript, scriptedProvider } from "../testing/scripted-model.js";
import { openRuntime, type Runtime, scopedRequestId, serveRuntime } from "./runtime.js";

const ada = { id: "ada", roles: ["staff"] };
const bo = { id: "bo", roles: ["staff"] };

const temps: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A role built inline: one safe tool, `lookup`, that waits on `gate` when one is set. */
function helperRole(name = "helper", gate?: () => Promise<void>): LoadedRole {
  const lookup = defineTool({
    name: "lookup",
    description: "Looks something up.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async () => {
      await gate?.();
      return { output: [{ type: "text", text: "found it" }] };
    },
  });
  const extension = defineExtension({ name: `${name}-tools`, tools: [lookup] });
  return {
    dir: "/fixture",
    manifest: { id: name, role: "Helps with lookups", tools: [{ name: "lookup", replay: "safe" }] },
    bundle: { extensions: [extension], agent: { extensions: [extension] } },
    approvalFacts: {},
  } as unknown as LoadedRole;
}

/** Look something up, then answer: the turn sequence for one request. */
const lookupThenAnswer: ScriptedScript = (messages) =>
  messages.at(-1)?.role === "toolResult"
    ? { text: "All done." }
    : { toolCalls: [{ name: "lookup" }] };

async function open(
  script: ScriptedScript,
  options: { roles?: LoadedRole[]; storage?: OfficeStorage } = {},
) {
  const scripted = scriptedProvider(script);
  const sent: ServerMessage[] = [];
  const runtime = await openRuntime({
    serverId: "office-test",
    roles: options.roles ?? [helperRole()],
    storage: options.storage ?? "memory",
    models: scripted.models,
    model: scripted.model,
    send: (message) => sent.push(message),
  });
  runtimes.push(runtime);
  const find = (predicate: (message: ServerMessage) => boolean) =>
    vi.waitFor(
      () => {
        const found = sent.find(predicate);
        if (found === undefined) throw new Error("not sent yet");
        return found;
      },
      { timeout: 10_000, interval: 10 },
    );
  const eventsFor = (requestId: string) =>
    sent.filter(
      (message): message is EventMessage =>
        message.type === "event" && message.requestId === requestId,
    );
  const settledFor = (requestId: string) =>
    find(
      (message) =>
        message.type === "event" &&
        message.requestId === requestId &&
        message.event.kind === "settled",
    ) as Promise<EventMessage>;
  return { runtime, scripted, sent, find, eventsFor, settledFor };
}

/** A forwarded submit; `principal: null` leaves the principal out. */
const submit = (id: string, requestId: string, principal: object | null = ada, extra = {}) => ({
  type: "submit",
  id,
  agent: "helper",
  requestId,
  input: { kind: "message", text: "Please look it up." },
  ...(principal === null ? {} : { principal }),
  ...extra,
});

describe("openRuntime", () => {
  it("sends welcome once the office is open", async () => {
    const { sent } = await open([]);
    expect(sent).toEqual([{ type: "welcome", version: 1, serverId: "office-test" }]);
  });

  it("runs a submission: accepted started, tool events, then settled done", async () => {
    const office = await open(lookupThenAnswer);
    await office.runtime.handle(submit("c1", "r1"));
    const key = scopedRequestId(ada, "r1");
    expect(key).toBe("ada/r1");
    expect(office.sent[1]).toEqual({
      type: "accepted",
      id: "c1",
      requestId: key,
      disposition: "started",
    });

    const settled = await office.settledFor(key);
    expect(settled.event).toEqual({ kind: "settled", status: "done", answer: "All done." });
    const events = office.eventsFor(key);
    expect(events.map((message) => message.seq)).toEqual(events.map((_, index) => index + 1));
    const kinds = events
      .map((message) => message.event.kind)
      .filter((kind) => kind !== "text_delta");
    expect(kinds).toEqual(["tool_start", "tool_end", "settled"]);
    expect(events.find((message) => message.event.kind === "tool_end")?.event).toMatchObject({
      tool: "lookup",
      ok: true,
    });
  });

  it("answers the same request id again with existing, no new model call, and the same result", async () => {
    const office = await open(lookupThenAnswer);
    await office.runtime.handle(submit("c1", "r1"));
    const first = await office.settledFor("ada/r1");
    const calls = office.scripted.calls;

    const before = office.sent.length;
    await office.runtime.handle(submit("c2", "r1"));
    const replies = office.sent.slice(before);
    expect(replies[0]).toEqual({
      type: "accepted",
      id: "c2",
      requestId: "ada/r1",
      disposition: "existing",
    });
    expect(replies.at(-1)).toEqual(first);
    expect(office.scripted.calls).toBe(calls);
  });

  it("keeps two principals' requests apart even with the same request id", async () => {
    const office = await open(lookupThenAnswer);
    await office.runtime.handle(submit("c1", "same", ada));
    await office.runtime.handle(submit("c2", "same", bo));
    expect(await office.find((m) => m.type === "accepted" && m.id === "c2")).toMatchObject({
      requestId: "bo/same",
      disposition: expect.stringMatching(/started|queued/),
    });
    await office.settledFor("ada/same");
    await office.settledFor("bo/same");
    // Each ran its own lookup and answer.
    expect(office.scripted.calls).toBe(4);
  });

  it("cannot be confused by a principal id containing a slash", () => {
    expect(scopedRequestId({ id: "a/b", roles: [] }, "c")).not.toBe(
      scopedRequestId({ id: "a", roles: [] }, "b/c"),
    );
  });

  it("queues a second submission while the conversation is busy, and attributes events to each", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const office = await open(lookupThenAnswer, {
      roles: [
        helperRole("helper", async () => {
          if (first) {
            first = false;
            await gate;
          }
        }),
      ],
    });
    await office.runtime.handle(submit("c1", "r1"));
    await office.find((m) => m.type === "event" && m.event.kind === "tool_start");
    await office.runtime.handle(submit("c2", "r2"));
    expect(office.sent.find((m) => m.type === "accepted" && m.id === "c2")).toMatchObject({
      disposition: "queued",
    });
    release();
    await office.settledFor("ada/r1");
    await office.settledFor("ada/r2");
    const toolEnds = (key: string) =>
      office.eventsFor(key).filter((message) => message.event.kind === "tool_end").length;
    expect(toolEnds("ada/r1")).toBe(1);
    expect(toolEnds("ada/r2")).toBe(1);
  });

  it("submits a ticket as the role's input", async () => {
    const office = await open([{ text: "Ticket handled." }]);
    await office.runtime.handle(
      submit("c1", "t1", ada, {
        input: { kind: "ticket", type: "example.task", payload: { note: "anything" } },
      }),
    );
    expect((await office.settledFor("ada/t1")).event).toMatchObject({
      status: "done",
      answer: "Ticket handled.",
    });
    expect(JSON.stringify(office.scripted.requests[0]?.messages)).toContain(
      'Ticket example.task: {\\"note\\":\\"anything\\"}',
    );
  });

  it("keeps a request across a restart: the same request id is existing, with its answer", async () => {
    const directory = mkdtempSync(join(tmpdir(), "officehum-runtime-"));
    temps.push(directory);
    const storage = { sqlite: join(directory, "office.sqlite") };
    const first = await open([{ text: "Remembered." }], { storage });
    await first.runtime.handle(submit("c1", "r1"));
    await first.settledFor("ada/r1");
    await first.runtime.close();

    const second = await open([], { storage });
    await second.runtime.handle(submit("c2", "r1"));
    expect(second.sent[1]).toMatchObject({ type: "accepted", disposition: "existing" });
    expect((await second.settledFor("ada/r1")).event).toEqual({
      kind: "settled",
      status: "done",
      answer: "Remembered.",
    });
    expect(second.scripted.calls).toBe(0);
  });
});

describe("runtime commands", () => {
  it("refuses a command without a principal as unauthorized", async () => {
    const office = await open([]);
    await office.runtime.handle(submit("c1", "r1", null));
    expect(office.sent[1]).toMatchObject({ type: "error", id: "c1", code: "unauthorized" });
    expect(office.scripted.calls).toBe(0);
  });

  it("refuses an invalid command with every problem listed", async () => {
    const office = await open([]);
    await office.runtime.handle({ type: "submit", id: "c1", principal: ada });
    expect(office.sent[1]).toMatchObject({
      type: "error",
      id: "c1",
      code: "invalid_message",
      problems: expect.arrayContaining([{ path: "agent", message: "is required" }]),
    });
  });

  it("refuses an unknown agent", async () => {
    const office = await open([]);
    await office.runtime.handle({ ...submit("c1", "r1"), agent: "nobody" });
    expect(office.sent[1]).toMatchObject({ type: "error", id: "c1", code: "unknown_agent" });
  });

  it("answers hello with welcome and ping with a result", async () => {
    const office = await open([]);
    await office.runtime.handle({ type: "hello", version: 1, client: "gateway" });
    await office.runtime.handle({ type: "hello", version: 2, client: "gateway" });
    await office.runtime.handle({ type: "ping", id: "p1", principal: ada });
    expect(office.sent.slice(1)).toEqual([
      { type: "welcome", version: 1, serverId: "office-test" },
      expect.objectContaining({ type: "error", code: "unsupported_version" }),
      { type: "result", id: "p1", ok: true },
    ]);
  });

  it("replays a settled request's events after afterSeq, always including settled", async () => {
    const office = await open(lookupThenAnswer);
    await office.runtime.handle(submit("c1", "r1"));
    const settled = await office.settledFor("ada/r1");

    const before = office.sent.length;
    await office.runtime.handle({
      type: "subscribe",
      id: "s1",
      requestId: "r1",
      afterSeq: settled.seq,
      principal: ada,
    });
    expect(office.sent.slice(before)).toEqual([{ type: "result", id: "s1", ok: true }, settled]);

    const again = office.sent.length;
    await office.runtime.handle({ type: "subscribe", id: "s2", requestId: "r1", principal: ada });
    expect(office.sent.slice(again + 1)).toEqual(office.eventsFor("ada/r1").slice(0, settled.seq));
  });

  it("does not let one principal subscribe to another's request", async () => {
    const office = await open([{ text: "Mine." }]);
    await office.runtime.handle(submit("c1", "r1", ada));
    await office.settledFor("ada/r1");
    await office.runtime.handle({ type: "subscribe", id: "s1", requestId: "r1", principal: bo });
    expect(office.sent.at(-1)).toMatchObject({ type: "error", id: "s1", code: "not_found" });
  });

  it("aborts nothing for a settled request, and refuses an unknown one", async () => {
    const office = await open([{ text: "Done." }]);
    await office.runtime.handle(submit("c1", "r1"));
    await office.settledFor("ada/r1");
    await office.runtime.handle({ type: "abort", id: "a1", requestId: "r1", principal: ada });
    expect(office.sent.at(-1)).toEqual({ type: "result", id: "a1", ok: true });
    await office.runtime.handle({ type: "abort", id: "a2", requestId: "nope", principal: ada });
    expect(office.sent.at(-1)).toMatchObject({ type: "error", id: "a2", code: "not_found" });
  });

  it("lists agents with their model and tools, and reports their state", async () => {
    const office = await open([{ text: "Done." }]);
    await office.runtime.handle({ type: "list_agents", id: "l1", principal: ada });
    expect(office.sent.at(-1)).toEqual({
      type: "result",
      id: "l1",
      ok: true,
      data: {
        agents: [
          {
            name: "helper",
            role: "Helps with lookups",
            model: `${office.scripted.model.provider}/${office.scripted.model.modelId}`,
            tools: [{ name: "lookup", replay: "safe" }],
          },
        ],
      },
    });
    await office.runtime.handle({ type: "get_state", id: "g1", agent: "helper", principal: ada });
    expect(office.sent.at(-1)).toMatchObject({
      id: "g1",
      data: { agents: [{ name: "helper", status: "idle", openRequests: 0 }] },
    });
    await office.runtime.handle({ type: "get_state", id: "g2", agent: "nobody", principal: ada });
    expect(office.sent.at(-1)).toMatchObject({ id: "g2", code: "unknown_agent" });
  });

  it("answers approve with not_found until remote approvals exist", async () => {
    const office = await open([]);
    await office.runtime.handle({
      type: "approve",
      id: "ap1",
      approvalId: "a-1",
      decision: "approve",
      principal: ada,
    });
    expect(office.sent.at(-1)).toMatchObject({ type: "error", id: "ap1", code: "not_found" });
  });
});

describe("serveRuntime", () => {
  it("speaks the protocol over streams and closes when the input ends", async () => {
    const scripted = scriptedProvider([{ text: "Hello there." }]);
    const input = new PassThrough();
    const output = new PassThrough();
    const frames: unknown[] = [];
    const decoder = new LineDecoder();
    output.on("data", (chunk: Buffer) => {
      for (const frame of decoder.push(chunk)) frames.push(frame.ok ? frame.value : frame);
    });
    const log: string[] = [];
    const served = serveRuntime({
      serverId: "office-test",
      roles: [helperRole()],
      storage: "memory",
      models: scripted.models,
      model: scripted.model,
      input,
      output,
      log: (line) => log.push(line),
    });
    input.write('{"type":"hello","version":1,"client":"gateway"}\nnot json\n');
    input.write(`${JSON.stringify(submit("c1", "r1"))}\n`);
    await vi.waitFor(
      () => {
        expect(frames).toContainEqual(
          expect.objectContaining({
            type: "event",
            event: expect.objectContaining({ kind: "settled" }),
          }),
        );
      },
      { timeout: 10_000 },
    );
    input.end();
    await served;
    expect(frames.slice(0, 4)).toEqual([
      { type: "welcome", version: 1, serverId: "office-test" },
      { type: "welcome", version: 1, serverId: "office-test" },
      { type: "error", code: "bad_frame", message: "A line is not valid JSON." },
      { type: "accepted", id: "c1", requestId: "ada/r1", disposition: "started" },
    ]);
    expect(log).toEqual([]);
  });
});
