/**
 * Remote approvals end to end (RASF-3108): a real gateway over a real runtime whose fixture role
 * gates `pay` above 100 through the runtime's remote approvals, decided by people signed in with
 * tokens, through `@officehum/client`.
 */
import { type ApprovalInfo, GatewayClient, isGatewayError } from "@officehum/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { counts, start, token } from "./fixtures/harness.js";

const clients: GatewayClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});

async function as(url: string, sub: string, roles: string[]) {
  const client = await GatewayClient.connect({
    url,
    token: () => token(sub, roles),
    backoff: { initialMs: 50, maxMs: 200 },
  });
  clients.push(client);
  return client;
}

/** A director's connection watching approvals, with everything it heard. */
async function watcher(url: string, sub = "dee", roles = ["director"]) {
  const client = await as(url, sub, roles);
  const heard: ApprovalInfo[] = [];
  await client.watchApprovals((approval) => heard.push(approval));
  const pending = () =>
    vi.waitFor(
      () => {
        const found = heard.find((approval) => approval.status === "pending");
        if (found === undefined) throw new Error(`no approval yet; heard ${JSON.stringify(heard)}`);
        return found;
      },
      { timeout: 20_000, interval: 25 },
    );
  return { client, heard, pending };
}

const pay = (amount: number, requestId = "p1") => ({
  agent: "worker",
  requestId,
  input: { kind: "message" as const, text: `pay ${amount}` },
});

describe("remote approvals through the gateway", () => {
  it("asks only authorised approvers, and an approval through the client runs the tool once", async () => {
    const { gateway, directory, log } = await start();
    const director = await watcher(gateway.url);
    const staff = await as(gateway.url, "ada", ["staff"]);
    expect(
      isGatewayError(
        await staff.watchApprovals(() => {}).catch((error: unknown) => error),
        "forbidden",
      ),
    ).toBe(true);

    const run = await staff.submit(pay(250));
    const asked = await director.pending();
    expect(asked).toMatchObject({ agent: "worker", tool: "pay", amount: 250 });
    const kinds: string[] = [];
    const streamed = (async () => {
      for await (const event of run.events()) kinds.push(event.kind);
    })();

    // Ada may submit work, but not approve it.
    expect(
      isGatewayError(
        await staff
          .approve({ approvalId: asked.approvalId, decision: "approve" })
          .catch((error: unknown) => error),
        "forbidden",
      ),
    ).toBe(true);
    const decided = await director.client.approve({
      approvalId: asked.approvalId,
      decision: "approve",
    });
    expect(decided).toMatchObject({ status: "approved", by: "dee" });

    expect(await run.settled()).toEqual({
      kind: "settled",
      status: "done",
      answer: "Result: paid 250",
    });
    await streamed;
    expect(kinds).toEqual(
      expect.arrayContaining(["approval_requested", "approval_decided", "settled"]),
    );
    expect(counts(directory).tools).toEqual({ pay: 1 });
    // The runtime's audit names the token's principal.
    expect(
      log.some((line) => line.includes(`${asked.approvalId} (worker pay) approved by dee`)),
    ).toBe(true);
  }, 60_000);

  it("never runs a declined call, and the run settles with the reason", async () => {
    const { gateway, directory } = await start();
    const director = await watcher(gateway.url);
    const run = await (await as(gateway.url, "ada", ["staff"])).submit(pay(250));
    const asked = await director.pending();
    await director.client.approve({
      approvalId: asked.approvalId,
      decision: "decline",
      note: "over budget",
    });
    const settled = await run.settled();
    expect(settled.answer).toContain("declined");
    expect(settled.answer).toContain("over budget");
    expect(counts(directory).tools).toEqual({});
  }, 60_000);

  it("declines a request nobody answers in time, and the tool never runs", async () => {
    const { gateway, directory } = await start(undefined, { FIXTURE_APPROVAL_TIMEOUT_MS: "400" });
    const director = await watcher(gateway.url);
    const run = await (await as(gateway.url, "ada", ["staff"])).submit(pay(250));
    await director.pending();
    expect((await run.settled()).answer).toContain("timed out");
    expect(counts(directory).tools).toEqual({});
    await vi.waitFor(
      () => expect(director.heard.some((approval) => approval.note === "timed out")).toBe(true),
      { timeout: 10_000, interval: 25 },
    );
  }, 60_000);

  it("refuses an approver above their limit", async () => {
    const { gateway, directory } = await start();
    const director = await watcher(gateway.url);
    const run = await (await as(gateway.url, "ada", ["staff"])).submit(pay(250));
    const asked = await director.pending();
    // The manager rule caps approvals at 100.
    const manager = await as(gateway.url, "max", ["manager"]);
    const refused = await manager
      .approve({ approvalId: asked.approvalId, decision: "approve" })
      .catch((error: unknown) => error);
    expect(isGatewayError(refused, "forbidden")).toBe(true);
    expect((refused as Error).message).toContain("above your approval limit of 100");
    await director.client.approve({ approvalId: asked.approvalId, decision: "approve" });
    await run.settled();
    expect(counts(directory).tools).toEqual({ pay: 1 });
  }, 60_000);

  it("keeps an approval pending when the runtime is killed, and a decision then resumes the run once", async () => {
    const { gateway, directory } = await start();
    const director = await watcher(gateway.url);
    const run = await (await as(gateway.url, "ada", ["staff"])).submit(pay(250));
    const asked = await director.pending();
    const first = gateway.runtimePid() as number;
    process.kill(first, "SIGKILL");
    await vi.waitFor(
      () => {
        expect(gateway.runtimeUp()).toBe(true);
        expect(gateway.runtimePid()).not.toBe(first);
      },
      { timeout: 20_000, interval: 25 },
    );
    // The resumed run asks again for the same call: the same approval, still waiting.
    await vi.waitFor(
      () =>
        expect(
          director.heard.filter(
            (approval) => approval.approvalId === asked.approvalId && approval.status === "pending",
          ).length,
        ).toBeGreaterThanOrEqual(2),
      { timeout: 20_000, interval: 25 },
    );
    await director.client.approve({ approvalId: asked.approvalId, decision: "approve" });
    expect((await run.settled()).answer).toBe("Result: paid 250");
    expect(counts(directory).tools).toEqual({ pay: 1 });
  }, 60_000);

  it("lets one of two approvers deciding at once win; the other gets conflict", async () => {
    const { gateway, directory } = await start();
    const dee = await watcher(gateway.url);
    const ray = await as(gateway.url, "ray", ["director"]);
    const run = await (await as(gateway.url, "ada", ["staff"])).submit(pay(250));
    const asked = await dee.pending();
    const outcomes = await Promise.allSettled([
      dee.client.approve({ approvalId: asked.approvalId, decision: "approve" }),
      ray.approve({ approvalId: asked.approvalId, decision: "decline" }),
    ]);
    const won = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const lost = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(isGatewayError((lost[0] as PromiseRejectedResult).reason, "conflict")).toBe(true);
    await run.settled();
    const approved = (won[0] as PromiseFulfilledResult<ApprovalInfo>).value.status === "approved";
    expect(counts(directory).tools).toEqual(approved ? { pay: 1 } : {});
  }, 60_000);
});
