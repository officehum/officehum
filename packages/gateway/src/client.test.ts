/**
 * `@officehum/client` against the real gateway and runtime: the library a web UI or integration would
 * use, over both of its transports, including a runtime crash in the middle of a run.
 */
import { GatewayClient, isGatewayError, makeRequestId } from "@officehum/client";
import { afterEach, describe, expect, it } from "vitest";
import { counts, start, token, waitForFile } from "./fixtures/harness.js";

const clients: GatewayClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});

async function clientFor(url: string, transport: "websocket" | "http" = "websocket") {
  const client = await GatewayClient.connect({
    url,
    token: () => token("ada", ["staff"]),
    transport,
    backoff: { initialMs: 50, maxMs: 200 },
  });
  clients.push(client);
  return client;
}

describe("@officehum/client against the gateway", () => {
  it("submits over WebSocket and streams to settled through a runtime crash", async () => {
    const { gateway, directory } = await start();
    const client = await clientFor(gateway.url);
    const requestId = await makeRequestId("acme", "worker", "2026-11-11", "unsafe work");
    const run = await client.submit({
      agent: "worker",
      requestId,
      input: { kind: "message", text: "unsafe work" },
    });
    expect(run.disposition).toBe("started");
    await waitForFile(directory, "unsafe-started");
    process.kill(gateway.runtimePid() as number, "SIGKILL");

    const kinds: string[] = [];
    for await (const event of run.events()) kinds.push(event.kind);
    expect(kinds.filter((kind) => kind === "settled")).toHaveLength(1);
    expect(await run.settled()).toEqual({
      kind: "settled",
      status: "done",
      answer: "resumed and finished",
    });
    expect(counts(directory).tools).toEqual({ safe_step: 1, unsafe_step: 1 });

    // The same requestId again is the stored request, not new work.
    const again = await client.submit({
      agent: "worker",
      requestId,
      input: { kind: "message", text: "unsafe work" },
    });
    expect(again.disposition).toBe("existing");
    expect((await again.settled()).answer).toBe("resumed and finished");
    expect(counts(directory).model).toEqual({ "unsafe work": 3 });
  }, 60_000);

  it("submits and streams over the HTTP fallback, with typed refusals", async () => {
    const { gateway } = await start();
    const client = await clientFor(gateway.url, "http");
    const run = await client.submit({
      agent: "worker",
      requestId: "h/1",
      input: { kind: "message", text: "lookup it" },
    });
    expect((await run.settled()).answer).toBe("Looked it up.");
    const refused = await client
      .submit({ agent: "elsewhere", requestId: "h2", input: { kind: "message", text: "x" } })
      .catch((error: unknown) => error);
    expect(isGatewayError(refused, "forbidden")).toBe(true);
  }, 60_000);
});
