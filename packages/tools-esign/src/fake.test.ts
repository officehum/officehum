/** The fake provider and the checks every provider's output passes through. */

import { describe, expect, it } from "vitest";
import { checkEvent, checkSendResult, checkStatusResult, ESignError, isPdf } from "./esign.js";
import { FAKE_SIGNATURE_HEADER, fakeESignature } from "./fake.js";

const request = {
  templateId: "tpl-nda",
  signers: [
    { name: "Dana Lee", email: "dana@client.example", role: "client" },
    { name: "Sam Ortiz", email: "sam@office.example", role: "company" },
  ],
  subject: "NDA",
  message: "Please sign.",
  requestId: "esign:1:1:call-1",
};

describe("fakeESignature", () => {
  it("deduplicates a send by request id, as every provider client must", async () => {
    const fake = fakeESignature();
    const first = await fake.send(request);
    const again = await fake.send(request);
    expect(again).toEqual(first);
    expect(fake.requests()).toHaveLength(1);
    expect(fake.sendCalls()).toBe(2);
    expect((await fake.send({ ...request, requestId: "esign:1:1:call-2" })).providerId).not.toBe(
      first.providerId,
    );
  });

  it("moves a request as its signers act, and gives the signed copy only once completed", async () => {
    const fake = fakeESignature();
    const { providerId } = await fake.send(request);
    fake.view(providerId, "dana@client.example");
    expect((await fake.status(providerId)).status).toBe("viewed");
    fake.sign(providerId, "dana@client.example");
    expect((await fake.status(providerId)).status).toBe("partially_signed");
    await expect(fake.downloadCompleted(providerId)).rejects.toThrow("not completed");
    fake.sign(providerId, "sam@office.example");
    const status = await fake.status(providerId);
    expect(status.status).toBe("completed");
    expect(status.signers.map((signer) => signer.status)).toEqual(["signed", "signed"]);
    const copy = await fake.downloadCompleted(providerId);
    expect(isPdf(copy.signed) && isPdf(copy.certificate)).toBe(true);
  });

  it("signs its webhooks, and verifies only its own", async () => {
    const fake = fakeESignature();
    const { providerId } = await fake.send(request);
    const hook = fake.decline(providerId, "dana@client.example");
    expect(await fake.parseWebhook(hook)).toMatchObject({ providerId, status: "declined" });

    const forged = fake.webhook(
      {
        eventId: "evt-x",
        providerId,
        status: "completed",
        signers: [],
        at: "2026-11-24T10:00:00Z",
      },
      "someone-elses-secret",
    );
    expect(await fake.parseWebhook(forged)).toBeUndefined();
    const tampered = { ...hook, body: new TextEncoder().encode('{"status":"completed"}') };
    expect(await fake.parseWebhook(tampered)).toBeUndefined();
    expect(await fake.parseWebhook({ headers: {}, body: hook.body })).toBeUndefined();
    expect(
      await fake.parseWebhook({
        headers: { [FAKE_SIGNATURE_HEADER]: ["a", "b"] },
        body: hook.body,
      }),
    ).toBeUndefined();
  });
});

describe("the checks on a provider's output", () => {
  it("refuses an unknown status, another request's id and a provider id that is not a label", () => {
    const refused = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        return error instanceof ESignError ? error.code : "other";
      }
      return "passed";
    };
    expect(
      refused(() => checkSendResult({ requestId: "r", providerId: "env-1", status: "sent" }, "r")),
    ).toBe("passed");
    expect(
      refused(() =>
        checkSendResult({ requestId: "other", providerId: "env-1", status: "sent" }, "r"),
      ),
    ).toBe("provider-output");
    expect(
      refused(() =>
        checkSendResult({ requestId: "r", providerId: "<script>", status: "sent" }, "r"),
      ),
    ).toBe("provider-output");
    expect(refused(() => checkStatusResult({ status: "signed-by-agent", signers: [] }, []))).toBe(
      "provider-output",
    );
  });

  it("keeps signers to the ones the request named, and never adds one", () => {
    const sent = ["Dana@Client.example"];
    expect(
      checkStatusResult(
        { status: "viewed", signers: [{ email: "dana@client.example", status: "viewed" }] },
        sent,
      ).signers,
    ).toEqual([{ email: "Dana@Client.example", status: "viewed" }]);
    expect(() =>
      checkStatusResult(
        { status: "viewed", signers: [{ email: "intruder@example.com", status: "signed" }] },
        sent,
      ),
    ).toThrow("a signer the request did not name");
    expect(() =>
      checkEvent(
        { eventId: "e 1", providerId: "env-1", status: "sent", at: "2026-11-24T10:00:00Z" },
        sent,
      ),
    ).toThrow("event id");
  });
});
