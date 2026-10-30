/**
 * The `/hooks/twilio` route (RASF-3162): signature, duplicate guard, opt-outs, rate ceiling, TwiML.
 *
 * Tested through the socket, because the route's contract is an HTTP one: what status, what body, what
 * content type, and — the part that matters most — what the board was and was not allowed to record.
 * Every body is a fixture; nothing here reaches Twilio, and nothing here could send even if it tried.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  EMPTY_TWIML,
  FAKE_NUMBER,
  FakeNumberProvisioner,
  rateLimitWindow,
  TWILIO_FORM_CONTENT_TYPE,
  twilioSignature,
} from "@officehum/channels";
import { afterEach, describe, expect, it } from "vitest";
import type { Board } from "./board/index.js";
import { createWorkboard } from "./board/testing.js";
import { openOfficeConfig } from "./office-config.js";
import type { ResendInbox } from "./resend-inbox.js";
import type { InboundOutcome, ResendListener, TwilioHookOptions } from "./resend-listener.js";
import { openResendListener } from "./resend-listener.js";

const directories: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** Twilio's auth-token shape, so the adapter's placeholder check is satisfied by a real-looking one. */
const TOKEN = "0123456789abcdef0123456789abcdef";
const BUSINESS = "+15005550006";
const CUSTOMER = "+15551234567";
const OTHER = "+15559999999";

function officeFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "officehum-twilio-"));
  directories.push(directory);
  return join(directory, "office.db");
}

/** The Resend half of the listener is not what this file tests; it only has to exist and be typed. */
function idleInbox(): ResendInbox {
  return {
    authority: {
      version: 1,
      messengerId: "officehum.resend.v1:test",
      accountId: "account_test",
      fromEmail: "desk@example.test",
      inboundEmail: "desk@example.test",
    },
    namespace: "test",
    accept: () => Promise.resolve({ status: 204 }),
    summaries: () => [],
    close: () => Promise.resolve(),
  };
}

/**
 * A Twilio message webhook, as the provider posts it: `application/x-www-form-urlencoded`, more fields
 * than this build reads, and `+` percent-escaped in the numbers.
 */
function form(overrides: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    AccountSid: "AC11111111111111111111111111111111",
    ApiVersion: "2010-04-01",
    Body: "The sink is leaking again",
    From: CUSTOMER,
    MessageSid: "SM11111111111111111111111111111111",
    NumSegments: "1",
    SmsSid: "SM11111111111111111111111111111111",
    SmsStatus: "received",
    To: BUSINESS,
    ...overrides,
  };
}

interface Harness {
  readonly listener: ResendListener;
  readonly board: Board;
  readonly outcomes: InboundOutcome[];
  readonly file: string;
  post(
    overrides?: Readonly<Record<string, string>>,
    options?: { signature?: string | null },
  ): Promise<Response>;
}

async function harness(
  options: {
    rateLimit?: TwilioHookOptions["rateLimit"];
    isRegistered?: TwilioHookOptions["isRegistered"];
    onInbound?: TwilioHookOptions["onInbound"];
    businessNumber?: string;
    config?: TwilioHookOptions["config"];
  } = {},
): Promise<Harness> {
  const file = officeFile();
  const board = createWorkboard(file);
  const outcomes: InboundOutcome[] = [];
  const listener = await openResendListener({
    inbox: idleInbox(),
    port: 0,
    twilio: {
      authToken: TOKEN,
      businessNumber: options.businessNumber ?? BUSINESS,
      board: board.sms,
      ...(options.config === undefined ? {} : { config: options.config }),
      onInbound: async (outcome) => {
        outcomes.push(outcome);
        await options.onInbound?.(outcome);
      },
      ...(options.isRegistered === undefined ? {} : { isRegistered: options.isRegistered }),
      ...(options.rateLimit === undefined ? {} : { rateLimit: options.rateLimit }),
    },
  });
  cleanups.push(async () => {
    await listener.close();
    board.close();
  });
  return {
    listener,
    board,
    outcomes,
    file,
    async post(overrides = {}, requestOptions = {}) {
      const params = form(overrides);
      const body = new URLSearchParams(params).toString();
      const url = `${listener.address}/hooks/twilio`;
      // Twilio signs what it sends, so the fixture computes the same digest the provider would.
      const signature =
        requestOptions.signature === null
          ? undefined
          : (requestOptions.signature ?? twilioSignature(TOKEN, url, params));
      const headers: Record<string, string> = { "content-type": TWILIO_FORM_CONTENT_TYPE };
      if (signature !== undefined) headers["x-twilio-signature"] = signature;
      return fetch(url, { method: "POST", headers, body });
    },
  };
}

/** The rows in a table, read on a second handle: what the board actually committed. */
function rows(file: string, table: "sms_inbound" | "sms_optouts" | "sms_rate"): number {
  const database = new DatabaseSync(file);
  try {
    return (database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    database.close();
  }
}

/** The counter a number has in one window, read from the table the board committed. */
function windowCount(file: string, number: string, windowStart: string): number {
  const database = new DatabaseSync(file);
  try {
    const row = database
      .prepare("SELECT count FROM sms_rate WHERE number = ? AND window_start = ?")
      .get(number, windowStart) as { count: number } | undefined;
    return row?.count ?? 0;
  } finally {
    database.close();
  }
}

describe("Twilio webhook route", () => {
  it("accepts a correctly signed message and answers with the empty TwiML", async () => {
    const { post, outcomes, file } = await harness();
    const response = await post();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/xml");
    expect(await response.text()).toBe(EMPTY_TWIML);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ disposition: "recorded" });
    expect(outcomes[0]?.message.from).toBe(CUSTOMER);
    expect(outcomes[0]?.message.to).toBe(BUSINESS);
    expect(outcomes[0]?.message.body).toBe("The sink is leaking again");
    expect(outcomes[0]?.message.messageSid).toBe("SM11111111111111111111111111111111");
    expect(rows(file, "sms_inbound")).toBe(1);
    expect(rows(file, "sms_rate")).toBe(1);
  });

  it("refuses a bad signature with 403, an empty body, and no board write at all", async () => {
    const { post, outcomes, file, board } = await harness();
    const response = await post({}, { signature: "XXskRZs9GoVMOB6FRg0JP8oVxMw=" });

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("");
    // The whole point of verifying first: a forged request leaves nothing behind, not even a counter.
    expect(rows(file, "sms_inbound")).toBe(0);
    expect(rows(file, "sms_rate")).toBe(0);
    expect(rows(file, "sms_optouts")).toBe(0);
    expect(outcomes).toEqual([]);
    expect(board.list()).toEqual([]);
  });

  it("refuses a request with no signature header the same way", async () => {
    const { post, file } = await harness();
    const response = await post({}, { signature: null });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("");
    expect(rows(file, "sms_inbound")).toBe(0);
  });

  it("accepts the same parameters in a different order, because the signature sorts them", async () => {
    const params = form();
    const reversed = Object.fromEntries(Object.entries(params).reverse());
    const { listener, board } = await harness();
    const url = `${listener.address}/hooks/twilio`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": TWILIO_FORM_CONTENT_TYPE,
        "x-twilio-signature": twilioSignature(TOKEN, url, params),
      },
      body: new URLSearchParams(reversed).toString(),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(EMPTY_TWIML);
    expect(board.sms.optOutOf(CUSTOMER)).toBeUndefined();
  });

  it("treats Twilio's retry as one message: the duplicate is acknowledged, not recorded twice", async () => {
    const { post, outcomes, file } = await harness();
    const first = await post();
    const second = await post();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.text()).toBe(EMPTY_TWIML);
    expect(outcomes.map((outcome) => outcome.disposition)).toEqual(["recorded", "duplicate"]);
    expect(rows(file, "sms_inbound")).toBe(1);
    // The retry did not spend a second slot in the rate window either.
    expect(rows(file, "sms_rate")).toBe(1);
  });

  it("refuses a verified message to a number that is not provisioned here", async () => {
    const { post, outcomes, file } = await harness();
    const response = await post({ To: "+15005550100" });

    expect(response.status).toBe(404);
    expect(await response.text()).toBe(EMPTY_TWIML);
    expect(outcomes).toEqual([]);
    expect(rows(file, "sms_inbound")).toBe(0);
  });

  it("refuses a message whose From or To is not E.164", async () => {
    const { post, file } = await harness();
    const response = await post({ From: "555-123-4567" });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(EMPTY_TWIML);
    expect(rows(file, "sms_inbound")).toBe(0);
  });

  it("records STOP and START against the number, and neither makes a ticket", async () => {
    const { post, board, outcomes } = await harness();
    const stop = await post({ Body: "stop" });
    expect(stop.status).toBe(200);
    expect(await stop.text()).toBe(EMPTY_TWIML);
    expect(board.sms.optOutOf(CUSTOMER)).toBe("stop");

    const start = await post({
      Body: " Start ",
      MessageSid: "SM22222222222222222222222222222222",
      SmsSid: "SM22222222222222222222222222222222",
    });
    expect(start.status).toBe(200);
    expect(await start.text()).toBe(EMPTY_TWIML);
    expect(board.sms.optOutOf(CUSTOMER)).toBe("start");

    expect(outcomes.map((outcome) => outcome.disposition)).toEqual(["opt_out", "opt_out"]);
    // A keyword is an instruction about the channel, not work for the office.
    expect(board.list()).toEqual([]);
  });

  it("refuses the message past the ceiling, still counts it, and never refuses a STOP", async () => {
    const window = { limit: 2, windowMs: 60 * 60 * 1000 };
    const { post, board, outcomes, file } = await harness({ rateLimit: window });

    expect((await post({ MessageSid: "SM1" })).status).toBe(200);
    expect((await post({ MessageSid: "SM2" })).status).toBe(200);
    expect((await post({ MessageSid: "SM3" })).status).toBe(200);
    expect(outcomes.map((outcome) => outcome.disposition)).toEqual([
      "recorded",
      "recorded",
      "rate_limited",
    ]);

    // The refused message is still counted, which is how a person reads how hard the number pushed.
    const bucket = rateLimitWindow(outcomes[0]?.message.receivedAt ?? "", window);
    expect(windowCount(file, CUSTOMER, bucket)).toBe(3);

    // A keyword is never refused: a stranger may always tell the office to stop.
    const stop = await post({ Body: "STOP", MessageSid: "SM4" });
    expect(stop.status).toBe(200);
    expect(board.sms.optOutOf(CUSTOMER)).toBe("stop");

    // And another number is unaffected by the first one's flood.
    expect((await post({ From: OTHER, MessageSid: "SM5" })).status).toBe(200);
    expect(outcomes.at(-1)?.disposition).toBe("recorded");
  });

  it("answers a wrong media type and a wrong method with TwiML rather than prose", async () => {
    const { listener } = await harness();
    const url = `${listener.address}/hooks/twilio`;
    const wrongType = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form()),
    });
    expect(wrongType.status).toBe(415);
    expect(wrongType.headers.get("content-type")).toBe("text/xml");
    expect(await wrongType.text()).toBe(EMPTY_TWIML);

    const wrongMethod = await fetch(url);
    expect(wrongMethod.status).toBe(405);
    expect(await wrongMethod.text()).toBe(EMPTY_TWIML);
  });

  it("keeps the Resend route's own refusals byte for byte", async () => {
    const { listener } = await harness();
    const response = await fetch(`${listener.address}/webhooks/resend`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("invalid webhook headers\n");
  });

  it("serves no Twilio route when no number is provisioned", async () => {
    const listener = await openResendListener({ inbox: idleInbox(), port: 0 });
    cleanups.push(() => listener.close());
    const response = await fetch(`${listener.address}/hooks/twilio`, {
      method: "POST",
      headers: { "content-type": TWILIO_FORM_CONTENT_TYPE },
      body: "",
    });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("not found\n");
  });

  it("exempts a number the host says is a contact's from the stranger's ceiling", async () => {
    const window = { limit: 1, windowMs: 60 * 60 * 1000 };
    const { post, outcomes, file } = await harness({
      rateLimit: window,
      isRegistered: (from) => from === CUSTOMER,
    });

    for (const sid of ["SM1", "SM2", "SM3"]) {
      expect((await post({ MessageSid: sid, SmsSid: sid })).status).toBe(200);
    }
    expect(outcomes.map((outcome) => outcome.disposition)).toEqual([
      "recorded",
      "recorded",
      "recorded",
    ]);
    // A customer's texts cost the office nothing it has to meter, so no counter row is written.
    expect(rows(file, "sms_rate")).toBe(0);

    // A stranger is still held to it, on the same route and the same window.
    expect((await post({ From: OTHER, MessageSid: "SM4" })).status).toBe(200);
    expect((await post({ From: OTHER, MessageSid: "SM5" })).status).toBe(200);
    expect(outcomes.at(-1)?.disposition).toBe("rate_limited");
  });

  it("reads the business number from the config a provisioner wrote", async () => {
    // The number a route answers to is a stored fact, not an argument: this is the path a host takes.
    expect(FAKE_NUMBER).toBe(BUSINESS);
    const directory = mkdtempSync(join(tmpdir(), "officehum-twilio-config-"));
    directories.push(directory);
    const config = openOfficeConfig(join(directory, "office.config.json"));
    await new FakeNumberProvisioner(FAKE_NUMBER, config).provision("acme-hvac");

    const board = createWorkboard(join(directory, "office.sqlite"));
    const outcomes: InboundOutcome[] = [];
    const listener = await openResendListener({
      inbox: idleInbox(),
      port: 0,
      twilio: {
        authToken: TOKEN,
        config,
        board: board.sms,
        onInbound: (outcome) => void outcomes.push(outcome),
      },
    });
    cleanups.push(async () => {
      await listener.close();
      board.close();
    });

    const params = form();
    const url = `${listener.address}/hooks/twilio`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": TWILIO_FORM_CONTENT_TYPE,
        "x-twilio-signature": twilioSignature(TOKEN, url, params),
      },
      body: new URLSearchParams(params).toString(),
    });
    expect(response.status).toBe(200);
    expect(outcomes.map((outcome) => outcome.disposition)).toEqual(["recorded"]);
  });

  it("refuses to start when nothing has been provisioned", async () => {
    const board = createWorkboard(officeFile());
    cleanups.push(() => board.close());
    const directory = mkdtempSync(join(tmpdir(), "officehum-twilio-empty-"));
    directories.push(directory);
    await expect(
      openResendListener({
        inbox: idleInbox(),
        port: 0,
        twilio: {
          authToken: TOKEN,
          config: openOfficeConfig(join(directory, "office.config.json")),
          board: board.sms,
        },
      }),
    ).rejects.toThrow(/no business number/);
  });

  it("drops the duplicate row when the hand-off fails, so the retry is a second chance", async () => {
    let failing = true;
    const { post, outcomes, file } = await harness({
      onInbound: () => {
        if (failing) throw new Error("the office is not attached");
      },
    });

    // The route recorded the message, then could not hand it on. Twilio is told so, and the row that
    // would swallow its retry as a duplicate is gone.
    expect((await post()).status).toBe(503);
    expect(rows(file, "sms_inbound")).toBe(0);

    failing = false;
    expect((await post()).status).toBe(200);
    expect(rows(file, "sms_inbound")).toBe(1);
    expect(outcomes.map((outcome) => outcome.disposition)).toEqual(["recorded", "recorded"]);
  });

  it("refuses to start with a placeholder secret or a number that is not E.164", async () => {
    const board = createWorkboard(officeFile());
    cleanups.push(() => board.close());

    await expect(
      openResendListener({
        inbox: idleInbox(),
        port: 0,
        twilio: { authToken: "test", businessNumber: BUSINESS, board: board.sms },
      }),
    ).rejects.toThrow(/32 hexadecimal/);

    await expect(
      openResendListener({
        inbox: idleInbox(),
        port: 0,
        twilio: { authToken: TOKEN, businessNumber: "555-0100", board: board.sms },
      }),
    ).rejects.toThrow(/E\.164/);
  });
});
